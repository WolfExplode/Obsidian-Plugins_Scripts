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
	setOpacity(opacity: number): void;
	getOpacity(): number;
	focus(): void;
	isFocused(): boolean;
	getBounds(): ElectronBounds;
	setBounds(bounds: ElectronBounds): void;
	hide(): void;
	show(): void;
	on?(event: string, listener: () => void): void;
	removeListener?(event: string, listener: () => void): void;
}

interface ElectronScreen {
	/** DIP rect (as returned by getBounds) -> absolute physical screen rect. */
	dipToScreenRect(win: ElectronBrowserWindow | null, rect: ElectronBounds): ElectronBounds;
	/** Absolute physical screen rect -> DIP rect for the display it falls on. */
	screenToDipRect(win: ElectronBrowserWindow | null, rect: ElectronBounds): ElectronBounds;
}

interface ElectronOpenDialogResult {
	canceled: boolean;
	filePaths: string[];
}

interface ElectronDialog {
	showOpenDialog(
		win: ElectronBrowserWindow | null,
		options: { title?: string; properties?: string[] },
	): Promise<ElectronOpenDialogResult>;
}

interface ElectronRemoteModule {
	getCurrentWindow?(): ElectronBrowserWindow | null;
	screen?: ElectronScreen;
	dialog?: ElectronDialog;
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

function getElectronScreen(): ElectronScreen | null {
	return getElectronRemoteModule()?.screen ?? null;
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

export function getFocusedBrowserWindowId(): number | null {
	const remoteModule = getElectronRemoteModule();
	if (!remoteModule?.BrowserWindow?.getFocusedWindow) return null;
	try {
		return remoteModule.BrowserWindow.getFocusedWindow()?.id ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve the Electron remote module from a specific DOM window's own bridge,
 * so calls made against it (getCurrentWindow, dialog, …) execute in that
 * window's renderer realm instead of being inferred from the global one.
 */
function resolveRemoteModuleForDomWindow(target: Window | null): ElectronRemoteModule | null {
	if (!target) return null;
	try {
		const targetWithElectron = target as Window & {
			electron?: { remote?: ElectronRemoteModule };
			require?: ElectronRequire;
		};
		let remoteModule = targetWithElectron.electron?.remote ?? null;
		if (!remoteModule && targetWithElectron.require) {
			for (const moduleId of MODULE_IDS) {
				try {
					remoteModule = resolveRemoteModule(targetWithElectron.require(moduleId));
					if (remoteModule) break;
				} catch {
					// Try the next Electron bridge exposed in this renderer.
				}
			}
		}
		return remoteModule;
	} catch {
		return null;
	}
}

/**
 * Resolve the BrowserWindow owned by a specific DOM window. Calling that
 * window's own require executes in its renderer realm, so getCurrentWindow()
 * is correlated directly instead of inferred from a global id difference.
 */
export function getBrowserWindowIdForDomWindow(target: Window | null): number | null {
	try {
		return resolveRemoteModuleForDomWindow(target)?.getCurrentWindow?.()?.id ?? null;
	} catch {
		return null;
	}
}

/**
 * Opens the native "choose a folder" dialog anchored to whichever window
 * (main or Popout) the export command was triggered from. Resolves to null on
 * cancel or when the dialog can't be reached at all.
 */
export async function pickDirectoryForDomWindow(target: Window | null, title: string): Promise<string | null> {
	const remoteModule = resolveRemoteModuleForDomWindow(target);
	if (!remoteModule?.dialog?.showOpenDialog) return null;
	try {
		const owner = remoteModule.getCurrentWindow?.() ?? null;
		const result = await remoteModule.dialog.showOpenDialog(owner, {
			title,
			properties: ["openDirectory", "createDirectory"],
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0];
	} catch {
		return null;
	}
}

export function adjustWindowOpacityById(id: number, delta: number): number | null {
	const win = getBrowserWindowById(id);
	if (!win) return null;
	try {
		const opacity = Math.max(0.2, Math.min(1, Math.round((win.getOpacity() + delta) * 100) / 100));
		win.setOpacity(opacity);
		return opacity;
	} catch {
		return null;
	}
}

export function getWindowOpacityById(id: number): number | null {
	const win = getBrowserWindowById(id);
	if (!win) return null;
	try {
		return win.getOpacity();
	} catch {
		return null;
	}
}

export function setWindowOpacityById(id: number, opacity: number): boolean {
	const win = getBrowserWindowById(id);
	if (!win) return false;
	try {
		win.setOpacity(Math.max(0.2, Math.min(1, opacity)));
		return true;
	} catch {
		return false;
	}
}

export function hideWindowById(id: number): boolean {
	const win = getBrowserWindowById(id);
	if (!win) return false;
	try {
		win.hide();
		return true;
	} catch {
		return false;
	}
}

export function showWindowById(id: number): boolean {
	const win = getBrowserWindowById(id);
	if (!win) return false;
	try {
		win.show();
		return true;
	} catch {
		return false;
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
 * Reads a window's bounds as absolute *physical* screen pixels (scale-
 * independent), for persistence. getBounds() alone returns DIP relative to the
 * display the window is currently on, so its numbers change meaning when a
 * later window lands on a different-DPI monitor — the root cause of the F11
 * "popout shrinks each toggle" bug on mixed-DPI Windows setups (a 125% main +
 * 100% secondary compounds a x0.8 error every cycle). Physical pixels are the
 * one representation that stays stable across monitors, verified live via CDP.
 *
 * Falls back to raw DIP getBounds() if the screen module is unavailable, so
 * single-DPI setups keep working even on Electron builds without it.
 */
export function getWindowPhysicalBoundsById(id: number): ElectronBounds | null {
	const win = getBrowserWindowById(id);
	if (!win) return null;
	try {
		const dip = win.getBounds();
		return getElectronScreen()?.dipToScreenRect(win, dip) ?? dip;
	} catch {
		return null;
	}
}

/**
 * Restores physical-pixel bounds (as saved by getWindowPhysicalBoundsById)
 * onto a window. setBounds() consumes DIP and converts using the window's
 * *current* display scale, so a freshly-created popout born on the 125% main
 * monitor would mis-scale bounds meant for the 100% secondary. We therefore
 * apply twice: the first setBounds migrates the window onto the destination
 * display (position is enough to move it), the second places it exactly now
 * that Electron's DIP<->physical conversion uses the destination display's
 * scale. This makes the save/restore round-trip idempotent — no drift.
 */
export function setWindowPhysicalBoundsById(id: number, physical: ElectronBounds): boolean {
	const win = getBrowserWindowById(id);
	if (!win) return false;
	try {
		const screen = getElectronScreen();
		if (!screen) {
			win.setBounds(physical);
			return true;
		}
		// Pass null so the DIP conversion is anchored to the display the physical
		// rect falls on, not the window's current (possibly wrong) display.
		win.setBounds(screen.screenToDipRect(null, physical));
		// Window has now migrated to the destination display; recompute DIP with
		// it so the placement is exact.
		win.setBounds(screen.screenToDipRect(win, physical));
		return true;
	} catch {
		return false;
	}
}

/** Registers work that must run while the native window can still report bounds. */
export function onWindowCloseById(id: number, listener: () => void): (() => void) | null {
	const win = getBrowserWindowById(id);
	if (!win?.on) return null;
	try {
		win.on("close", listener);
		return () => win.removeListener?.("close", listener);
	} catch {
		return null;
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
