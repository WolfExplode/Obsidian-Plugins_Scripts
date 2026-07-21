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

/** What we push into the transparent window: the board SVG, its scene offset, and an optional camera. */
export interface BoardContent {
	svg: string;
	minX: number;
	minY: number;
	view?: SceneViewPayload | null;
}

/** F10/F11 relayed out of the transparent window; F10 carries the window's current camera. */
export interface ReadOnlyKeyMessage {
	key: string;
	view?: SceneViewPayload | null;
}

interface ProtoHelper {
	createPrototype(options: { bounds?: ElectronBounds; htmlPath: string; parentId?: number }): number;
	closePrototype(id: number): boolean;
	closeAllPrototypes(): number;
	getPrototypeBounds(id: number): ElectronBounds | null;
	setContent(id: number, content: BoardContent): boolean;
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
		// plugin reload. Without this, remote.require returns the stale cached
		// module and .cjs changes silently never apply (a full Obsidian restart
		// would otherwise be required).
		try {
			const mod = remote.require("module") as { _cache?: Record<string, unknown> };
			if (mod?._cache) delete mod._cache[paths.helperPath];
		} catch {
			/* best-effort cache bust */
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
export function openPrototype(plugin: ExcalidrawPureRefPlugin, bounds?: ElectronBounds): boolean {
	if (openWindowId != null) return true;
	const h = loadHelper(plugin);
	if (!h || !htmlPath) return false;
	try {
		openWindowId = h.createPrototype({ bounds, htmlPath, parentId: getCurrentWindowId() });
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
