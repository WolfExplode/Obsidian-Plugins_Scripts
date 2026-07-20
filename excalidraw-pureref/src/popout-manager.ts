import { Notice, TFile, WorkspaceLeaf, WorkspaceWindow } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import {
	getBrowserWindowIds,
	findNewBrowserWindowId,
	setWindowAlwaysOnTopById,
	focusWindowById,
	getWindowPhysicalBoundsById,
	setWindowPhysicalBoundsById,
} from "./electron";
import { markPopupDocument, getPopupFilePath, clearPopupDocumentMarker } from "./document-marker";
import { attachWindowDrag } from "./window-drag";
import { applyChromeHiding } from "./chrome-hider";
import { ExcalidrawRefitSuspender } from "./excalidraw-settings";

/** Applied to a Popout window's <body>; see styles.css for what it hides. */
export const CHROME_HIDDEN_CLASS = "epr-popout-mode";

const FINALIZE_MAX_ATTEMPTS = 10;
const FINALIZE_RETRY_DELAY_MS = 75;
/** Hard cap for waitForPopoutFocus; normal resolution is a frame or two. */
const FOCUS_WAIT_MAX_MS = 1000;

interface OpenBoardPopout {
	leaf: WorkspaceLeaf;
	windowId: number | null;
	doc: Document | null;
	detachWindowDrag: (() => void) | null;
	detachChromeHiding: (() => void) | null;
}

interface PendingOpen {
	filePath: string;
	existingWindowIds: Set<number>;
	timeoutId: number | null;
}

/**
 * Owns the F11 lifecycle described in CONTEXT.md's "Popout" entry: F11 in an
 * Excalidraw view (main window or an existing Popout, it makes no
 * difference — see the toggle logic below) opens a Board's Popout if none
 * exists, or closes it if one does. Every close path — F11 or the native OS
 * close button — is funneled through the same 'window-close' handling so
 * tracked state and persisted geometry stay consistent regardless of cause
 * (per the Question 12 decision).
 */
export class PopoutManager {
	private readonly openBoards = new Map<string, OpenBoardPopout>();
	private pending: PendingOpen | null = null;
	private readonly refitSuspender: ExcalidrawRefitSuspender;

	constructor(private readonly plugin: ExcalidrawPureRefPlugin) {
		this.refitSuspender = new ExcalidrawRefitSuspender(plugin.app);
	}

	isOpen(filePath: string): boolean {
		return this.openBoards.has(filePath);
	}

	/**
	 * The single entry point for the F11 command. Because a Popout is just a
	 * second Excalidraw view of the same file, "F11 in the main view" and
	 * "F11 inside the Popout" both reduce to the same rule: closed -> open,
	 * open -> closed. There is no need to special-case which window the
	 * keypress came from.
	 */
	async toggle(file: TFile): Promise<void> {
		if (this.openBoards.has(file.path)) {
			this.close(file.path);
			return;
		}
		await this.open(file);
	}

