import type ExcalidrawPureRefPlugin from "../main";
import type { ElectronBounds } from "./electron";

/**
 * Renderer-side driver for the read-only transparent prototype (F10).
 *
 * The window itself is built in Electron's main process by transparent-proto.cjs
 * (see that file for why it has to be main-process construction). Here we just
 * load that helper via `@electron/remote.require(<abs path>)` — the same bridge
 * the rest of the plugin uses to reach Electron — and drive open/close, tracking
 * the single live prototype window's id.
 */

const HELPER_FILE = "transparent-proto.cjs";
const HTML_FILE = "transparent-proto.html";

const KEY_CHANNEL = "epr-proto-key";

/** Size-independent camera shared across the mode switch (see excalidraw-view SceneView). */
export interface SceneViewPayload {
	cx: number;
	cy: number;
	zoom: number;
}

/**
 * A live-media element to overlay on the static board SVG. Local video/animated
 * media are stored as Excalidraw "embeddable" elements linking a vault file; the
 * static SVG export can't rasterize them (they come out empty), so the read-only
 * window paints a real <video>/<img> at the element's scene geometry instead.
 * `src` is a file:// URL; coordinates are scene units (same space as minX/minY).
 */
export interface MediaOverlay {
	kind: "video" | "image";
	src: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Rotation in radians about the element's center (Excalidraw's `angle`). */
	angle: number;
}

/** What we push into the transparent window: the board SVG, its scene offset, a camera, and any live-media overlays. */
export interface BoardContent {
	svg: string;
	minX: number;
	minY: number;
	view?: SceneViewPayload | null;
	media?: MediaOverlay[];
}

/** F10/F11 relayed out of the transparent window; F10 carries the window's current camera. */
export interface ReadOnlyKeyMessage {
	key: string;
	view?: SceneViewPayload | null;
}

interface ProtoHelper {
	createPrototype(options: { bounds?: ElectronBounds; htmlPath: string; parentId?: number; opacity?: number }): number;
	closePrototype(id: number): boolean;
	closeAllPrototypes(): number;
	getPrototypeBounds(id: number): ElectronBounds | null;
	setContent(id: number, content: BoardContent): boolean;
	adjustOpacity(id: number, delta: number): boolean;
	getOpacity(id: number): number | null;
	focusPrototype(id: number): boolean;
}

type RequireFn = (id: string) => unknown;

function getRequire(): RequireFn | null {
	return (window as Window & { require?: RequireFn }).require ?? null;
}

interface RemoteModule {
	require?(path: string): unknown;
	getCurrentWindow?(): { id: number } | null;
}

function getRemote(): RemoteModule | null {
	const injected = (window as Window & { electron?: { remote?: RemoteModule } }).electron?.remote;
	if (injected?.require) return injected;
	const req = getRequire();
	if (!req) return null;
	try {
		return req("@electron/remote") as RemoteModule;
	} catch {
		return null;
	}
}

function resolvePaths(plugin: ExcalidrawPureRefPlugin): { helperPath: string; htmlPath: string } | null {
	const req = getRequire();
	if (!req) return null;
	const path = req("path") as { join(...parts: string[]): string };
	const adapter = plugin.app.vault.adapter as unknown as { getBasePath?(): string };
	const basePath = adapter.getBasePath?.();
	if (!basePath || !plugin.manifest.dir) return null;
	return {
		helperPath: path.join(basePath, plugin.manifest.dir, HELPER_FILE),
		htmlPath: path.join(basePath, plugin.manifest.dir, HTML_FILE),
	};
}

let helper: ProtoHelper | null = null;
let htmlPath: string | null = null;
let openWindowId: number | null = null;

function loadHelper(plugin: ExcalidrawPureRefPlugin): ProtoHelper | null {
	if (helper) return helper;
	const paths = resolvePaths(plugin);
	const remote = getRemote();
	if (!paths || !remote?.require) {
		console.error("[Excalidraw PureRef] transparent prototype: Electron bridge or plugin path unavailable.");
		return null;
	}
	try {
		// Bust the MAIN-process require cache so edits to the .cjs take effect on a
		// plugin reload — otherwise remote.require returns the stale cached module
		// and .cjs changes silently never apply until a full Obsidian restart.
		//
		// The cache CANNOT be busted from here by deleting mod._cache[key]: that
		// object is reached through @electron/remote's proxy, which forwards
		// function *calls* to the main process but NOT property *deletes*, so the
		// delete is a silent no-op on the real (main-process) cache. Instead we let
		// the helper evict itself — __evictFromCache() runs in main, where
		// `delete require.cache[__filename]` genuinely takes effect. We call it on
		// the currently-cached (possibly stale) module, then re-require for a fresh
		// one. installHandlers() in the .cjs clears prior ipc listeners, so
		// re-requiring never doubles them up.
		//
		// One caveat: the very first load after __evictFromCache was ADDED to the
		// .cjs still needs a single Obsidian restart (the running main process has
		// the older module without it). Every edit after that hot-reloads normally.
		try {
			const stale = remote.require(paths.helperPath) as { __evictFromCache?: () => void };
			stale.__evictFromCache?.();
		} catch {
			/* no module cached yet, or an older .cjs without self-eviction */
		}
		helper = remote.require(paths.helperPath) as ProtoHelper;
		htmlPath = paths.htmlPath;
		return helper;
	} catch (error) {
		console.error("[Excalidraw PureRef] transparent prototype: could not load helper.", error);
		return null;
	}
}

