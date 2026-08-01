import { TFile, arrayBufferToBase64, type App, type WorkspaceLeaf } from "obsidian";
import {
	getExcalidrawApi,
	getExcalidrawView,
	type ExcalidrawEmbeddedFileLike,
} from "./excalidraw-view";
import { randomVersionNonce } from "./excalidraw-element-mutation";
import type {
	GeneratedImageAsset,
	GeneratedImageBinary,
	GeneratedImageElement,
	GeneratedImageFileMap,
	GeneratedImageTransactionAdapter,
} from "./generated-image-transaction";

export interface ObsidianGeneratedImageAsset extends GeneratedImageAsset {
	sourceFileId: string;
	size: { width: number; height: number };
}

interface ExcalidrawPluginFileRegistryLike {
	filesMaster?: { delete(fileId: string): unknown };
}

export interface ObsidianGeneratedImageAdapter extends GeneratedImageTransactionAdapter<ObsidianGeneratedImageAsset> {
	recoverSourceBinary(fileId: string, sourcePath: string | undefined, isDark: boolean): Promise<GeneratedImageBinary | null>;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	avif: "image/avif",
	bmp: "image/bmp",
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	webp: "image/webp",
};

function mimeTypeFromDataURL(dataURL: string): string {
	return /^data:([^;,]+)/i.exec(dataURL)?.[1] ?? "application/octet-stream";
}

/**
 * Adapts the Obsidian vault and a live Excalidraw canvas to the generated-image
 * transaction. Returns null until every required runtime capability is mounted.
 */
export function createObsidianGeneratedImageAdapter(
	app: App,
	leaf: WorkspaceLeaf | null,
): ObsidianGeneratedImageAdapter | null {
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return null;
	const win = view.containerEl?.ownerDocument?.defaultView ?? window;

	const removeLocalRegistration = (fileId: string) => {
		view.excalidrawData?.deleteFile?.(fileId);
	};

	return {
		readElements: () => api.getSceneElements!() as unknown as readonly GeneratedImageElement[],
		createAttachment: async (asset) => {
			await app.vault.createBinary(asset.path, asset.data);
		},
		registerGenerated: (asset) => {
			const data = view.excalidrawData;
			const plugin = view._plugin;
			if (!asset.sourceFileId || !data?.setFile || !plugin) {
				throw new Error("Excalidraw generated-image registry is unavailable");
			}
			const source = data.getFile?.(asset.sourceFileId);
			const EmbeddedFileConstructor = source && (source as unknown as {
				constructor?: new (...args: unknown[]) => unknown;
			}).constructor;
			if (!EmbeddedFileConstructor) throw new Error("Generated image has no source EmbeddedFile constructor");
			const embedded = new EmbeddedFileConstructor(plugin, view.file?.path ?? "", asset.path);
			const generated = embedded as ExcalidrawEmbeddedFileLike;
			if (!generated.file || typeof generated.setImage !== "function") {
				throw new Error("Generated EmbeddedFile did not resolve its vault attachment");
			}
			generated.setImage({
				imgBase64: asset.binary.dataURL,
				mimeType: "image/png",
				size: asset.size,
				isDark: false,
				isSVGwithBitmap: false,
				pdfPageViewProps: null,
				renderScale: 0,
			});
			data.setFile(asset.id, embedded);
		},
		stageCoreFiles: (files) => {
			if (!api.addFiles) throw new Error("Excalidraw core file registration is unavailable");
			api.addFiles(files);
			if (!api.getFiles) throw new Error("Excalidraw core file map is unavailable");
			const complete: GeneratedImageFileMap = { ...api.getFiles() };
			for (const file of files) complete[file.id] = file;
			return complete;
		},
		recoverSourceBinary: async (fileId, sourcePath, isDark) => {
			let existing: GeneratedImageFileMap[string];
			try {
				existing = api.getFiles?.()[fileId];
			} catch {
				// The persisted source path remains a usable fallback.
			}
			let dataURL = existing?.dataURL;
			let sourceFile: TFile | null = null;
			try {
				const embedded = view.excalidrawData?.getFile?.(fileId);
				dataURL ||= embedded?.getImage?.(isDark) || undefined;
				sourceFile = embedded?.file ?? null;
			} catch {
				// The persisted source path remains a usable fallback.
			}
			if (!sourceFile && sourcePath) {
				const candidate = app.vault.getAbstractFileByPath(sourcePath);
				if (candidate instanceof TFile) sourceFile = candidate;
			}
			if (!dataURL && sourceFile) {
				try {
					const mimeType = IMAGE_MIME_TYPES[sourceFile.extension.toLowerCase()] ?? "application/octet-stream";
					dataURL = `data:${mimeType};base64,${arrayBufferToBase64(await app.vault.readBinary(sourceFile))}`;
				} catch {
					return null;
				}
			}
			if (!dataURL) return null;
			return {
				id: fileId,
				dataURL,
				mimeType: existing?.mimeType ?? mimeTypeFromDataURL(dataURL),
				created: existing?.created ?? sourceFile?.stat.ctime ?? Date.now(),
			};
		},
		writeScene: (elements, files) => {
			view.updateScene!({
				elements,
				...(files ? { files } : {}),
				captureUpdate: "IMMEDIATELY",
				commitToHistory: true,
			});
		},
		rollbackRegistration: (asset) => {
			removeLocalRegistration(asset.id);
			// This id was transaction-generated and never published in a committed
			// Board, so its global master entry cannot belong to another Board.
			(view._plugin as ExcalidrawPluginFileRegistryLike | undefined)?.filesMaster?.delete(asset.id);
		},
		retireRegistration: removeLocalRegistration,
		deleteAttachment: async (path) => {
			const indexed = app.vault.getAbstractFileByPath(path);
			if (indexed) {
				await app.vault.delete(indexed);
				return;
			}
			// Compatibility cleanup for dot-prefixed attachments created by older builds.
			if (await app.vault.adapter.exists(path)) await app.vault.adapter.remove(path);
		},
		afterRendererTurn: () => new Promise<void>((resolve) => win.setTimeout(resolve, 50)),
		randomVersionNonce,
		now: Date.now,
	};
}
