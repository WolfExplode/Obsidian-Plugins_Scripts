import { Notice, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { isExcalidrawLeaf } from "./excalidraw-view";
import { localLinkpath } from "./board-render";
import { pickDirectoryForDomWindow } from "./electron";

/**
 * **Ctrl+Shift+E**: exports every selected image/video/embed to a folder the
 * user picks via the native OS dialog, so a reference set can be handed off
 * outside the vault.
 *
 * Images keep their Excalidraw crop: a plain native crop (`element.crop`) is
 * baked into a freshly rendered PNG so the exported file matches what's
 * visible on the Board, not the full original. An image with no active crop
 * — including one this plugin's viewport-crop feature already materialized
 * into its own generated PNG (see excalidraw-view.ts) — is just copied
 * byte-for-byte, since the vault file already *is* the cropped result.
 * Videos and other local embeds have no crop concept, so they're always
 * copied as-is.
 *
 * Two dedup rules keep an export from re-doing work:
 *   - A crop rect that covers the whole natural image (no flip) is a no-op —
 *     exported as a plain copy of the source file instead of a synthesized
 *     PNG, so we never manufacture pixel data when the original bytes are
 *     already the answer.
 *   - Multiple selected elements that would produce byte-identical output
 *     (same source file, same crop/flip) are exported once. The vault's own
 *     attachment is always preferred as that one copy — a duplicate that
 *     happens to be a trivial/no-op crop of a file another duplicate also
 *     references uncropped collapses onto the plain copy, not a render.
 */

interface ImageCropLike {
	x: number;
	y: number;
	width: number;
	height: number;
	naturalWidth: number;
	naturalHeight: number;
}

/** A crop within this many source pixels of the full image is treated as no crop at all. */
const FULL_CROP_EPSILON = 1;

/** Whether `crop` (with no flip) shows the entire source image — i.e. isn't really a crop. */
function isTrivialCrop(crop: ImageCropLike): boolean {
	return (
		Math.abs(crop.x) <= FULL_CROP_EPSILON &&
		Math.abs(crop.y) <= FULL_CROP_EPSILON &&
		Math.abs(crop.width - crop.naturalWidth) <= FULL_CROP_EPSILON &&
		Math.abs(crop.height - crop.naturalHeight) <= FULL_CROP_EPSILON
	);
}

interface MediaEl {
	id?: string;
	type?: string;
	fileId?: string | null;
	link?: string | null;
	crop?: ImageCropLike | null;
	scale?: readonly [number, number];
	isDeleted?: boolean;
}

interface ExportApi {
	getAppState(): { selectedElementIds?: Record<string, boolean> };
	getSceneElements(): readonly MediaEl[];
	getFiles(): Record<string, { dataURL?: string } | undefined>;
}

interface EmbeddedFileLike {
	getImage?(isDark: boolean): string;
	file?: TFile | null;
}

interface ExcalidrawDataLike {
	getFile?(fileId: string): EmbeddedFileLike | undefined;
}

interface ExcalidrawViewLike {
	file?: TFile;
	excalidrawAPI?: ExportApi;
	excalidrawData?: ExcalidrawDataLike;
	containerEl?: HTMLElement;
}

function getView(leaf: WorkspaceLeaf): ExcalidrawViewLike {
	return leaf.view as unknown as ExcalidrawViewLike;
}

function getExportApi(leaf: WorkspaceLeaf): ExportApi | null {
	const api = getView(leaf).excalidrawAPI;
	if (!api || typeof api.getSceneElements !== "function" || typeof api.getFiles !== "function") return null;
	return api;
}

/** A cropped image is rendered to a fresh PNG; everything else is a raw byte copy. */
type ExportItem =
	| { kind: "crop"; sourceFile: TFile; crop: ImageCropLike; flipX: boolean; flipY: boolean; dataURL: string }
	| { kind: "copy"; sourceFile: TFile };

function collectSelectedItems(app: App, leaf: WorkspaceLeaf): ExportItem[] {
	const api = getExportApi(leaf);
	const view = getView(leaf);
	if (!api) return [];

	let selectedIds: Record<string, boolean>;
	let elements: readonly MediaEl[];
	let files: Record<string, { dataURL?: string } | undefined>;
	try {
		selectedIds = api.getAppState().selectedElementIds ?? {};
		elements = api.getSceneElements();
		files = api.getFiles();
	} catch {
		return [];
	}

	const boardPath = view.file?.path ?? "";
	const items: ExportItem[] = [];
	const seenKeys = new Set<string>();

	const pushOnce = (key: string, item: ExportItem) => {
		if (seenKeys.has(key)) return; // an earlier selected element already exports this exact output
		seenKeys.add(key);
		items.push(item);
	};

	for (const el of elements) {
		if (!el.id || el.isDeleted || !selectedIds[el.id]) continue;

		if (el.type === "image" && el.fileId) {
			const sourceFile = view.excalidrawData?.getFile?.(el.fileId)?.file ?? null;
			if (!sourceFile) continue;
			const flipX = el.scale?.[0] === -1;
			const flipY = el.scale?.[1] === -1;
			// A crop that shows the whole source with no flip isn't really a crop —
			// collapse it onto the plain-copy path so it both dedupes against an
			// uncropped duplicate and never synthesizes pixels needlessly.
			if (el.crop && !isTrivialCrop(el.crop)) {
				const dataURL =
					files[el.fileId]?.dataURL ?? view.excalidrawData?.getFile?.(el.fileId)?.getImage?.(false);
				if (!dataURL) continue; // bytes not resident; skip rather than export a blank crop
				const c = el.crop;
				pushOnce(
					`crop:${sourceFile.path}:${c.x.toFixed(1)},${c.y.toFixed(1)},${c.width.toFixed(1)},${c.height.toFixed(1)}:${flipX}:${flipY}`,
					{ kind: "crop", sourceFile, crop: c, flipX, flipY, dataURL },
				);
			} else {
				pushOnce(`copy:${sourceFile.path}`, { kind: "copy", sourceFile });
			}
			continue;
		}

		if (el.type === "embeddable" && el.link) {
			const linkpath = localLinkpath(el.link);
			if (!linkpath) continue; // website embed, not a local file
			const dest = app.metadataCache.getFirstLinkpathDest(linkpath, boardPath);
			if (dest) pushOnce(`copy:${dest.path}`, { kind: "copy", sourceFile: dest });
		}
	}

	return items;
}

function loadImage(win: Window, dataURL: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = win.document.createElement("img");
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("Unable to decode source image for export crop"));
		img.src = dataURL;
	});
}

