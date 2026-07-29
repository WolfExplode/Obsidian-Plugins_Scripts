import { Notice, type App, type WorkspaceLeaf } from "obsidian";
import { VIEWPORT_CROP_KEY } from "./crop-orchestrator";
import { isEditableTarget } from "./editable-target";
import { findExcalidrawLeafForNode, getExcalidrawApi, getExcalidrawView, type SceneElement } from "./excalidraw-view";

/** The scene-element fields any type's duplicate signature might read. */
interface DuplicateCandidateElement extends SceneElement {
	fileId?: string;
	link?: string | null;
	text?: string;
	fontFamily?: number;
	fontSize?: number;
	textAlign?: string;
	strokeColor?: string;
	backgroundColor?: string;
	fillStyle?: string;
	strokeWidth?: number;
	strokeStyle?: string;
	roughness?: number;
	points?: readonly (readonly [number, number])[];
	crop?: { width: number; height: number } | null;
	customData?: Record<string, unknown>;
}

/**
 * The fileId of the element's PureRef custom crop source, if it has one. A
 * hold-C crop drag (crop-orchestrator.ts) materializes its result as a brand
 * new image element pointing at a freshly generated PNG -- a distinct
 * `fileId` from the image it was cropped out of -- and records where it came
 * from in `customData[VIEWPORT_CROP_KEY].sourceFileId`. Without reading that
 * back, a custom-cropped image's own fileId never matches anything else on
 * the board, even the exact file it was cropped from.
 */
function customCropSourceFileId(el: DuplicateCandidateElement): string | undefined {
	const state = el.customData?.[VIEWPORT_CROP_KEY];
	if (!state || typeof state !== "object") return undefined;
	const sourceFileId = (state as { sourceFileId?: unknown }).sourceFileId;
	return typeof sourceFileId === "string" ? sourceFileId : undefined;
}

/** Rounds away float noise (subpixel drift from resize/rotate) before it enters a signature string. */
function round(value: number | undefined): string {
	return value === undefined ? "" : (Math.round(value * 100) / 100).toString();
}

/**
 * An embeddable's `link`, normalized so the same target compares equal
 * regardless of how it's written: `[[note.mp4]]` and `note.mp4` are the same
 * vault file, and a `|alias` suffix doesn't change what's embedded. Unlike
 * board-render.ts's `localLinkpath`, this deliberately does NOT null out
 * `http(s)://` links -- two embeds of the same web video/URL are duplicates
 * too, and identity here only needs string equality, not vault resolution.
 */
function normalizedLink(link: string | null | undefined): string | null {
	if (!link) return null;
	let s = link.trim();
	const wiki = s.match(/^\[\[([^\]]+)\]\]$/);
	if (wiki) s = wiki[1];
	s = s.split("|")[0].trim();
	return s || null;
}

/**
 * Whether a cropped image counts as a duplicate of the same source file's
 * other crops (including the uncropped original) -- both Excalidraw's native
 * crop and this plugin's own hold-C custom crop (see
 * customCropSourceFileId). Toggle to `false` to go back to treating each
 * distinct crop as its own thing -- e.g. if a board deliberately keeps
 * several different crops of one photo as separate references and those
 * shouldn't be flagged against each other.
 */
const TREAT_CROPS_AS_DUPLICATES = true;

/**
 * A content signature for one element, deliberately excluding position (x/y),
 * rotation, and identity fields (id, seed, version, updated, groupIds, frameId) --
 * two elements are "duplicates" if they'd look and behave the same wherever
 * they sat on the board. Returns null when the element has nothing to key on
 * (e.g. an unresolved embeddable with no link, or empty text).
 *
 * Images key on `fileId`: Excalidraw derives fileId as a content hash of the
 * file's bytes (`generateIdFromFile` upstream), so two image elements sharing
 * a fileId are backed by pixel-identical source data regardless of when or how
 * each was imported into the board -- this is exactly "does this image already
 * exist here", independent of size/position. Whether a different crop of that
 * same fileId also counts is gated by TREAT_CROPS_AS_DUPLICATES: when on, a
 * PureRef custom crop is traced back to customCropSourceFileId() so it keys on
 * the file it was cropped FROM, not the disposable generated PNG it cropped
 * TO; when off, crop dimensions (native crop) or the element's own fileId
 * (custom crop) are folded into the signature so every distinct crop is kept
 * separate from the source and from each other.
 *
 * Embeddables (video, PDF, web embeds, …) carry no `fileId` -- that field is
 * image-only -- so they key on their normalized `link` instead: what vault
 * file or URL they point at. Without this, every embeddable of the same
 * on-canvas size and style falls through to the generic signature below and
 * reads as a duplicate of every other one, which is the bug this fixes (all
 * .mp4s / all PDFs / etc. looked identical regardless of which file they embed).
 *
 * Every other type falls back to a type + geometry + style signature so the
 * same search works for shapes, text, and freedraw strokes without any
 * per-type wiring at the call site.
 */
function elementSignature(el: DuplicateCandidateElement): string | null {
	if (el.type === "image" && el.fileId) {
		if (TREAT_CROPS_AS_DUPLICATES) return `image:${customCropSourceFileId(el) ?? el.fileId}`;
		return `image:${el.fileId}:${round(el.crop?.width)}x${round(el.crop?.height)}`;
	}
	if (el.type === "embeddable") {
		const link = normalizedLink(el.link);
		return link ? `embeddable:${link}` : null;
	}
	if (el.type === "text") {
		if (!el.text) return null;
		return `text:${el.fontFamily}:${round(el.fontSize)}:${el.textAlign}:${el.text}`;
	}
	const points = el.points ? JSON.stringify(el.points.map(([x, y]) => [round(x), round(y)])) : "";
	return [
		el.type,
		round(el.width),
		round(el.height),
		el.strokeColor,
		el.backgroundColor,
		el.fillStyle,
		round(el.strokeWidth),
		el.strokeStyle,
		round(el.roughness),
		points,
	].join(":");
}

