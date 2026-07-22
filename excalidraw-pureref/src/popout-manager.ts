import { Notice, TFile, WorkspaceLeaf, WorkspaceWindow } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import {
	getBrowserWindowIds,
	getFocusedBrowserWindowId,
	getBrowserWindowIdForDomWindow,
	findNewBrowserWindowId,
	adjustWindowOpacityById,
	getWindowOpacityById,
	setWindowOpacityById,
	hideWindowById,
	showWindowById,
	setWindowAlwaysOnTopById,
	focusWindowById,
	getWindowBoundsById,
	getWindowPhysicalBoundsById,
	setWindowPhysicalBoundsById,
	onWindowCloseById,
	type ElectronBounds,
} from "./electron";
import {
	isPrototypeOpen,
	openPrototype,
	closePrototype,
	adjustPrototypeOpacity,
	focusPrototypeWindow,
	getPrototypeOpacity,
	getPrototypeBounds,
	setPrototypeContent,
	type ReadOnlyKeyMessage,
} from "./transparent-proto";
import { renderBoardSvg, getSceneMin, collectMediaOverlays } from "./board-render";
import { markPopupDocument, getPopupFilePath, clearPopupDocumentMarker } from "./document-marker";
import { attachWindowDrag } from "./window-drag";
import { applyChromeHiding } from "./chrome-hider";
import { attachPopoutDropBridge } from "./popout-drop-bridge";
import { attachPackKeydown } from "./pack-keys";
import { ExcalidrawRefitSuspender } from "./excalidraw-settings";
import {
	EXCALIDRAW_VIEW_TYPE,
	readViewport,
	applyViewport,
	enableZenMode,
	readMainWindowViewportForFile,
	readContainerSize,
	isCanvasReady,
	isExcalidrawPluginAvailable,
	enableOverlapSelection,
	mirrorViewport,
	readSceneView,
	readSceneElements,
	applySceneView,
	type SceneView,
} from "./excalidraw-view";

/** Applied to a Popout window's <body>; see styles.css for what it hides. */
export const CHROME_HIDDEN_CLASS = "epr-popout-mode";

const FINALIZE_MAX_ATTEMPTS = 10;
const FINALIZE_RETRY_DELAY_MS = 75;
/** Hard cap for waitForPopoutFocus; normal resolution is a frame or two. */
const FOCUS_WAIT_MAX_MS = 1000;
/**
 * Hard cap for waiting on Excalidraw's canvas API to come alive after
 * setViewState (mount + scene/image load — typically a few hundred ms). Past
 * this we finalize anyway rather than hang.
 */
const CANVAS_READY_MAX_MS = 10000;
/** Poll interval for the canvas-ready wait, on the main-window timer. */
const CANVAS_READY_POLL_MS = 16;
const POPOUT_OPACITY_STEP = 0.05;

interface OpenBoardPopout {
	leaf: WorkspaceLeaf | null;
	phase: "opening" | "ready" | "closing";
	windowId: number | null;
	doc: Document | null;
	detachWindowDrag: (() => void) | null;
	detachChromeHiding: (() => void) | null;
	detachDropBridge: (() => void) | null;
	detachBoundsSaving: (() => void) | null;
	detachPackKeys: (() => void) | null;
}

interface PendingOpen {
	filePath: string;
	existingWindowIds: Set<number>;
	initialOpacity?: number;
	timeoutId: number | null;
	doc: Document | null;
	entry: OpenBoardPopout;
}

/**
 * Owns the F11 lifecycle described in CONTEXT.md's "Popout" entry: F11 in an
 * Excalidraw view (main window or an existing Popout, it makes no
 * difference — see the toggle logic below) opens a Board's Popout if none
 * exists, or closes it if one does. Programmatic and native close paths share
 * the same idempotent cleanup implementation so tracked state and persisted
 * geometry stay consistent regardless of cause.
 */
