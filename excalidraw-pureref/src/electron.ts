/**
 * Thin wrapper around Electron's BrowserWindow, reached via `window.require`
 * since Obsidian plugins run with full Node/Electron access on desktop.
 * Adapted from the window-control patterns in reference/obsidian-synaptic-hatch-master/src/electron.ts.
 *
 * Windows-only per ADR 0004 — 'screen-saver' is the highest always-on-top
 * level and is the one PureRef itself relies on to float above fullscreen apps.
 */

export const MAX_ALWAYS_ON_TOP_LEVEL = "screen-saver";

export interface ElectronBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface ElectronBrowserWindow {
	id: number;
	setAlwaysOnTop(flag: boolean, level?: string): void;
	isAlwaysOnTop(): boolean;
	focus(): void;
	isFocused(): boolean;
	getBounds(): ElectronBounds;
	setBounds(bounds: ElectronBounds): void;
}

interface ElectronRemoteModule {
	getCurrentWindow?(): ElectronBrowserWindow | null;
	BrowserWindow?: {
		getFocusedWindow(): ElectronBrowserWindow | null;
		getAllWindows(): ElectronBrowserWindow[];
		fromId?(id: number): ElectronBrowserWindow | null;
	};
}

type ElectronModule = ElectronRemoteModule & { remote?: ElectronRemoteModule };
type ElectronRequire = (moduleId: string) => unknown;

const MODULE_IDS = ["@electron/remote", "electron"] as const;

function getElectronRequire(): ElectronRequire | null {
	const globalWindow = window as Window & { require?: ElectronRequire };
	return globalWindow.require ?? null;
}

function resolveRemoteModule(moduleExport: unknown): ElectronRemoteModule | null {
	if (!moduleExport || typeof moduleExport !== "object") return null;
	const candidate = moduleExport as ElectronModule;
	if (candidate.getCurrentWindow || candidate.BrowserWindow) return candidate;
	if (candidate.remote) return candidate.remote;
	return null;
}

let loggedResolutionFailure = false;

function getElectronRemoteModule(): ElectronRemoteModule | null {
	const globalWindow = window as Window & { electron?: { remote?: ElectronRemoteModule } };
	if (globalWindow.electron?.remote) {
		return globalWindow.electron.remote;
	}

	const electronRequire = getElectronRequire();
	if (!electronRequire) {
		if (!loggedResolutionFailure) {
			console.error("[Excalidraw PureRef] window.require is not available — cannot reach Electron at all.");
			loggedResolutionFailure = true;
		}
		return null;
	}

	for (const moduleId of MODULE_IDS) {
		try {
			const resolved = resolveRemoteModule(electronRequire(moduleId));
			if (resolved) return resolved;
		} catch (error) {
			console.warn(`[Excalidraw PureRef] require("${moduleId}") threw:`, error);
		}
	}

	if (!loggedResolutionFailure) {
		console.error("[Excalidraw PureRef] could not resolve an Electron remote module from any candidate.");
		loggedResolutionFailure = true;
	}
	return null;
}

export function getAllBrowserWindows(): ElectronBrowserWindow[] {
	const remoteModule = getElectronRemoteModule();
	if (!remoteModule?.BrowserWindow?.getAllWindows) return [];
	try {
		return remoteModule.BrowserWindow.getAllWindows();
	} catch {
		return [];
	}
}

export function getBrowserWindowIds(): number[] {
	return getAllBrowserWindows().map((win) => win.id);
}

export function getBrowserWindowById(id: number): ElectronBrowserWindow | null {
	const remoteModule = getElectronRemoteModule();
	if (!remoteModule?.BrowserWindow?.fromId) return null;
	try {
		return remoteModule.BrowserWindow.fromId(id) ?? null;
	} catch {
		return null;
	}
}

export function setWindowAlwaysOnTopById(
	id: number,
	flag: boolean,
	level: string = MAX_ALWAYS_ON_TOP_LEVEL,
): boolean {
	const win = getBrowserWindowById(id);
	if (!win) return false;
	try {
		win.setAlwaysOnTop(flag, level);
		return true;
	} catch {
		return false;
	}
}

export function focusWindowById(id: number): boolean {
	const win = getBrowserWindowById(id);
	if (!win) return false;
	try {
		win.focus();
		return true;
	} catch {
		return false;
	}
}

export function getWindowBoundsById(id: number): ElectronBounds | null {
	const win = getBrowserWindowById(id);
	if (!win) return null;
	try {
		return win.getBounds();
	} catch {
		return null;
	}
}

export function setWindowBoundsById(id: number, bounds: ElectronBounds): boolean {
	const win = getBrowserWindowById(id);
	if (!win) return false;
	try {
		win.setBounds(bounds);
		return true;
	} catch {
		return false;
	}
}

/**
 * Finds the single browser window id that exists now but didn't exist in
 * `existingWindowIds`. Used right after `openPopoutLeaf()` since that call
 * returns a WorkspaceLeaf synchronously, before Obsidian's underlying
 * Electron BrowserWindow has necessarily finished being created.
 */
export function findNewBrowserWindowId(existingWindowIds: Set<number>): number | null {
	for (const id of getBrowserWindowIds()) {
		if (!existingWindowIds.has(id)) return id;
	}
	return null;
}