/** Whether exactly one live element is selected -- Find Duplicates needs a single source element. */
function hasSingleElementSelected(leaf: WorkspaceLeaf | null): boolean {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements) return false;
	try {
		const selected = api.getAppState().selectedElementIds ?? {};
		let count = 0;
		for (const element of api.getSceneElements()) {
			if (!element.isDeleted && selected[element.id] && ++count > 1) return false;
		}
		return count === 1;
	} catch {
		return false;
	}
}

export interface DuplicateSearchResult {
	sourceId: string;
	sourceType: string;
	matchIds: string[];
}

/**
 * Finds every other live element on the board whose content signature matches
 * the single currently-selected element. Returns null when the leaf/API is
 * unavailable or the selection isn't exactly one element.
 */
export function findDuplicatesOfSelection(leaf: WorkspaceLeaf | null): DuplicateSearchResult | null {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements) return null;
	let live: readonly DuplicateCandidateElement[];
	let selectedIds: Record<string, boolean>;
	try {
		live = (api.getSceneElements() as readonly DuplicateCandidateElement[]).filter((el) => !el.isDeleted);
		selectedIds = api.getAppState().selectedElementIds ?? {};
	} catch {
		return null;
	}
	const selected = live.filter((el) => selectedIds[el.id]);
	if (selected.length !== 1) return null;
	const [source] = selected;
	const signature = elementSignature(source);
	if (!signature) return { sourceId: source.id, sourceType: source.type, matchIds: [] };
	const matchIds = live.filter((el) => el.id !== source.id && elementSignature(el) === signature).map((el) => el.id);
	return { sourceId: source.id, sourceType: source.type, matchIds };
}

/** Replaces the current selection with exactly these element ids. */
function selectSceneElementIds(leaf: WorkspaceLeaf | null, ids: readonly string[]): boolean {
	const view = getExcalidrawView(leaf);
	if (!view?.excalidrawAPI || !view.updateScene) return false;
	try {
		view.updateScene({ appState: { selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])) } });
		return true;
	} catch {
		return false;
	}
}

/**
 * Runs the duplicate search for the current selection and surfaces the result:
 * selects the source plus every match (so they're all highlighted together on
 * canvas -- press Shift+1 to zoom-to-fit if any sit off-screen) and shows a
 * Notice with the count.
 */
function runDuplicateSearch(leaf: WorkspaceLeaf | null): void {
	const result = findDuplicatesOfSelection(leaf);
	if (!result) return;
	if (result.matchIds.length === 0) {
		new Notice(`No duplicates of this ${result.sourceType} found on this board.`);
		return;
	}
	selectSceneElementIds(leaf, [result.sourceId, ...result.matchIds]);
	const count = result.matchIds.length;
	new Notice(`Found ${count} duplicate${count === 1 ? "" : "s"} of this ${result.sourceType}. Selected on canvas.`);
}

/**
 * Adds a "Find Duplicates" entry to Excalidraw's native canvas context menu,
 * shown only when exactly one element is selected, and rebinds Ctrl/Cmd+F to
 * the same search while a single element is selected. Mirrors
 * image-normalize.ts's menu-injection approach (append a `<li>` matching
 * Excalidraw's own `context-menu-item` markup, since removing/replacing
 * existing nodes there can corrupt Excalidraw's own render tree -- see
 * context-menu-trim.ts).
 *
 * With nothing selected (or more than one element), Ctrl/Cmd+F is left alone
 * so Excalidraw's native "Find text on canvas" still opens as usual.
 */
export function attachDuplicateFinder(win: Window, app: App): () => void {
	const onKeyDown = (event: KeyboardEvent) => {
		if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.repeat) return;
		if (event.code !== "KeyF") return;
		if (isEditableTarget(event.target)) return;
		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (!leaf || !hasSingleElementSelected(leaf)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		runDuplicateSearch(leaf);
	};
	const onContextMenu = (event: MouseEvent) => {
		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (!leaf) return;
		win.setTimeout(() => {
			const menu = win.document.querySelector(".context-menu");
			if (!menu || menu.querySelector(".epr-find-duplicates-menu")) return;
			if (!hasSingleElementSelected(leaf)) return;
			const item = win.document.createElement("li");
			item.className = "epr-find-duplicates-menu";
			item.innerHTML = '<button type="button" class="context-menu-item"><div class="context-menu-item__label">Find Duplicates</div></button>';
			item.addEventListener("click", (click) => {
				click.stopPropagation();
				// Hide, don't remove: runDuplicateSearch below changes
				// selectedElementIds, which can make Excalidraw's own menu
				// component try to re-render/unmount itself on the same tick. If
				// we'd already yanked the node out with .remove(), that reconcile
				// targets a DOM node that's no longer there and throws (blanking
				// the canvas until the file is reopened) -- the exact failure mode
				// documented in context-menu-trim.ts for this same native menu.
				const popover = menu.parentElement as HTMLElement | null;
				if (popover) popover.setCssStyles({ display: "none" });
				runDuplicateSearch(leaf);
			});
			menu.append(item);
		}, 0);
	};
	win.addEventListener("contextmenu", onContextMenu, true);
	win.addEventListener("keydown", onKeyDown, true);
	return () => {
		win.removeEventListener("contextmenu", onContextMenu, true);
		win.removeEventListener("keydown", onKeyDown, true);
	};
}