export class PopoutManager {
	private readonly openBoards = new Map<string, OpenBoardPopout>();
	private pending: PendingOpen | null = null;
	private readonly refitSuspender: ExcalidrawRefitSuspender;
	private transitionQueue: Promise<void> = Promise.resolve();
	private disposed = false;
	/**
	 * Which Board the read-only transparent window is currently showing, so F10
	 * (read-only -> edit) knows which popout to reopen. Non-null iff the
	 * transparent prototype is up.
	 */
	private readOnlyFilePath: string | null = null;
	/**
	 * Camera captured from the transparent window when F10 switches back to edit
	 * mode, applied to the reopened popout so the framing carries across. Consumed
	 * once by applyStartupViewport.
	 */
	private pendingReadToEditView: SceneView | null = null;

	constructor(private readonly plugin: ExcalidrawPureRefPlugin) {
		this.refitSuspender = new ExcalidrawRefitSuspender(plugin.app);
	}

	private runTransition(label: string, task: () => Promise<void>): Promise<void> {
		const run = this.transitionQueue.then(async () => {
			if (this.disposed) return;
			await task();
		});
		const handled = run.catch((error) => {
			console.error(`[Excalidraw PureRef] failed to ${label}.`, error);
			new Notice(`Excalidraw PureRef could not ${label}. See the developer console for details.`);
		});
		this.transitionQueue = handled;
		return handled;
	}

	private isCurrent(filePath: string, entry: OpenBoardPopout): boolean {
		return !this.disposed && entry.phase !== "closing" && this.openBoards.get(filePath) === entry;
	}

	isOpen(filePath: string): boolean {
		return this.openBoards.get(filePath)?.phase === "ready";
	}

	/** True only when the focused native window is one of this plugin's Popouts. */
	canAdjustFocusedPopoutOpacity(): boolean {
		const focusedWindowId = getFocusedBrowserWindowId();
		return focusedWindowId != null && Array.from(this.openBoards.values()).some((entry) => entry.windowId === focusedWindowId);
	}

	/** Changes opacity only for the focused native Popout, not the main window. */
	adjustFocusedPopoutOpacity(direction: -1 | 1): boolean {
		const focusedWindowId = getFocusedBrowserWindowId();
		if (focusedWindowId == null) return false;
		if (!Array.from(this.openBoards.values()).some((entry) => entry.windowId === focusedWindowId)) return false;
		return adjustWindowOpacityById(focusedWindowId, direction * POPOUT_OPACITY_STEP) != null;
	}

	/**
	 * The single entry point for the F11 command. Because a Popout is just a
	 * second Excalidraw view of the same file, "F11 in the main view" and
	 * "F11 inside the Popout" both reduce to the same rule: closed -> open,
	 * open -> closed. There is no need to special-case which window the
	 * keypress came from.
	 */
	toggle(file: TFile | null): Promise<void> {
		return this.runTransition("toggle Popout", () => this.toggleNow(file));
	}

	private async toggleNow(file: TFile | null): Promise<void> {
		// F11 while the read-only transparent window is up just closes it (per the
		// requirement); it does not reopen the editable popout.
		if (isPrototypeOpen()) {
			const hiddenFilePath = this.readOnlyFilePath;
			closePrototype();
			this.readOnlyFilePath = null;
			if (hiddenFilePath) this.close(hiddenFilePath);
			return;
		}
		if (!file) return;
		if (this.openBoards.has(file.path)) {
			this.close(file.path);
			return;
		}
		await this.open(file);
	}

	/** True while the read-only transparent prototype window is open. */
	isReadOnlyOpen(): boolean {
		return isPrototypeOpen();
	}

	/**
	 * F10/F11 pressed *inside* the transparent window, relayed from that window
	 * (it's not an Obsidian window, so the command hotkeys never fire there).
	 * F10 -> back to edit mode; F11 -> close read-only.
	 */
	handleReadOnlyKey(msg: ReadOnlyKeyMessage): void {
		if (!isPrototypeOpen()) return;
		if (msg.key === "DECREASE_OPACITY") {
			adjustPrototypeOpacity(-POPOUT_OPACITY_STEP);
		} else if (msg.key === "INCREASE_OPACITY") {
			adjustPrototypeOpacity(POPOUT_OPACITY_STEP);
		} else if (msg.key === "F10") {
			// Carry the transparent window's current camera back into edit mode.
			this.pendingReadToEditView = msg.view ?? null;
			void this.toggleReadOnlyPrototype(null);
		} else if (msg.key === "F11") {
			void this.toggle(null);
		}
	}

