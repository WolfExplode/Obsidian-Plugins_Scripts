import type { App, WorkspaceLeaf } from "obsidian";
import { applySelectionTransform, findExcalidrawLeafForNode, type TransformElement } from "./excalidraw-view";

export type ImageNormalizeMode = "height" | "width" | "size" | "scale";

interface ImageElement {
	id: string;
	type: string;
	isDeleted?: boolean;
	x: number;
	y: number;
	width: number;
	height: number;
	angle?: number;
	fileId?: string;
	crop?: { width: number; height: number } | null;
}

interface ImageApi {
	getAppState(): { selectedElementIds?: Record<string, boolean> };
	getSceneElements(): readonly ImageElement[];
	getFiles(): Record<string, { dataURL?: string } | undefined>;
}

interface ImageView {
	containerEl?: HTMLElement;
	excalidrawAPI?: ImageApi;
}

function average(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Whether the leaf's current selection has enough eligible elements (image or
 * embeddable, the loosest of the four modes' requirements) for at least one
 * Normalize mode to apply. Used to decide whether to show the context-menu
 * entry at all — Normalize is a no-op below two elements.
 */
function hasNormalizableSelection(leaf: WorkspaceLeaf | null): boolean {
	const view = leaf?.view as unknown as ImageView | undefined;
	const api = view?.excalidrawAPI;
	if (!api) return false;
	try {
		const selected = api.getAppState().selectedElementIds ?? {};
		let count = 0;
		for (const element of api.getSceneElements()) {
			if ((element.type === "image" || element.type === "embeddable") && !element.isDeleted && selected[element.id] && element.width > 0 && element.height > 0) {
				if (++count >= 2) return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Matches selected images to the selection's average height, width, displayed
 * area, or native-image scale. Every resize is centred on the original image.
 */
export async function normalizeSelectedImages(leaf: WorkspaceLeaf | null, mode: ImageNormalizeMode): Promise<boolean> {
	const view = leaf?.view as unknown as ImageView | undefined;
	const api = view?.excalidrawAPI;
	if (!api) return false;
	let images: ImageElement[];
	try {
		const selected = api.getAppState().selectedElementIds ?? {};
		// "scale" resets to native image pixel scale, which only applies to images with a fileId.
		const isNormalizableType = mode === "scale" ? (type: string) => type === "image" : (type: string) => type === "image" || type === "embeddable";
		images = api.getSceneElements().filter((element) =>
			isNormalizableType(element.type) && !element.isDeleted && !!selected[element.id] && element.width > 0 && element.height > 0,
		);
	} catch {
		return false;
	}
	if (images.length < 2) return false;

	let factors: number[];
	if (mode === "height") factors = images.map((image) => average(images.map((item) => item.height)) / image.height);
	else if (mode === "width") factors = images.map((image) => average(images.map((item) => item.width)) / image.width);
	else if (mode === "size") {
		const targetArea = average(images.map((image) => image.width * image.height));
		factors = images.map((image) => Math.sqrt(targetArea / (image.width * image.height)));
	} else {
		let files: Record<string, { dataURL?: string } | undefined>;
		try { files = api.getFiles(); } catch { return false; }
		const win = view.containerEl?.ownerDocument?.defaultView ?? window;
		const naturalSizes = await Promise.all(images.map(async (image) => {
			if (image.crop) return { width: image.crop.width, height: image.crop.height };
			const dataURL = image.fileId ? files[image.fileId]?.dataURL : undefined;
			if (!dataURL) return null;
			return new Promise<{ width: number; height: number } | null>((resolve) => {
				const decoded = win.document.createElement("img");
				decoded.onload = () => resolve(decoded.naturalWidth > 0 ? { width: decoded.naturalWidth, height: decoded.naturalHeight } : null);
				decoded.onerror = () => resolve(null);
				decoded.src = dataURL;
			});
		}));
		if (naturalSizes.some((size) => !size)) return false;
		const scales = images.map((image, index) => image.width / naturalSizes[index]!.width);
		const targetScale = average(scales);
		factors = scales.map((scale) => targetScale / scale);
	}

	const transforms: TransformElement[] = images.map((image, index) => {
		const factor = factors[index];
		const width = image.width * factor;
		const height = image.height * factor;
		return { id: image.id, x: image.x + (image.width - width) / 2, y: image.y + (image.height - height) / 2, width, height, angle: image.angle ?? 0 };
	});
	return applySelectionTransform(leaf, transforms, "IMMEDIATELY");
}

const MENU_ITEMS: Array<[ImageNormalizeMode, string, string]> = [
	["height", "Height", "Ctrl+Alt+Left"],
	["width", "Width", "Ctrl+Alt+Right"],
	["size", "Size", "Ctrl+Alt+Up"],
	["scale", "Scale", "Ctrl+Alt+Down"],
];

/**
 * Adds PureRef's Normalize submenu to Excalidraw's native canvas context menu.
 *
 * The submenu is appended to `document.body` (not nested inside the Normalize
 * `<li>`) and positioned with `position: fixed`, because Excalidraw's
 * `.context-menu-popover` wrapper has `overflow: auto` — an absolutely
 * positioned child extending past its bounds gets silently clipped.
 */
export function attachImageNormalize(win: Window, app: App): () => void {
	let submenu: HTMLUListElement | null = null;
	let hideTimeout: number | null = null;

	const removeSubmenu = () => {
		if (hideTimeout !== null) { win.clearTimeout(hideTimeout); hideTimeout = null; }
		submenu?.remove();
		submenu = null;
	};
	const cancelHide = () => { if (hideTimeout !== null) { win.clearTimeout(hideTimeout); hideTimeout = null; } };
	const scheduleHide = () => { cancelHide(); hideTimeout = win.setTimeout(removeSubmenu, 200); };

	const showSubmenu = (item: HTMLLIElement, leaf: WorkspaceLeaf, menu: Element) => {
		removeSubmenu();
		const rect = item.getBoundingClientRect();
		const built = win.document.createElement("ul");
		built.className = "epr-normalize-submenu is-open context-menu";
		built.style.left = `${rect.right - 4}px`;
		built.style.top = `${rect.top}px`;
		for (const [mode, label, shortcut] of MENU_ITEMS) {
			const child = win.document.createElement("li");
			const childButton = win.document.createElement("button");
			childButton.type = "button";
			childButton.className = "context-menu-item";
			const childLabel = win.document.createElement("div");
			childLabel.className = "context-menu-item__label";
			childLabel.textContent = label;
			const childShortcut = win.document.createElement("kbd");
			childShortcut.className = "context-menu-item__shortcut";
			childShortcut.textContent = shortcut;
			childButton.append(childLabel, childShortcut);
			child.append(childButton);
			child.addEventListener("click", (click) => { click.stopPropagation(); void normalizeSelectedImages(leaf, mode); menu.parentElement?.remove(); removeSubmenu(); });
			built.append(child);
		}
		built.addEventListener("mouseenter", cancelHide);
		built.addEventListener("mouseleave", scheduleHide);
		win.document.body.append(built);
		submenu = built;
	};

	const menuCloseObserver = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			for (const removed of Array.from(mutation.removedNodes)) {
				if (removed instanceof HTMLElement && removed.querySelector?.(".context-menu")) removeSubmenu();
			}
		}
	});
	menuCloseObserver.observe(win.document.body, { childList: true });

	const onContextMenu = (event: MouseEvent) => {
		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (!leaf) return;
		win.setTimeout(() => {
			const menu = win.document.querySelector(".context-menu");
			if (!menu || menu.querySelector(".epr-normalize-menu")) return;
			if (!hasNormalizableSelection(leaf)) return;
			const item = win.document.createElement("li");
			item.className = "epr-normalize-menu";
			item.innerHTML = '<button type="button" class="context-menu-item"><div class="context-menu-item__label">Normalize</div><kbd class="context-menu-item__shortcut">›</kbd></button>';
			item.addEventListener("mouseenter", () => showSubmenu(item, leaf, menu));
			item.addEventListener("mouseleave", scheduleHide);
			menu.append(item);
		}, 0);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey || event.repeat) return;
		const mode = event.code === "ArrowLeft" ? "height" : event.code === "ArrowRight" ? "width" : event.code === "ArrowUp" ? "size" : event.code === "ArrowDown" ? "scale" : null;
		if (!mode) return;
		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (!leaf) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		void normalizeSelectedImages(leaf, mode);
	};
	win.addEventListener("contextmenu", onContextMenu, true);
	win.addEventListener("keydown", onKeyDown, true);
	return () => {
		win.removeEventListener("contextmenu", onContextMenu, true);
		win.removeEventListener("keydown", onKeyDown, true);
		menuCloseObserver.disconnect();
		removeSubmenu();
	};
}