function canvasToArrayBuffer(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (!blob) {
				reject(new Error("Unable to encode export crop PNG"));
				return;
			}
			void blob.arrayBuffer().then(resolve, reject);
		}, "image/png");
	});
}

/** Renders just the visible crop rect (plus any flip) to a standalone PNG. */
async function renderCroppedPng(
	win: Window,
	dataURL: string,
	crop: ImageCropLike,
	flipX: boolean,
	flipY: boolean,
): Promise<ArrayBuffer> {
	const image = await loadImage(win, dataURL);
	const canvas = win.document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(crop.width));
	canvas.height = Math.max(1, Math.round(crop.height));
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Unable to create canvas context for export crop");
	ctx.save();
	if (flipX) {
		ctx.translate(canvas.width, 0);
		ctx.scale(-1, 1);
	}
	if (flipY) {
		ctx.translate(0, canvas.height);
		ctx.scale(1, -1);
	}
	ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
	ctx.restore();
	return canvasToArrayBuffer(canvas);
}

interface NodeFs {
	existsSync(path: string): boolean;
	promises: { writeFile(path: string, data: Uint8Array): Promise<void> };
}
interface NodePath {
	join(...parts: string[]): string;
	extname(path: string): string;
	basename(path: string, ext?: string): string;
}

function nodeRequire(): ((id: string) => unknown) | null {
	return (window as Window & { require?: (id: string) => unknown }).require ?? null;
}

function getNodeModules(): { fs: NodeFs; path: NodePath } | null {
	const req = nodeRequire();
	if (!req) return null;
	try {
		return { fs: req("fs") as NodeFs, path: req("path") as NodePath };
	} catch {
		return null;
	}
}

/** First unused `stem[-2][-3]...ext` path in `dir`, so repeat exports never clobber each other. */
function uniqueDestPath(fs: NodeFs, path: NodePath, dir: string, fileName: string): string {
	const ext = path.extname(fileName);
	const stem = path.basename(fileName, ext);
	let candidate = path.join(dir, fileName);
	for (let suffix = 2; fs.existsSync(candidate); suffix++) {
		candidate = path.join(dir, `${stem}-${suffix}${ext}`);
	}
	return candidate;
}

/**
 * Exports every selected image/video/embed on `leaf`'s Board to a
 * user-chosen folder. Shows a Notice with the result; a no-op selection or a
 * cancelled dialog are silently ignored (aside from the "nothing selected"
 * notice) rather than treated as errors.
 */
export async function exportSelectedMedia(app: App, leaf: WorkspaceLeaf): Promise<void> {
	if (!isExcalidrawLeaf(leaf)) return;
	const items = collectSelectedItems(app, leaf);
	if (items.length === 0) {
		new Notice("No image, video, or embed is selected to export.");
		return;
	}

	const win = getView(leaf).containerEl?.ownerDocument?.defaultView ?? window;
	const dir = await pickDirectoryForDomWindow(win, "Export selected media");
	if (!dir) return; // cancelled

	const nodeModules = getNodeModules();
	if (!nodeModules) {
		new Notice("Could not reach the filesystem to export media.");
		return;
	}
	const { fs, path } = nodeModules;

	let exported = 0;
	let failed = 0;
	for (const item of items) {
		try {
			if (item.kind === "copy") {
				const data = await app.vault.readBinary(item.sourceFile);
				const dest = uniqueDestPath(fs, path, dir, item.sourceFile.name);
				await fs.promises.writeFile(dest, new Uint8Array(data));
			} else {
				const data = await renderCroppedPng(win, item.dataURL, item.crop, item.flipX, item.flipY);
				const dest = uniqueDestPath(fs, path, dir, `${item.sourceFile.basename}.png`);
				await fs.promises.writeFile(dest, new Uint8Array(data));
			}
			exported++;
		} catch (error) {
			failed++;
			console.error("[Excalidraw PureRef] failed to export media item:", error);
		}
	}

	new Notice(
		failed === 0
			? `Exported ${exported} file${exported === 1 ? "" : "s"} to ${dir}`
			: `Exported ${exported} file${exported === 1 ? "" : "s"} to ${dir} (${failed} failed — see console)`,
	);
}