	/**
	 * F10 does something only when there's a mode to switch between: a read-only
	 * window is up (switch back to edit), or this Board has a live PureRef popout
	 * (switch to read-only). With neither, F10 is a no-op (per the requirement
	 * that F10 do nothing when the PureRef window isn't open/initialized).
	 */
	canToggleReadOnlyPrototype(file: TFile | null): boolean {
		return isPrototypeOpen() || (file != null && this.isOpen(file.path));
	}

	/**
	 * F10 — swap between the editable PureRef popout and the read-only transparent
	 * window, in whichever direction applies:
	 *
	 * - read-only open  -> close it and reopen the editable popout for the same
	 *   Board, at the spot the user left the transparent window ("switch back to
	 *   edit mode").
	 * - popout open      -> close it and open the transparent read-only window at
	 *   the popout's geometry (the seamless swap).
	 * - neither          -> nothing.
	 */
	toggleReadOnlyPrototype(file: TFile | null): Promise<void> {
		return this.runTransition("switch Popout mode", () => this.toggleReadOnlyPrototypeNow(file));
	}

	private async toggleReadOnlyPrototypeNow(file: TFile | null): Promise<void> {
		if (isPrototypeOpen()) {
			const filePath = this.readOnlyFilePath;
			// Physical bounds so the reopened popout lands where the transparent
			// window is now, even if the user moved it (geometry store is physical).
			const physical = getPrototypeBounds();
			const opacity = getPrototypeOpacity();
			closePrototype();
			this.readOnlyFilePath = null;
			if (!filePath) return;
			const target = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (!(target instanceof TFile)) return;
			if (physical) await this.plugin.geometry.set(filePath, physical);
			const entry = this.openBoards.get(filePath);
			if (entry?.windowId != null) {
				if (physical) setWindowPhysicalBoundsById(entry.windowId, physical);
				showWindowById(entry.windowId);
				focusWindowById(entry.windowId);
				if (opacity != null) setWindowOpacityById(entry.windowId, opacity);
				if (this.pendingReadToEditView) {
					applySceneView(entry.leaf, this.pendingReadToEditView);
					this.pendingReadToEditView = null;
				}
				return;
			}
			await this.open(target, opacity ?? undefined);
			return;
		}

		// Edit -> read-only. Only valid when this Board actually has a live popout.
		if (!file || !this.isOpen(file.path)) return;
		const entry = this.openBoards.get(file.path);
		// getBounds() and the BrowserWindow constructor both speak DIP, so the
		// transparent window opens at the same on-screen place as the popout.
		const bounds = entry?.windowId != null ? getWindowBoundsById(entry.windowId) ?? undefined : undefined;
		const opacity = entry?.windowId != null ? getWindowOpacityById(entry.windowId) : null;

		// Persist the popout's latest edits before rendering the file to SVG, so
		// the read-only mirror shows exactly what the user was just editing.
		await this.saveLeafBoard(entry?.leaf ?? null);
		if (!entry || !this.isCurrent(file.path, entry) || entry.phase !== "ready") return;

		// While the popout is still live, capture its camera and the scene's
		// bounding-box top-left. The SVG normalizes content to (0,0) and records
		// no absolute position, so this min is what lets the window map SVG-local
		// pixels back to scene coordinates and frame the board identically.
		const sceneView = readSceneView(entry?.leaf ?? null);
		const elements = readSceneElements(entry?.leaf ?? null);
		const min = elements ? getSceneMin(this.plugin, elements) : null;
		// Local video/animated-media embeds export as empty regions in the SVG;
		// collect them so the transparent window can overlay live <video>/<img>.
		const media = elements ? collectMediaOverlays(this.plugin, elements, file.path) : [];

		this.readOnlyFilePath = file.path;
		// Create and focus the replacement first. Closing the focused editable
		// Popout before this point makes Windows activate Obsidian in the gap,
		// which can bring the main window onto another monitor. Once the read-only
		// window owns focus, the old Popout can close without exposing Obsidian.
		const opened = openPrototype(this.plugin, bounds, opacity ?? undefined);
		if (!opened) {
			this.readOnlyFilePath = null;
			return;
		}
		if (entry?.windowId != null) hideWindowById(entry.windowId);

		// Render the board in Obsidian's context (via the Excalidraw plugin) and
		// push it — with the scene offset and captured camera — into the
		// transparent window; setContent waits for load.
		const svg = await renderBoardSvg(this.plugin, file.path);
		if (svg && isPrototypeOpen() && this.readOnlyFilePath === file.path) {
			setPrototypeContent({
				svg,
				minX: min?.minX ?? 0,
				minY: min?.minY ?? 0,
				view: sceneView,
				media,
			});
		}
		this.refocusReadOnlyWindowAfterClose();
	}

