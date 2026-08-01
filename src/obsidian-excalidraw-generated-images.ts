import type { App, WorkspaceLeaf } from "obsidian";
import {
	getExcalidrawApi,
	getExcalidrawView,
	randomVersionNonce,
	type ExcalidrawEmbeddedFileLike,
} from "./excalidraw-view";
import type {
	GeneratedImageAsset,
	GeneratedImageElement,
	GeneratedImageTransactionAdapter,
} from "./generated-image-transaction";

export interface ObsidianGeneratedImageAsset extends GeneratedImageAsset {
	sourceFileId: string;
	size: { width: number; height: number };
}

interface ExcalidrawPluginFileRegistryLike {
	filesMaster?: { delete(fileId: string): unknown };
}

/**
 * Adapts the Obsidian vault and a live Excalidraw canvas to the generated-image
 * transaction. Returns null until every required runtime capability is mounted.
 */
export function createObsidianGeneratedImageAdapter(
	app: App,
	leaf: WorkspaceLeaf | null,
): GeneratedImageTransactionAdapter<ObsidianGeneratedImageAsset> | null {
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
		addCoreFiles: (files) => {
			if (!api.addFiles) throw new Error("Excalidraw core file registration is unavailable");
			api.addFiles(files);
		},
		readCoreFiles: () => {
			if (!api.getFiles) throw new Error("Excalidraw core file map is unavailable");
			return api.getFiles();
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