	private async open(file: TFile): Promise<void> {
		if (this.pending) {
			new Notice("A PureRef popout is still opening — try again in a moment.");
			return;
		}

		const existingWindowIds = new Set(getBrowserWindowIds());
		this.pending = { filePath: file.path, existingWindowIds, timeoutId: null };

		// Placeholder entry stored BEFORE calling openPopoutLeaf(): Obsidian's
		// 'window-open' event fires synchronously from inside that call, before
		// it returns to us, so finalizePendingOpen() must already find this
		// entry in the map or every `if (entry)` block below silently no-ops
		// (this is what was breaking window-drag attachment).
		const entry: OpenBoardPopout = {
			leaf: null as unknown as WorkspaceLeaf,
			windowId: null,
			doc: null,
			detachWindowDrag: null,
			detachChromeHiding: null,
		};
		this.openBoards.set(file.path, entry);

		// Suppress Excalidraw's global zoom-to-fit-on-resize for as long as a
		// Popout is open, so RMB window-drag (which emits resize events on
		// Windows via Electron's setBounds) doesn't refit the board. Balanced
		// by resume() in handleWindowClosed(), and in the catch below if the
		// open fails before the window is ever marked. See excalidraw-settings.ts.
		this.refitSuspender.suspend();

		const leaf = this.plugin.app.workspace.openPopoutLeaf();
		entry.leaf = leaf;

		// Wait for the popout to actually become the focused window before
		// mounting Excalidraw into it via openFile() — see waitForPopoutFocus
		// for why. 'window-open' fires synchronously inside openPopoutLeaf()
		// above, so entry.doc is already populated by the time we get here.
		await this.waitForPopoutFocus(entry.doc, FOCUS_WAIT_MAX_MS);

		try {
			await leaf.openFile(file, { active: true });

			// Focus is grabbed here — after Excalidraw's view has mounted —
			// rather than during the pre-mount window-open handling. See the
			// comment in finalizePendingOpen() for why.
			if (entry.windowId != null) {
				focusWindowById(entry.windowId);
			}

			// finalizePendingOpen() (window-open handling: chrome hiding, bounds
			// restore, always-on-top) runs BEFORE this openFile() call even
			// starts, since 'window-open' fires synchronously inside
			// openPopoutLeaf(). Excalidraw's canvas then mounts into a window
			// whose size may still be settling (especially right after we
			// restore saved geometry), and Excalidraw only measures its
			// container once at mount to compute initial canvas size/zoom — it
			// doesn't re-measure later on its own. A synthetic resize event
			// after mount nudges it to recompute against the window's final
			// size, matching what naturally happens on a fresh window open
			// (which is why closing and reopening "fixes" it).
			const popoutWindow = entry.doc?.defaultView;
			if (popoutWindow) {
				popoutWindow.requestAnimationFrame(() => {
					popoutWindow.requestAnimationFrame(() => {
						popoutWindow.dispatchEvent(new Event("resize"));
					});
				});
			}
		} catch (error) {
			console.error("Excalidraw PureRef: failed to open board in popout.", error);
			new Notice("Failed to open PureRef popout.");
			this.openBoards.delete(file.path);
			this.pending = null;
			// The window was never marked, so handleWindowClosed() would early-
			// return and never resume — balance the suspend() from above here.
			this.refitSuspender.resume();
		}
	}

	private close(filePath: string): void {
		const entry = this.openBoards.get(filePath);
		if (!entry) return;
		// Detaching the leaf closes the popout window (it's the only leaf in
		// it). Actual state cleanup + geometry persistence happens in
		// handleWindowClosed, not here — see the class doc comment.
		entry.leaf.detach();
	}

	/** Wired to app.workspace.on('window-open', ...) in main.ts. */
	handleWindowOpened(win: WorkspaceWindow): void {
		if (!this.pending) return;
		// Stash the doc onto the entry immediately — before windowId detection
		// (which may take retries) — so open()'s focus-wait can observe the
		// popout window as soon as it exists.
		const entry = this.openBoards.get(this.pending.filePath);
		if (entry) entry.doc = win.doc;
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
	private waitForPopoutFocus(doc: Document | null, maxMs: number): Promise<void> {
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
		this.openBoards.delete(filePath);
		clearPopupDocumentMarker(win.doc);
		entry?.detachWindowDrag?.();
		entry?.detachChromeHiding?.();
		// Restore Excalidraw's zoom-to-fit-on-resize once the last Popout closes.
		this.refitSuspender.resume();

		if (entry?.windowId != null) {
			const bounds = getWindowPhysicalBoundsById(entry.windowId);
			if (bounds) {
				await this.plugin.geometry.set(filePath, bounds);
			}
		}
	}

	dispose(): void {
		if (this.pending?.timeoutId != null) {
			window.clearTimeout(this.pending.timeoutId);
		}
		this.pending = null;
		this.openBoards.clear();
		// Don't leave the user's Excalidraw setting flipped off after unload.
		this.refitSuspender.reset();
	}

	private finalizePendingOpen(doc: Document, attempt = 0): void {
		if (!this.pending) return;
		const { filePath, existingWindowIds } = this.pending;

		const newWindowId = findNewBrowserWindowId(existingWindowIds);
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
				this.pending = null;
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

		const entry = this.openBoards.get(filePath);
		if (entry) {
			entry.windowId = newWindowId;
			entry.doc = doc;
		}

		markPopupDocument(doc, filePath);
		doc.body.classList.add(CHROME_HIDDEN_CLASS);

		if (entry) {
			entry.detachWindowDrag = attachWindowDrag(doc, newWindowId);
			entry.detachChromeHiding = applyChromeHiding(doc);
		}

		setWindowAlwaysOnTopById(newWindowId, true);
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