	private refocusReadOnlyWindowAfterClose(): void {
		if (!isPrototypeOpen()) return;
		focusPrototypeWindow();
		window.setTimeout(() => {
			if (isPrototypeOpen()) focusPrototypeWindow();
		}, 100);
	}

	/** Best-effort save of an Excalidraw leaf's Board via its own view.save(). */
	private async saveLeafBoard(leaf: WorkspaceLeaf | null): Promise<void> {
		const view = leaf?.view as unknown as { save?: () => Promise<void> } | undefined;
		if (!view?.save) return;
		try {
			await view.save();
		} catch (error) {
			console.error("[Excalidraw PureRef] board save before read-only failed.", error);
		}
	}

	private async open(file: TFile, initialOpacity?: number): Promise<void> {
		if (this.pending) {
			new Notice("A PureRef popout is still opening — try again in a moment.");
			return;
		}
		if (!isExcalidrawPluginAvailable(this.plugin.app)) {
			new Notice("Excalidraw PureRef requires the Excalidraw plugin to be enabled and loaded.");
			return;
		}

		// Snapshot the originating (main-window) view's camera NOW, before opening
		// the Popout steals focus/active state, so a first-ever launch can mirror
		// it (per the "mirror on first launch, then persist" decision). Ignored
		// once this Board has a saved Popout viewport. null if the Board isn't
		// currently open in the main window.
		const sourceViewState = readMainWindowViewportForFile(this.plugin.app, file.path);

		const existingWindowIds = new Set(getBrowserWindowIds());
		// Placeholder entry stored BEFORE calling openPopoutLeaf(): Obsidian's
		// 'window-open' event fires synchronously from inside that call, before
		// it returns to us, so finalizePendingOpen() must already find this
		// entry in the map or every `if (entry)` block below silently no-ops
		// (this is what was breaking window-drag attachment).
		const entry: OpenBoardPopout = {
			leaf: null,
			phase: "opening",
			windowId: null,
			doc: null,
			detachWindowDrag: null,
			detachChromeHiding: null,
			detachDropBridge: null,
			detachBoundsSaving: null,
			detachPackKeys: null,
		};
		this.pending = {
			filePath: file.path,
			existingWindowIds,
			initialOpacity,
			timeoutId: null,
			doc: null,
			entry,
		};
		this.openBoards.set(file.path, entry);

		// Suppress Excalidraw's global zoom-to-fit-on-resize for as long as a
		// Popout is open, so RMB window-drag (which emits resize events on
		// Windows via Electron's setBounds) doesn't refit the board. Balanced
		// by resume() in handleWindowClosed(), and in the catch below if the
		// open fails before the window is ever marked. See excalidraw-settings.ts.
		this.refitSuspender.suspend();

		try {
			const leaf = this.plugin.app.workspace.openPopoutLeaf();
			entry.leaf = leaf;

			// The nested window-open event normally supplies the document before
			// openPopoutLeaf returns. Focus is still bounded and cancellable.
			await this.waitForPopoutFocus(entry.doc, FOCUS_WAIT_MAX_MS, entry);
			if (!this.isCurrent(file.path, entry)) return;

			// Force the Excalidraw view type explicitly instead of leaf.openFile(),
			// which lets Obsidian/Excalidraw choose the view. A Board file carrying
			// `excalidraw-open-md: true` frontmatter would otherwise open as plain
			// markdown, defeating the Popout. Excalidraw's own leaf patch only ever
			// upgrades markdown -> excalidraw, never the reverse, so pinning the
			// type here wins regardless of that frontmatter.
			await leaf.setViewState({
				type: EXCALIDRAW_VIEW_TYPE,
				state: { file: file.path },
				active: true,
			});
			if (!this.isCurrent(file.path, entry)) return;

			// Focus is grabbed here — after Excalidraw's view has mounted —
			// rather than during the pre-mount window-open handling. See the
			// comment in finalizePendingOpen() for why.
			if (entry.windowId != null) {
				focusWindowById(entry.windowId);
				if (initialOpacity != null) setWindowOpacityById(entry.windowId, initialOpacity);
			}

			// Nudge the canvas to its final size and set the startup camera — but
			// only once Excalidraw's API is actually live. setViewState resolves
			// well before that (mount + scene/image load runs on for a few hundred
			// ms more), so poking Excalidraw here directly would fire a resize and
			// updateScene INTO a half-loaded scene — a suspected cause of the
			// occasional "stuck on loading scene". finalizeCanvasWhenReady defers
			// both until the interface responds. This is part of the serialized open
			// transition: a queued close must not detach the leaf while Excalidraw is
			// still mounting.
			await this.finalizeCanvasWhenReady(entry, file.path, sourceViewState);
		} catch (error) {
			console.error("Excalidraw PureRef: failed to open board in popout.", error);
			if (this.isCurrent(file.path, entry)) new Notice("Failed to open PureRef popout.");
			this.abortOpen(file.path, entry);
		}
	}

