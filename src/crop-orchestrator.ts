import type { App, WorkspaceLeaf } from "obsidian";
import {
	MIN_CROP_SCENE,
	applyAffine,
	elementLocalToScene,
	filePixelsToCurrentLocal,
	intersectConvexPolygons,
	localPolygonForSceneRect,
	multiplyAffine,
	planImageCrop,
	pointInsideConvexPolygon,
	polygonBounds,
	rotateVector,
	viewportCropToCurrentLocal,
	type AffineTransform,
	type CropPoint,
	type ImageCrop,
	type SceneRect,
} from "./crop-geometry";
import {
	type ImageSceneElement,
	type SceneElement,
	getExcalidrawApi,
	getExcalidrawData,
	getExcalidrawFileForLeaf,
	getExcalidrawView,
	isImageElement,
	makeNaturalSizeResolver,
} from "./excalidraw-view";
import {
	applyGeneratedImageTransaction,
	type GeneratedImageBinary,
	type GeneratedImageChange,
	type GeneratedImageRef,
} from "./generated-image-transaction";
import {
	createObsidianGeneratedImageAdapter,
	type ObsidianGeneratedImageAdapter,
	type ObsidianGeneratedImageAsset,
} from "./obsidian-excalidraw-generated-images";

/** Persisted state for the PureRef-style crop layer. */
interface ViewportCropState {
	version: 1;
	sourceFileId: string;
	sourcePath?: string;
	sourceNaturalWidth: number;
	sourceNaturalHeight: number;
	/** The Excalidraw crop that existed before the custom layer was created. */
	baseCrop: ImageCrop | null;
	/** Source natural pixels → the current generated image's local pixels. */
	sourceToLocal: AffineTransform;
	/** The visible polygon in the current generated image's local pixels. */
	polygon: CropPoint[];
	/** Vault path of the generated PNG used by the current image element. */
	generatedPath: string;
}

/**
 * customData key for the PureRef-style crop layer. Exported so callers that
 * only need to recognize/read a custom crop (e.g. duplicate-finder.ts, to
 * trace a materialized crop back to its source file) don't need their own
 * copy of this string.
 */
export const VIEWPORT_CROP_KEY = "excalidrawPureRefViewportCrop";

function getViewportCropState(el: ImageSceneElement): ViewportCropState | null {
	const value = el.customData?.[VIEWPORT_CROP_KEY];
	if (!value || typeof value !== "object") return null;
	const state = value as Partial<ViewportCropState>;
	if (state.version !== 1 || typeof state.sourceFileId !== "string" || !Array.isArray(state.polygon)) return null;
	if (!state.sourceToLocal || typeof state.sourceToLocal.a !== "number") return null;
	return state as ViewportCropState;
}

function sourceContainsExcalidrawDarkFilter(dataURL: string): boolean {
	if (!/^data:image\/svg\+xml/i.test(dataURL)) return false;
	try {
		const comma = dataURL.indexOf(",");
		if (comma < 0) return false;
		const payload = dataURL.slice(comma + 1);
		const svg = /;base64/i.test(dataURL) ? atob(payload) : decodeURIComponent(payload);
		return svg.includes("invert(100%)") && svg.includes("hue-rotate(180deg)");
	} catch {
		return false;
	}
}