function getCurrentWindowId(): number | undefined {
	const remote = getRemote();
	try {
		return remote?.getCurrentWindow?.()?.id ?? undefined;
	} catch {
		return undefined;
	}
}

export function isPrototypeOpen(): boolean {
	return openWindowId != null;
}

/** Open the transparent prototype at `bounds` (DIP). No-op if one is already open. */
export function openPrototype(plugin: ExcalidrawPureRefPlugin, bounds?: ElectronBounds, opacity?: number): boolean {
	if (openWindowId != null) return true;
	const h = loadHelper(plugin);
	if (!h || !htmlPath) return false;
	try {
		openWindowId = h.createPrototype({ bounds, htmlPath, parentId: getCurrentWindowId(), opacity });
		if (openWindowId != null) h.focusPrototype(openWindowId);
		return openWindowId != null;
	} catch (error) {
		console.error("[Excalidraw PureRef] transparent prototype: createPrototype failed.", error);
		openWindowId = null;
		return false;
	}
}

/** Display board content (SVG + camera) in the open prototype window. No-op if none is open. */
export function setPrototypeContent(content: BoardContent): void {
	if (!helper || openWindowId == null) return;
	try {
		helper.setContent(openWindowId, content);
	} catch (error) {
		console.error("[Excalidraw PureRef] transparent prototype: setContent failed.", error);
	}
}

/** Restore native focus to the read-only window after its outgoing Popout closes. */
export function focusPrototypeWindow(): boolean {
	if (!helper || openWindowId == null) return false;
	try {
		return helper.focusPrototype(openWindowId);
	} catch {
		return false;
	}
}

/** Current bounds (physical px) of the open prototype window, or null if none. */
export function getPrototypeBounds(): ElectronBounds | null {
	if (!helper || openWindowId == null) return null;
	try {
		return helper.getPrototypeBounds(openWindowId);
	} catch {
		return null;
	}
}

/** Close the prototype window, if any. */
export function closePrototype(): void {
	if (helper && openWindowId != null) {
		try {
			helper.closePrototype(openWindowId);
		} catch (error) {
			console.error("[Excalidraw PureRef] transparent prototype: closePrototype failed.", error);
		}
	}
	openWindowId = null;
}

/** Adjusts the read-only window's native opacity, including its transparent surface. */
export function adjustPrototypeOpacity(delta: number): boolean {
	if (!helper || openWindowId == null) return false;
	try {
		return helper.adjustOpacity(openWindowId, delta);
	} catch {
		return false;
	}
}

export function getPrototypeOpacity(): number | null {
	if (!helper || openWindowId == null) return null;
	try {
		return helper.getOpacity(openWindowId);
	} catch {
		return null;
	}
}

/**
 * Close any prototype windows left over from a previous plugin session (their
 * ids are lost across reloads, but the helper recognises them by marker title).
 */
export function cleanupOrphanPrototypes(plugin: ExcalidrawPureRefPlugin): void {
	const h = loadHelper(plugin);
	if (!h) return;
	try {
		h.closeAllPrototypes();
	} catch (error) {
		console.error("[Excalidraw PureRef] transparent prototype: orphan cleanup failed.", error);
	}
}

interface IpcRendererLike {
	on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
	removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

function getIpcRenderer(): IpcRendererLike | null {
	const req = getRequire();
	if (!req) return null;
	try {
		return (req("electron") as { ipcRenderer?: IpcRendererLike }).ipcRenderer ?? null;
	} catch {
		return null;
	}
}

let keyListener: ((event: unknown, ...args: unknown[]) => void) | null = null;

/**
 * Route F10/F11 pressed inside the transparent window (relayed via main) to
 * `handler`. F10 carries the window's current camera so edit mode can resume it.
 * Installed once from the plugin's onload.
 */
export function installKeyRelay(handler: (msg: ReadOnlyKeyMessage) => void): void {
	if (keyListener) return;
	const ipc = getIpcRenderer();
	if (!ipc) return;
	keyListener = (_event, ...args) => handler((args[0] ?? { key: "" }) as ReadOnlyKeyMessage);
	ipc.on(KEY_CHANNEL, keyListener);
}

export function removeKeyRelay(): void {
	if (!keyListener) return;
	const ipc = getIpcRenderer();
	if (ipc) ipc.removeListener(KEY_CHANNEL, keyListener);
	keyListener = null;
}