	private close(filePath: string): void {
		const entry = this.openBoards.get(filePath);
		if (!entry) return;
		void this.finalizeClosedEntry(filePath, entry, entry.doc);
		try {
			entry.leaf?.detach();
		} catch (error) {
			console.error("[Excalidraw PureRef] failed to detach Popout leaf.", error);
		}
	}

	/** Wired to app.workspace.on('window-open', ...) in main.ts. */
	handleWindowOpened(win: WorkspaceWindow): void {
		if (!this.pending) return;
		// The synchronous event from openPopoutLeaf claims this pending open.
		// Ignore unrelated windows that open while native id detection retries.
		if (this.pending.doc && this.pending.doc !== win.doc) return;
		this.pending.doc = win.doc;
		// Stash the doc onto the entry immediately — before windowId detection
		// (which may take retries) — so open()'s focus-wait can observe the
		// popout window as soon as it exists.
		const entry = this.pending.entry;
		if (this.isCurrent(this.pending.filePath, entry)) entry.doc = win.doc;
		this.finalizePendingOpen(win.doc);
	}

	/**
	 * Resolve once the popout window has actually become the focused/active
	 * window, or after `maxMs` as a hard cap. This replaces a blind fixed
	 * delay: Excalidraw binds its pointer/wheel listeners to whatever window
	 * is active at mount time, so mounting it (via openFile) before the new
	 * popout has taken focus makes it track the wrong window — the root cause
	 * of the "app doesn't know where the mouse is" bug. `document.hasFocus()`
	 * is the direct OS/Chromium-level truth of that condition.
	 *
	 * Polled on the popout's OWN requestAnimationFrame (which only runs once
	 * that window's compositor is live), with an independent setTimeout on the
	 * main window as a guaranteed fallback in case focus never lands (which
	 * would otherwise throttle the popout's rAF and stall the poll).
	 */
	private waitForPopoutFocus(doc: Document | null, maxMs: number, entry: OpenBoardPopout): Promise<void> {
		return new Promise<void>((resolve) => {
			const view = doc?.defaultView;
			if (!doc || !view) {
				resolve();
				return;
			}
			// Proactively request focus rather than only waiting for it.
			view.focus();

			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				window.clearTimeout(hardCap);
				resolve();
			};
			const hardCap = window.setTimeout(finish, maxMs);
			const poll = () => {
				if (settled) return;
				if (entry.phase === "closing" || this.disposed) {
					finish();
					return;
				}
				if (doc.hasFocus()) {
					finish();
					return;
				}
				view.requestAnimationFrame(poll);
			};
			view.requestAnimationFrame(poll);
		});
	}

	/** Wired to app.workspace.on('window-close', ...) in main.ts. */
	async handleWindowClosed(win: WorkspaceWindow): Promise<void> {
		const filePath = getPopupFilePath(win.doc);
		if (!filePath) return;

		const entry = this.openBoards.get(filePath);
		// A late close from an older Popout for this Board must not remove a new
		// entry that happens to have the same file path.
		if (!entry || entry.doc !== win.doc) {
			clearPopupDocumentMarker(win.doc);
			return;
		}

		await this.finalizeClosedEntry(filePath, entry, win.doc);

		if (this.readOnlyFilePath === filePath && isPrototypeOpen()) {
			this.refocusReadOnlyWindowAfterClose();
		}

	}

	private async finalizeClosedEntry(
		filePath: string,
		entry: OpenBoardPopout,
		doc: Document | null,
	): Promise<void> {
		if (!this.isCurrent(filePath, entry)) return;
		entry.phase = "closing";
		// Both values must be captured before detach/close invalidates native and
		// Excalidraw state.
		const viewport = readViewport(entry.leaf);
		const bounds = entry.windowId == null ? null : getWindowPhysicalBoundsById(entry.windowId);
		this.releaseEntry(filePath, entry, doc);

		const writes: Promise<void>[] = [];
		if (viewport) writes.push(this.plugin.geometry.setViewport(filePath, viewport));
		if (bounds) writes.push(this.plugin.geometry.set(filePath, bounds));
		try {
			await Promise.all(writes);
		} catch (error) {
			console.error("[Excalidraw PureRef] failed to persist Popout state.", error);
		}
	}

	private releaseEntry(filePath: string, entry: OpenBoardPopout, doc: Document | null): void {
		if (this.openBoards.get(filePath) === entry) this.openBoards.delete(filePath);
		if (this.pending?.entry === entry) {
			if (this.pending.timeoutId != null) window.clearTimeout(this.pending.timeoutId);
			this.pending = null;
		}
		if (doc) clearPopupDocumentMarker(doc);
		entry.detachWindowDrag?.();
		entry.detachChromeHiding?.();
		entry.detachDropBridge?.();
		entry.detachBoundsSaving?.();
		entry.detachPackKeys?.();
		entry.detachWindowDrag = null;
		entry.detachChromeHiding = null;
		entry.detachDropBridge = null;
		entry.detachBoundsSaving = null;
		entry.detachPackKeys = null;
		this.refitSuspender.resume();
	}

	private abortOpen(filePath: string, entry: OpenBoardPopout): void {
		if (!this.isCurrent(filePath, entry)) return;
		entry.phase = "closing";
		this.releaseEntry(filePath, entry, entry.doc);
		try {
			entry.leaf?.detach();
		} catch {
			// The window may already be tearing down.
		}
	}

	private persistWindowBounds(filePath: string, entry: OpenBoardPopout | undefined): void {
		if (entry?.windowId == null) return;
		const bounds = getWindowPhysicalBoundsById(entry.windowId);
		if (bounds) {
			void this.plugin.geometry.set(filePath, bounds).catch((error) => {
				console.error("[Excalidraw PureRef] failed to persist Popout bounds.", error);
			});
		}
	}

	/**
	 * Waits (on the reliable main-window timer, not the popout's rAF) for
	 * Excalidraw's canvas API to come alive, then does the two things that must
	 * happen against a live canvas: dispatch a synthetic resize so Excalidraw
	 * re-measures its container to the window's final size (it only measures once
	 * at mount and never re-measures on its own), and apply the startup camera.
	 * Doing this before the API is ready is both useless (our calls no-op) and
	 * harmful (poking a mid-load scene), so we gate on readiness. Bails out if the
	 * Popout is closed before the canvas ever comes up.
	 */
	private async finalizeCanvasWhenReady(
		entry: OpenBoardPopout,
		filePath: string,
		sourceViewState: ReturnType<typeof readMainWindowViewportForFile>,
	): Promise<void> {
		const win = entry.doc?.defaultView;
		if (!win) {
			if (this.isCurrent(filePath, entry)) {
				new Notice("PureRef popout did not receive an Obsidian window document.");
				this.abortOpen(filePath, entry);
			}
			return;
		}

		const start = performance.now();
		while (this.isCurrent(filePath, entry)) {
			if (isCanvasReady(entry.leaf)) break;
			if (performance.now() - start > CANVAS_READY_MAX_MS) break;
			await new Promise((r) => window.setTimeout(r, CANVAS_READY_POLL_MS));
		}

		if (!this.isCurrent(filePath, entry)) return;
		if (!isCanvasReady(entry.leaf)) {
			console.error("[Excalidraw PureRef] Excalidraw canvas did not initialize within the timeout.");
			new Notice("Excalidraw did not finish initializing the PureRef popout. The incomplete popout was closed.");
			this.abortOpen(filePath, entry);
			return;
		}

		win.dispatchEvent(new Event("resize"));
		// One frame so the resize has settled the canvas size before we set the
		// camera — otherwise Excalidraw's post-resize fit would clobber it.
		await new Promise<void>((resolve) => {
			let settled = false;
			const apply = () => {
				if (settled) return;
				settled = true;
				window.clearTimeout(hardCap);
				if (this.isCurrent(filePath, entry)) {
					enableZenMode(entry.leaf);
					// PureRef-style marquee: select anything the drag rectangle
					// touches rather than requiring it to fully enclose the element.
					enableOverlapSelection(entry.leaf);
					this.applyStartupViewport(entry.leaf, filePath, sourceViewState);
					entry.phase = "ready";
					// Restore native focus after mounting and applying the camera so the
					// user can keep working immediately.
					if (entry.windowId != null) focusWindowById(entry.windowId);
				}
				resolve();
			};
			// A hidden/minimized renderer can throttle its rAF. The main-window timer
			// guarantees the serialized transition still completes.
			const hardCap = window.setTimeout(apply, 1000);
			try {
				win.requestAnimationFrame(apply);
			} catch {
				apply();
			}
		});
	}

	/**
	 * Sets the Popout's initial camera once its canvas has mounted and settled.
	 * Priority: a previously-saved viewport for this Board (exact restore, since
	 * the window bounds were already restored to match) wins; otherwise, on a
	 * first-ever launch, mirror the main view's framing re-centered for the
	 * Popout's own size; otherwise leave Excalidraw's default fit alone.
	 */
	private applyStartupViewport(
		leaf: WorkspaceLeaf | null,
		filePath: string,
		sourceViewState: ReturnType<typeof readMainWindowViewportForFile>,
	): void {
		// Highest priority: a camera handed back from the read-only window on an
		// F10 switch, so edit mode resumes exactly where read mode was framed.
		if (this.pendingReadToEditView) {
			const view = this.pendingReadToEditView;
			this.pendingReadToEditView = null;
			if (applySceneView(leaf, view)) return;
		}
		const saved = this.plugin.geometry.getViewport(filePath);
		if (saved) {
			applyViewport(leaf, saved);
			return;
		}
		if (!sourceViewState) return;
		const size = readContainerSize(leaf);
		if (!size) {
			// Couldn't measure the Popout; fall back to copying the source camera
			// verbatim (top-left aligned rather than centered).
			applyViewport(leaf, {
				scrollX: sourceViewState.scrollX,
				scrollY: sourceViewState.scrollY,
				zoom: sourceViewState.zoom,
			});
			return;
		}
		applyViewport(leaf, mirrorViewport(sourceViewState, size.width, size.height));
	}

	dispose(): void {
		this.disposed = true;
		if (this.pending?.timeoutId != null) {
			window.clearTimeout(this.pending.timeoutId);
		}
		this.pending = null;
		const leaves = Array.from(this.openBoards.values(), (entry) => entry.leaf).filter(
			(leaf): leaf is WorkspaceLeaf => leaf !== null,
		);
		for (const entry of this.openBoards.values()) {
			entry.phase = "closing";
			if (entry.doc) clearPopupDocumentMarker(entry.doc);
			entry.detachWindowDrag?.();
			entry.detachChromeHiding?.();
			entry.detachDropBridge?.();
			entry.detachBoundsSaving?.();
			entry.detachPackKeys?.();
		}
		this.openBoards.clear();
		// If unload lands during setViewState/Excalidraw mount, detaching in the
		// middle of that transition can leave Obsidian's renderer unusable. Queued
		// tasks observe disposed and exit; detach only after the active task settles.
		void this.transitionQueue.then(() => {
			for (const leaf of leaves) {
				try {
					leaf.detach();
				} catch {
					// The workspace may already be tearing down.
				}
			}
		});
		// Don't leave the transparent prototype window orphaned after unload.
		closePrototype();
		this.readOnlyFilePath = null;
		// Don't leave the user's Excalidraw setting flipped off after unload.
		this.refitSuspender.reset();
	}

	private finalizePendingOpen(doc: Document, attempt = 0): void {
		if (!this.pending) return;
		if (this.pending.doc !== doc) return;
		const { filePath, existingWindowIds, initialOpacity, entry } = this.pending;

		const correlatedWindowId = getBrowserWindowIdForDomWindow(doc.defaultView);
		const newWindowId =
			correlatedWindowId != null && !existingWindowIds.has(correlatedWindowId)
				? correlatedWindowId
				: findNewBrowserWindowId(existingWindowIds);
		if (newWindowId == null) {
			if (attempt >= FINALIZE_MAX_ATTEMPTS) {
				console.error(
					"[Excalidraw PureRef] could not identify the new popout window after",
					FINALIZE_MAX_ATTEMPTS,
					"attempts. current ids:",
					getBrowserWindowIds(),
				);
				new Notice(
					"Excalidraw PureRef: couldn't detect the popout's window — always-on-top, chrome " +
						"hiding, and window drag were not applied. Electron window access may be " +
						"unavailable in this build (see console for details).",
				);
				this.abortOpen(filePath, entry);
				return;
			}
			this.pending.timeoutId = window.setTimeout(
				() => this.finalizePendingOpen(doc, attempt + 1),
				FINALIZE_RETRY_DELAY_MS,
			);
			return;
		}

		console.log("[Excalidraw PureRef] identified new popout window id:", newWindowId);
		this.pending = null;

		if (!this.isCurrent(filePath, entry)) return;
		entry.windowId = newWindowId;
		entry.doc = doc;

		markPopupDocument(doc, filePath);
		doc.body.classList.add(CHROME_HIDDEN_CLASS);

		entry.detachWindowDrag = attachWindowDrag(doc, newWindowId);
		entry.detachChromeHiding = applyChromeHiding(doc);
		entry.detachDropBridge = attachPopoutDropBridge(doc);
		if (doc.defaultView) entry.detachPackKeys = attachPackKeydown(doc.defaultView, this.plugin.app);
		entry.detachBoundsSaving = onWindowCloseById(newWindowId, () =>
			this.persistWindowBounds(filePath, entry),
		);

		setWindowAlwaysOnTopById(newWindowId, true);
		if (initialOpacity != null) setWindowOpacityById(newWindowId, initialOpacity);
		// focusWindowById is deliberately NOT called here: this runs during the
		// synchronous 'window-open' handling, before leaf.openFile() has even
		// been called (Excalidraw hasn't mounted yet). Forcing OS focus this
		// early is a suspect for the mouse-tracking bug (see open()'s post-
		// openFile focus call below) — Excalidraw may be latching onto the
		// wrong window as "active" for its own pointer-tracking listener if
		// focus changes before its view exists.

		const savedBounds = this.plugin.geometry.get(filePath);
		if (savedBounds) {
			setWindowPhysicalBoundsById(newWindowId, savedBounds);
		}
	}
}