function nextViewportFileId(): string {
	// Obsidian Excalidraw serializes embedded-file IDs with /[\w\d]*/. Hyphens
	// silently prevent the entry from being parsed back after the background
	// save, leaving the element alive while its core binary disappears.
	return `eprviewport${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function nextViewportPath(app: App, leaf: WorkspaceLeaf | null, elementId: string, fileId: string, sourcePath?: string): string {
	// Keep the disposable crop beside its source. Falling back to the drawing is
	// only for non-vault/legacy images whose source path cannot be recovered.
	const sourceSlash = sourcePath?.lastIndexOf("/") ?? -1;
	const folder = sourcePath !== undefined
		? (sourceSlash >= 0 ? sourcePath.slice(0, sourceSlash) : "")
		: (getExcalidrawFileForLeaf(leaf)?.parent?.path ?? "");
	// Do not dot-prefix this attachment. Obsidian excludes dotfiles from the
	// vault index, which makes a successfully written PNG invisible to both the
	// Files view and Excalidraw's path resolver.
	// The transaction-unique fileId makes this path transaction-owned even when
	// two crops of the same element plan concurrently before either writes.
	const stem = `epr-viewport-${elementId}-${fileId}`;
	let path = folder ? `${folder}/${stem}.png` : `${stem}.png`;
	let suffix = 1;
	while (app.vault.getAbstractFileByPath(path)) {
		path = folder ? `${folder}/${stem}-${suffix}.png` : `${stem}-${suffix}.png`;
		suffix++;
	}
	return path;
}

function getSourcePath(leaf: WorkspaceLeaf | null, fileId: string): string | undefined {
	try {
		return getExcalidrawData(leaf)?.getFile?.(fileId)?.file?.path;
	} catch {
		return undefined;
	}
}

function loadCanvasImage(dataURL: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = window.document.createElement("img");
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("Unable to decode source image for viewport crop"));
		image.src = dataURL;
	});
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Unable to encode viewport crop PNG"))), "image/png");
	});
}

async function renderViewportPng(
	dataURL: string,
	sourceWidth: number,
	sourceHeight: number,
	outputWidth: number,
	outputHeight: number,
	polygon: readonly CropPoint[],
	sourceToLocal: AffineTransform,
	sourceIsDarkThemed: boolean,
): Promise<{ dataURL: string; data: ArrayBuffer; width: number; height: number }> {
	const image = await loadCanvasImage(dataURL);
	const sourceScaleX = Math.hypot(sourceToLocal.a, sourceToLocal.b);
	const sourceScaleY = Math.hypot(sourceToLocal.c, sourceToLocal.d);
	const pixelDensity = Math.max(1, Math.min(4, 1 / Math.max(1e-6, Math.min(sourceScaleX, sourceScaleY))));
	const canvas = window.document.createElement("canvas");
	canvas.width = Math.max(1, Math.ceil(outputWidth * pixelDensity));
	canvas.height = Math.max(1, Math.ceil(outputHeight * pixelDensity));
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Unable to create canvas context for viewport crop");

	context.save();
	context.scale(pixelDensity, pixelDensity);
	context.beginPath();
	polygon.forEach((point, index) => {
		if (index === 0) context.moveTo(point.x, point.y);
		else context.lineTo(point.x, point.y);
	});
	context.closePath();
	context.clip();
	if (sourceIsDarkThemed && sourceContainsExcalidrawDarkFilter(dataURL)) {
		context.filter = "saturate(0.8) hue-rotate(-180deg) invert(100%)";
	}
	context.setTransform(
		pixelDensity * sourceToLocal.a,
		pixelDensity * sourceToLocal.b,
		pixelDensity * sourceToLocal.c,
		pixelDensity * sourceToLocal.d,
		pixelDensity * sourceToLocal.e,
		pixelDensity * sourceToLocal.f,
	);
	context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
	context.restore();

	const blob = await canvasToBlob(canvas);
	const data = await blob.arrayBuffer();
	return { dataURL: canvas.toDataURL("image/png"), data, width: canvas.width, height: canvas.height };
}

interface ViewportCropPlan {
	element: ImageSceneElement;
	fileId: string;
	fileDataURL: string;
	fileData: ArrayBuffer;
	fileWidth: number;
	fileHeight: number;
	generatedPath: string;
	previousGeneratedPath?: string;
}

async function planViewportCrop(
	app: App,
	leaf: WorkspaceLeaf | null,
	generatedImages: ObsidianGeneratedImageAdapter,
	el: ImageSceneElement,
	rect: SceneRect,
	sourceNatural: { w: number; h: number },
	generatedNatural: { w: number; h: number },
	sourceIsDarkThemed: boolean,
): Promise<ViewportCropPlan | null> {
	const existing = getViewportCropState(el);
	const sourceFileId = existing?.sourceFileId ?? el.fileId;
	if (!sourceFileId) return null;
	const sourceBinary = await generatedImages.recoverSourceBinary(
		sourceFileId,
		existing?.sourcePath ?? getSourcePath(leaf, sourceFileId),
		sourceIsDarkThemed,
	);
	if (!sourceBinary) return null;
	const sourceDataURL = sourceBinary.dataURL;
	const viewportToCurrent = existing
		? viewportCropToCurrentLocal(el, existing, generatedNatural)
		: null;
	if (existing && !viewportToCurrent) return null;
	const currentPolygon = (existing
		? existing.polygon.map((point) => applyAffine(viewportToCurrent!, point))
		: [
		{ x: 0, y: 0 },
		{ x: el.width, y: 0 },
		{ x: el.width, y: el.height },
		{ x: 0, y: el.height },
	]);
	const localRect = localPolygonForSceneRect(el, rect);
	if (!localRect) return null;
	// A crop rectangle that contains the entire current visible polygon is a
	// genuine no-op. Do not regenerate the SVG or tighten its bounds: doing so
	// changes the element's collision box and can introduce another transform
	// round-trip even though the user did not remove any pixels.
	if (currentPolygon.every((point) => pointInsideConvexPolygon(point, localRect))) return null;
	const localPolygon = intersectConvexPolygons(currentPolygon, localRect);
	if (localPolygon.length < 3) return null;
	const toScene = elementLocalToScene(el);
	const scenePolygon = localPolygon.map((p) => applyAffine(toScene, p));
	const bounds = polygonBounds(scenePolygon);
	if (!bounds || bounds.width < MIN_CROP_SCENE || bounds.height < MIN_CROP_SCENE) return null;
	const sceneToOutput: AffineTransform = { a: 1, b: 0, c: 0, d: 1, e: -bounds.x, f: -bounds.y };
	const nextPolygon = scenePolygon.map((p) => applyAffine(sceneToOutput, p));
	const currentSourceToLocal = existing
		? multiplyAffine(viewportToCurrent!, existing.sourceToLocal)
		: filePixelsToCurrentLocal(el, sourceNatural);
	const sourceToOutput = multiplyAffine(sceneToOutput, multiplyAffine(toScene, currentSourceToLocal));
	const baseCrop = existing?.baseCrop ?? el.crop ?? null;
	const sourcePath = existing?.sourcePath ?? getSourcePath(leaf, sourceFileId);
	const fileId = nextViewportFileId();
	const generatedPath = nextViewportPath(app, leaf, el.id, fileId, sourcePath);
	const state: ViewportCropState = {
		version: 1,
		sourceFileId,
		sourcePath,
		sourceNaturalWidth: existing?.sourceNaturalWidth ?? sourceNatural.w,
		sourceNaturalHeight: existing?.sourceNaturalHeight ?? sourceNatural.h,
		baseCrop,
		sourceToLocal: sourceToOutput,
		polygon: nextPolygon,
		generatedPath,
	};
	const png = await renderViewportPng(
		sourceDataURL,
		existing?.sourceNaturalWidth ?? sourceNatural.w,
		existing?.sourceNaturalHeight ?? sourceNatural.h,
		bounds.width,
		bounds.height,
		nextPolygon,
		sourceToOutput,
		sourceIsDarkThemed,
	);
	return {
		fileId,
		fileDataURL: png.dataURL,
		fileData: png.data,
		fileWidth: png.width,
		fileHeight: png.height,
		generatedPath,
		previousGeneratedPath: existing?.generatedPath,
		 element: {
			...el,
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			angle: 0,
			crop: null,
			fileId,
			// The source transform above already includes the original image's
			// flip. The generated PNG itself is in normal canvas orientation.
			scale: [1, 1],
			customData: { ...(el.customData ?? {}), [VIEWPORT_CROP_KEY]: state },
		},
	};
}

/** Returns selected or all images that currently have the custom crop layer. */
export function getViewportCropImageIds(leaf: WorkspaceLeaf | null, selectedOnly: boolean): string[] {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements) return [];
	try {
		const selected = api.getAppState().selectedElementIds ?? {};
		return api
			.getSceneElements()
			.filter((el): el is ImageSceneElement => isImageElement(el) && (!selectedOnly || selected[el.id]) && !!getViewportCropState(el))
			.map((el) => el.id);
	} catch {
		return [];
	}
}

/**
 * Returns selected or all images carrying a *native* Excalidraw crop that this
 * plugin can restore in place — the targets for Alt+double-click.
 *
 * Deliberately narrower than "has a crop". Images with the custom viewport-crop
 * layer are excluded because Alt+double-click handles them first, and
 * uncropImages would take its viewport branch and peel off the custom layer
 * instead of the native crop. Rotated images are
 * included — uncropImages rotates the restore offset into scene space via
 * elementLocalToScene, so the axis-aligned math holds at any angle.
 */
export function getNativeCropImageIds(leaf: WorkspaceLeaf | null, selectedOnly: boolean): string[] {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements) return [];
	try {
		const selected = api.getAppState().selectedElementIds ?? {};
		return api
			.getSceneElements()
			.filter(
				(el): el is ImageSceneElement =>
					isImageElement(el) &&
					(!selectedOnly || !!selected[el.id]) &&
					!!el.crop &&
					!getViewportCropState(el),
			)
			.map((el) => el.id);
	} catch {
		return [];
	}
}

/** Outcome of a crop request, for debugging and caller feedback. */
export interface CropResult {
	cropped: string[];
	/** Ids skipped: missed by the rect, degenerate, or size-unknown. */
	skipped: string[];
}

/**
 * The reusable crop primitive: crop every target image so its visible region is
 * the part of it inside `rect` (scene coords). Targets `ids` when given, else the
 * current image selection. Upright and flipped images use Excalidraw's native
 * crop; rotated images use one composed polygon-clipped PNG image saved in the
 * vault. Writes all changes as one undoable step. Async because
 * uncropped images must decode to learn their true natural size (cropped images
 * already carry it in `crop.naturalWidth/Height`).
 */
export async function cropImagesToSceneRect(
	app: App,
	leaf: WorkspaceLeaf | null,
	rect: SceneRect,
	ids?: readonly string[],
): Promise<CropResult> {
	const result: CropResult = { cropped: [], skipped: [] };
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return result;

	let all: readonly SceneElement[];
	let files: Record<string, { dataURL?: string } | undefined>;
	let selectedIds: Record<string, boolean>;
	try {
		all = api.getSceneElements();
		files = api.getFiles?.() ?? {};
		selectedIds = api.getAppState().selectedElementIds ?? {};
	} catch {
		return result;
	}

	const idSet = ids ? new Set(ids) : null;
	const targets = all.filter(
		(el): el is ImageSceneElement => isImageElement(el) && (idSet ? idSet.has(el.id) : !!selectedIds[el.id]),
	);
	if (targets.length === 0) return result;

	const win = view.containerEl?.ownerDocument?.defaultView ?? window;
	const sourceIsDarkThemed = win.document.body.classList.contains("theme-dark");
	const naturalSizeOf = makeNaturalSizeResolver(win, files);
	const transactionAdapter = createObsidianGeneratedImageAdapter(app, leaf);
	if (!transactionAdapter) return result;

	// Resolve each target's natural size (cropped: free; uncropped: decode), then plan.
	const plans = new Map<string, { x: number; y: number; width: number; height: number; angle?: number; crop: ImageCrop | null; fileId?: string; customData?: Record<string, unknown> }>();
	const generatedFiles: ObsidianGeneratedImageAsset[] = [];
	const generatedFilesToDelete: GeneratedImageRef[] = [];
	const initialElements = new Map(targets.map((el) => [el.id, {
		version: el.version,
		versionNonce: el.versionNonce,
	}]));
	await Promise.all(
		targets.map(async (el) => {
			const viewport = getViewportCropState(el);
			// `sourceNatural` is the original image retained by a viewport crop;
			// `elementNatural` is the PNG currently attached to the element. They
			// diverge once a custom crop has been materialized, and the latter is
			// required to compose any native Excalidraw crop made in between two
			// custom crops.
			const elementNatural = el.crop
				? { w: el.crop.naturalWidth, h: el.crop.naturalHeight }
				: el.fileId
					? await naturalSizeOf(el.fileId)
					: null;
			if (!elementNatural) {
				result.skipped.push(el.id);
				return;
			}
			const sourceNatural = viewport
				? { w: viewport.sourceNaturalWidth, h: viewport.sourceNaturalHeight }
				: elementNatural;
			const viewportPlan = (el.angle && Math.abs(el.angle) > 1e-6) || getViewportCropState(el)
				? await planViewportCrop(app, leaf, transactionAdapter, el, rect, sourceNatural, elementNatural, sourceIsDarkThemed)
				: null;
			if (viewportPlan) {
				plans.set(el.id, {
					x: viewportPlan.element.x,
					y: viewportPlan.element.y,
					width: viewportPlan.element.width,
					height: viewportPlan.element.height,
					angle: 0,
					crop: null,
					fileId: viewportPlan.fileId,
					customData: viewportPlan.element.customData,
				});
				generatedFiles.push({
					id: viewportPlan.fileId,
					sourceFileId: getViewportCropState(viewportPlan.element)?.sourceFileId ?? el.fileId ?? "",
					data: viewportPlan.fileData,
					path: viewportPlan.generatedPath,
					binary: {
						id: viewportPlan.fileId,
						dataURL: viewportPlan.fileDataURL,
						mimeType: "image/png",
						created: Date.now(),
					},
					size: { width: viewportPlan.fileWidth, height: viewportPlan.fileHeight },
				});
				if (viewportPlan.previousGeneratedPath) {
					if (getViewportCropState(el)?.sourceFileId && el.fileId) {
						generatedFilesToDelete.push({ fileId: el.fileId, path: viewportPlan.previousGeneratedPath });
					}
				}
				return;
			}
			const plan = planImageCrop(el, rect, elementNatural);
			if (!plan) {
				result.skipped.push(el.id);
				return;
			}
			plans.set(el.id, plan);
		}),
	);
	if (plans.size === 0) return result;
	const changes: GeneratedImageChange[] = [...plans].map(([id, patch]) => ({
		id,
		expected: initialElements.get(id)!,
		patch,
	}));
	const transaction = await applyGeneratedImageTransaction(transactionAdapter, {
		changes,
		created: generatedFiles,
		retire: generatedFilesToDelete,
	});
	if (transaction.status !== "applied") {
		if (transaction.status === "indeterminate") {
			console.warn("Generated-image crop commit is indeterminate; retained its artifacts", transaction.error);
		} else if (transaction.status === "failed") {
			console.error(`Generated-image crop failed during ${transaction.stage}`, transaction.error, transaction.rollbackErrors);
		}
		return { cropped: [], skipped: targets.map((target) => target.id) };
	}
	result.cropped.push(...transaction.changedIds);
	if (transaction.cleanupPending.length || transaction.cleanupErrors.length) {
		console.warn("Generated-image crop committed with deferred cleanup", transaction.cleanupPending, transaction.cleanupErrors);
	}
	return result;
}

/**
 * Clears the `crop` on target images, restoring each to its full original at the
 * right on-canvas position/size — the inverse of cropImagesToSceneRect and the
 * programmatic equivalent of Excalidraw's double-click uncrop. For custom
 * viewport-cropped images this removes only the custom layer and restores the
 * underlying native-cropped image; ordinary images are restored as before.
 * Natural size comes from persisted crop state. A custom crop may still need to
 * recover its original bytes from the vault after the Board has been reopened.
 */
export async function uncropImages(app: App, leaf: WorkspaceLeaf | null, ids?: readonly string[]): Promise<string[]> {
	const api = getExcalidrawApi(leaf);
	const transactionAdapter = createObsidianGeneratedImageAdapter(app, leaf);
	if (!api?.getSceneElements || !transactionAdapter) return [];

	let all: readonly SceneElement[];
	let selectedIds: Record<string, boolean>;
	try {
		all = api.getSceneElements();
		selectedIds = api.getAppState().selectedElementIds ?? {};
	} catch {
		return [];
	}

	const idSet = ids ? new Set(ids) : null;
	const changes: GeneratedImageChange[] = [];
	const generatedFilesToDelete: GeneratedImageRef[] = [];
	const requiredCoreFiles = new Map<string, GeneratedImageBinary>();
	const sourceIsDarkThemed = api.getAppState().theme === "dark";
	for (const raw of all) {
		if (!isImageElement(raw)) continue;
		const el = raw;
		const target = idSet ? idSet.has(el.id) : !!selectedIds[el.id];
		const viewport = getViewportCropState(el);
		if (target && viewport) {
			const sourceBinary = await transactionAdapter.recoverSourceBinary(
				viewport.sourceFileId,
				viewport.sourcePath,
				sourceIsDarkThemed,
			);
			// Never replace a working generated image with an unresolved source ID.
			if (!sourceBinary) continue;
			const crop = viewport.baseCrop;
			const nw = viewport.sourceNaturalWidth;
			const nh = viewport.sourceNaturalHeight;
			const sourceCrop = crop ?? { x: 0, y: 0, width: nw, height: nh };
			// The generated viewport PNG may itself have been natively cropped before
			// this double-click. Fold that generated-PNG crop back into the original
			// source transform, otherwise the restored element is offset by the crop
			// origin (and becomes increasingly wrong after repeated operations).
			const generatedNatural = el.crop
				? { w: el.crop.naturalWidth, h: el.crop.naturalHeight }
				: (() => {
					const bounds = polygonBounds(viewport.polygon);
					return bounds ? { w: bounds.width, h: bounds.height } : null;
				})();
			if (!generatedNatural) continue;
			const viewportToCurrent = viewportCropToCurrentLocal(el, viewport, generatedNatural);
			if (!viewportToCurrent) continue;
			const sourceToScene = multiplyAffine(
				elementLocalToScene(el),
				multiplyAffine(viewportToCurrent, viewport.sourceToLocal),
			);
			const p0 = applyAffine(sourceToScene, { x: sourceCrop.x, y: sourceCrop.y });
			const p1 = applyAffine(sourceToScene, { x: sourceCrop.x + sourceCrop.width, y: sourceCrop.y });
			const p2 = applyAffine(sourceToScene, { x: sourceCrop.x, y: sourceCrop.y + sourceCrop.height });
			const width = Math.hypot(p1.x - p0.x, p1.y - p0.y);
			const height = Math.hypot(p2.x - p0.x, p2.y - p0.y);
			if (width <= 0 || height <= 0) continue;
			const orientation = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
			const center = {
				x: (p0.x + p1.x + p2.x + (p1.x + p2.x - p0.x)) / 4,
				y: (p0.y + p1.y + p2.y + (p1.y + p2.y - p0.y)) / 4,
			};
			const customData = { ...(el.customData ?? {}) };
			delete customData[VIEWPORT_CROP_KEY];
			changes.push({
				id: el.id,
				expected: { version: el.version, versionNonce: el.versionNonce },
				patch: {
					fileId: viewport.sourceFileId,
					x: center.x - width / 2,
					y: center.y - height / 2,
					width,
					height,
					angle: Math.atan2(p1.y - p0.y, p1.x - p0.x),
					crop: crop ?? null,
					// The affine transform above contains any original or subsequently
					// applied mirror. Encode its handedness exactly once in the restored
					// element; retaining the generated PNG's scale would mirror it twice.
					scale: [1, orientation < 0 ? -1 : 1],
					customData: Object.keys(customData).length ? customData : undefined,
				},
			});
			requiredCoreFiles.set(viewport.sourceFileId, sourceBinary);
			if (viewport.generatedPath && el.fileId) {
				generatedFilesToDelete.push({ fileId: el.fileId, path: viewport.generatedPath });
			}
			continue;
		}
		if (!target || !el.crop) continue;

		const crop = el.crop;
		const flipX = el.scale?.[0] === -1;
		const flipY = el.scale?.[1] === -1;
		const uncroppedW = el.width / (crop.width / crop.naturalWidth);
		const uncroppedH = el.height / (crop.height / crop.naturalHeight);
		const visualCropX = flipX ? crop.naturalWidth - crop.width - crop.x : crop.x;
		const visualCropY = flipY ? crop.naturalHeight - crop.height - crop.y : crop.y;
		const offsetX = (visualCropX / crop.naturalWidth) * uncroppedW;
		const offsetY = (visualCropY / crop.naturalHeight) * uncroppedH;

		// Crop/flip happen in the element's local (pre-rotation) frame, so at
		// angle 0 the restored corner is a plain subtraction. Once rotated, the
		// local offset from the full box's corner to the visible box's corner
		// must be rotated into scene space before it can be applied — otherwise
		// growing the box shifts the visible content off its on-screen spot.
		// `elementLocalToScene` already encodes the current box's rotation about
		// its own centre; reuse its linear part to rotate the offset, then place
		// the new (larger) box's centre so the crop sub-rect lands exactly where
		// the visible box is now, and derive its corner the same way Excalidraw
		// always does — centre minus half the (new) unrotated size.
		let x: number;
		let y: number;
		if (Math.abs(el.angle ?? 0) > 1e-6) {
			const local = elementLocalToScene(el);
			const halfNew = rotateVector(local, { x: uncroppedW / 2, y: uncroppedH / 2 });
			const offsetRot = rotateVector(local, { x: offsetX, y: offsetY });
			const centerNew = { x: local.e + halfNew.x - offsetRot.x, y: local.f + halfNew.y - offsetRot.y };
			x = centerNew.x - uncroppedW / 2;
			y = centerNew.y - uncroppedH / 2;
		} else {
			x = el.x - offsetX;
			y = el.y - offsetY;
		}

		changes.push({
			id: el.id,
			expected: { version: el.version, versionNonce: el.versionNonce },
			patch: { x, y, width: uncroppedW, height: uncroppedH, crop: null },
		});
	}
	if (changes.length === 0) return [];

	const transaction = await applyGeneratedImageTransaction(transactionAdapter, {
		changes,
		created: [],
		requiredCoreFiles: [...requiredCoreFiles.values()],
		retire: generatedFilesToDelete,
	});
	if (transaction.status !== "applied") {
		if (transaction.status === "indeterminate") {
			console.warn("Generated-image uncrop commit is indeterminate; retained its artifacts", transaction.error);
		} else if (transaction.status === "failed") {
			console.error(`Generated-image uncrop failed during ${transaction.stage}`, transaction.error, transaction.rollbackErrors);
		}
		return [];
	}
	if (transaction.cleanupPending.length || transaction.cleanupErrors.length) {
		console.warn("Generated-image uncrop committed with deferred cleanup", transaction.cleanupPending, transaction.cleanupErrors);
	}
	return transaction.changedIds;
}
