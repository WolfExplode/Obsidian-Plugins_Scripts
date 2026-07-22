"use strict";

/*
 * Main-process helper for the read-only transparent prototype (F10).
 *
 * Loaded into Electron's MAIN process via `@electron/remote.require(<abs path>)`.
 * Running here is what makes the window genuinely transparent: the
 * transparent-popout investigation established that a directly constructed
 * `new BrowserWindow({ transparent: true, frame: false })` is the ONE config that
 * composites see-through on this machine, and only when requested at construction.
 *
 * The window loads a local HTML file with nodeIntegration on, so its renderer can
 * talk back over `ipcRenderer` for RMB window-move and for relaying F10/F11
 * (which, in a non-Obsidian window, never reach Obsidian's command system).
 *
 * NOTE: the renderer-side loader (transparent-proto.ts) busts this file out of the
 * main-process require cache on each plugin load, so editing it and reloading the
 * plugin is enough — no full Obsidian restart. Because of that, all top-level
 * side effects here must be re-runnable: installHandlers() clears prior listeners.
 */

const { BrowserWindow, ipcMain, screen } = require("electron");

const MOVE_CHANNEL = "epr-proto-move";
const KEY_CHANNEL = "epr-proto-key";
const CONTENT_CHANNEL = "epr-proto-content";
/** Invisible window title used only to recognise our own orphaned windows. */
const MARKER_TITLE = "__EPR_PROTOTYPE__";

/** prototype window id -> its opener (Obsidian) BrowserWindow, for key relay + lifetime. */
const openers = new Map();
/**
 * prototype window id -> its intended {width,height} in DIP, captured once at
 * creation. Reasserted on every move because Electron drifts a transparent,
 * frameless window's size when it's moved at fractional DPI scaling (resizable:
 * false does not prevent this). Captured ONCE and never re-read, so a drifted
 * size can never feed back and compound.
 */
const fixedSizes = new Map();
/**
 * prototype window id -> the reference captured at the start of an RMB drag:
 * the cursor's screen position and the window's position at that moment. Each
 * move is applied as origin + (cursorNow - cursorStart), computed against this
 * fixed reference — NOT by accumulating per-frame deltas and reading the
 * position back, which loses a sub-pixel to DIP rounding every frame and makes
 * the window slowly crawl off the cursor.
 */
const dragStates = new Map();

/**
 * Install the ipcMain handlers, replacing any left over from a previous (now
 * stale) load of this module so re-requiring never doubles them up.
 */
function installHandlers() {
	ipcMain.removeAllListeners(MOVE_CHANNEL);
	ipcMain.on(MOVE_CHANNEL, (event, msg) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || win.isDestroyed() || !msg) return;

		// Drag start: pin the reference the whole drag is measured against.
		if (msg.phase === "start") {
			const [originX, originY] = win.getPosition();
			dragStates.set(win.id, {
				cursorX: msg.screenX,
				cursorY: msg.screenY,
				originX,
				originY,
			});
			return;
		}

		const start = dragStates.get(win.id);
		if (!start) return;
		// Absolute target from the fixed origin — never read the (rounded) position
		// back, so nothing accumulates.
		const nx = Math.round(start.originX + (msg.screenX - start.cursorX));
		const ny = Math.round(start.originY + (msg.screenY - start.cursorY));
		const size = fixedSizes.get(win.id);
		if (size) {
			// Pin width/height to their constant original values (see fixedSizes):
			// a transparent frameless window drifts larger when moved at fractional
			// DPI, and this cancels it without letting it compound.
			win.setBounds({ x: nx, y: ny, width: size.width, height: size.height });
		} else {
			win.setPosition(nx, ny);
		}
	});

	ipcMain.removeAllListeners(KEY_CHANNEL);
	ipcMain.on(KEY_CHANNEL, (event, msg) => {
		// Relay a key message ({ key, view? }) pressed inside the transparent
		// window back to the plugin, which runs in the opener (Obsidian) renderer.
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return;
		const opener = openers.get(win.id);
		if (opener && !opener.isDestroyed()) opener.webContents.send(KEY_CHANNEL, msg);
	});
}

installHandlers();

/**
 * Create the transparent, frameless, always-on-top prototype window at `bounds`
 * (DIP) loading `htmlPath`. `parentId` is the opener window used for key relay
 * and for tying the prototype's lifetime to Obsidian. Returns the new window id.
 */
function createPrototype(options) {
	const bounds = (options && options.bounds) || { x: 240, y: 200, width: 640, height: 440 };
	const htmlPath = options && options.htmlPath;
	const parent = options && options.parentId != null ? BrowserWindow.fromId(options.parentId) : null;

	const win = new BrowserWindow({
		x: Math.round(bounds.x),
		y: Math.round(bounds.y),
		width: Math.round(bounds.width),
		height: Math.round(bounds.height),
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: false,
		// Never resized (only moved), so lock the size — also removes any chance
		// of DPI size drift.
		resizable: false,
		skipTaskbar: true,
		title: MARKER_TITLE,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
			// This window's page is loaded from disk (loadFile) and displays only
			// local, trusted content: our own HTML plus vault media referenced by
			// file:// URLs. Same-origin file access is needed so the read-only
			// board can paint local <video>/<img> overlays, and muted videos must
			// be free to autoplay. Both are safe here — no remote content loads.
			webSecurity: false,
			autoplayPolicy: "no-user-gesture-required",
		},
	});

	try {
		win.setTitle(MARKER_TITLE);
	} catch (_e) {
		/* frameless: title is invisible anyway */
	}

	// loadFile() below loads HTML with its own <title>, which Chromium would push
	// onto the window title — clobbering MARKER_TITLE and breaking the marker-based
	// orphan cleanup (closeAllPrototypes matches on getTitle() === MARKER_TITLE).
	// Intercept the title update, suppress it, and reassert the marker. The window
	// is frameless + skipTaskbar, so the title is never visible to the user anyway.
	win.webContents.on("page-title-updated", (e) => {
		e.preventDefault();
		if (!win.isDestroyed() && win.getTitle() !== MARKER_TITLE) win.setTitle(MARKER_TITLE);
	});

	// Highest always-on-top level (ADR 0004) so it floats like the real popout.
	try {
		win.setAlwaysOnTop(true, "screen-saver");
	} catch (_e) {
		win.setAlwaysOnTop(true);
	}

	win.loadFile(htmlPath);
	// Lock the size to what we requested (what the user sees as correct at open),
	// captured once — see fixedSizes above.
	fixedSizes.set(win.id, { width: Math.round(bounds.width), height: Math.round(bounds.height) });
	if (parent) openers.set(win.id, parent);

	// Tie the prototype's lifetime to Obsidian's window: when the opener closes
	// (including on app quit), close the prototype so it can't be orphaned.
	let onParentClose = null;
	if (parent && typeof parent.on === "function") {
		onParentClose = () => {
			if (!win.isDestroyed()) win.close();
		};
		parent.on("close", onParentClose);
	}
	win.on("closed", () => {
		openers.delete(win.id);
		fixedSizes.delete(win.id);
		dragStates.delete(win.id);
		if (parent && onParentClose) {
			try {
				parent.removeListener("close", onParentClose);
			} catch (_e) {
				/* parent already gone */
			}
		}
	});

	return win.id;
}

/**
 * Push an SVG string into a prototype window for display. Waits for the window
 * to finish loading first, so content sent immediately after createPrototype
 * isn't dropped.
 */
function setContent(id, content) {
	const win = BrowserWindow.fromId(id);
	if (!win || win.isDestroyed()) return false;
	const send = () => {
		if (!win.isDestroyed()) win.webContents.send(CONTENT_CHANNEL, content);
	};
	if (win.webContents.isLoading()) {
		win.webContents.once("did-finish-load", send);
	} else {
		send();
	}
	return true;
}

/** Close a prototype window by id. Safe if it's already gone. */
function closePrototype(id) {
	const win = BrowserWindow.fromId(id);
	if (win && !win.isDestroyed()) {
		win.close();
		return true;
	}
	return false;
}

/**
 * Close every prototype window we can recognise by its marker title — including
 * ones orphaned by a previous plugin session whose id we no longer hold. Returns
 * how many were closed.
 */
function closeAllPrototypes() {
	let closed = 0;
	for (const win of BrowserWindow.getAllWindows()) {
		try {
			if (!win.isDestroyed() && typeof win.getTitle === "function" && win.getTitle() === MARKER_TITLE) {
				win.close();
				closed++;
			}
		} catch (_e) {
			/* skip */
		}
	}
	return closed;
}

/**
 * Current bounds of a prototype window as absolute *physical* screen pixels
 * (matching electron.ts's getWindowPhysicalBoundsById), so the editable popout
 * can be reopened at exactly where the user left the transparent window.
 */
function getPrototypeBounds(id) {
	const win = BrowserWindow.fromId(id);
	if (!win || win.isDestroyed()) return null;
	try {
		return screen.dipToScreenRect(win, win.getBounds());
	} catch (_e) {
		try {
			return win.getBounds();
		} catch (_e2) {
			return null;
		}
	}
}

/**
 * Remove this module from the MAIN-process require cache so the next
 * `remote.require(<this file>)` recompiles it from disk. This MUST run in the
 * main process (where this module lives): the renderer can't bust the cache by
 * deleting `remote.require("module")._cache[key]`, because @electron/remote
 * forwards function *calls* but not property *deletes*. The renderer therefore
 * calls this to make .cjs edits hot-reload on a plugin reload — see
 * transparent-proto.ts loadHelper.
 */
function __evictFromCache() {
	try {
		delete require.cache[__filename];
	} catch (_e) {
		/* best-effort */
	}
}

module.exports = {
	MOVE_CHANNEL,
	KEY_CHANNEL,
	CONTENT_CHANNEL,
	createPrototype,
	closePrototype,
	closeAllPrototypes,
	getPrototypeBounds,
	setContent,
	__evictFromCache,
};
