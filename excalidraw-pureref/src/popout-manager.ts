import { Notice, TFile, WorkspaceLeaf, WorkspaceWindow } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import {
	getBrowserWindowIds,
	findNewBrowserWindowId,
	setWindowAlwaysOnTopById,
	focusWindowById,
	getWindowBoundsById,
	setWindowBoundsById,
} from "./electron";
import { markPopupDocument, getPopupFilePath, clearPopupDocumentMarker } from "./document-marker";
import { attachWindowDrag } from "./window-drag";
import { applyChromeHiding } from "./chrome-hider";

/** Applied to a Popout window's <body>; see styles.css for what it hides. */
export const CHROME_HIDDEN_CLASS = "epr-popout-mode";

const FINALIZE_MAX_ATTEMPTS = 10;
const FINALIZE_RETRY_DELAY_MS = 75;

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

	constructor(private readonly plugin: ExcalidrawPureRefPlugin) {}

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
		console.log("[Excalidraw PureRef] open(): existing browser window ids:", [...existingWindowIds]);
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

		const leaf = this.plugin.app.workspace.openPopoutLeaf();
		console.log("[Excalidraw PureRef] open(): openPopoutLeaf() returned a leaf, calling openFile()");
		entry.leaf = leaf;

		// EXPERIMENTAL: a fixed pause here, before Excalidraw mounts via
		// openFile(), tests the theory that Obsidian's own "this new popout
		// window is now active" bookkeeping needs time to settle before
		// Excalidraw's mount-time setup asks which window is active — real
		// testing showed the bug is intermittent and correlates with how long
		// the popout takes to initialize (slower init = correct behavior).
		console.log("[Excalidraw PureRef] open(): pausing before openFile() to let window-activation settle");
		await new Promise((resolve) => window.setTimeout(resolve, 150));

		try {
			await leaf.openFile(file, { active: true });
			console.log("[Excalidraw PureRef] open(): openFile() resolved");

			// Focus is grabbed here — after Excalidraw's view has mounted —
			// rather than during the pre-mount window-open handling. See the
			// comment in finalizePendingOpen() for why.
			if (entry.windowId != null) {
				const focusResult = focusWindowById(entry.windowId);
				console.log("[Excalidraw PureRef] post-mount focusWindowById:", focusResult);
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
						console.log("[Excalidraw PureRef] dispatched synthetic resize event in popout");
					});
				});
			}
		} catch (error) {
			console.error("Excalidraw PureRef: failed to open board in popout.", error);
			new Notice("Failed to open PureRef popout.");
			this.openBoards.delete(file.path);
			this.pending = null;
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
		console.log("[Excalidraw PureRef] handleWindowOpened() fired. pending =", this.pending?.filePath ?? null);
		if (!this.pending) return;
		this.finalizePendingOpen(win.doc);
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

		if (entry?.windowId != null) {
			const bounds = getWindowBoundsById(entry.windowId);
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
	}

	private finalizePendingOpen(doc: Document, attempt = 0): void {
		if (!this.pending) return;
		const { filePath, existingWindowIds } = this.pending;

		const currentIds = getBrowserWindowIds();
		console.log(
			`[Excalidraw PureRef] finalizePendingOpen() attempt ${attempt}: current window ids =`,
			currentIds,
			"existing (before open) =",
			[...existingWindowIds],
		);
		const newWindowId = findNewBrowserWindowId(existingWindowIds);
		if (newWindowId == null) {
			if (attempt >= FINALIZE_MAX_ATTEMPTS) {
				console.error(
					"[Excalidraw PureRef] could not identify the new popout window after",
					FINALIZE_MAX_ATTEMPTS,
					"attempts. current ids:",
					currentIds,
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
		console.log("[Excalidraw PureRef] added chrome-hidden class to popout body:", doc.body.className);

		if (entry) {
			entry.detachWindowDrag = attachWindowDrag(doc, newWindowId);
			entry.detachChromeHiding = applyChromeHiding(doc);
			console.log("[Excalidraw PureRef] applied inline chrome hiding + window drag");
		}

		const alwaysOnTopResult = setWindowAlwaysOnTopById(newWindowId, true);
		console.log("[Excalidraw PureRef] setWindowAlwaysOnTopById:", alwaysOnTopResult);
		// focusWindowById is deliberately NOT called here: this runs during the
		// synchronous 'window-open' handling, before leaf.openFile() has even
		// been called (Excalidraw hasn't mounted yet). Forcing OS focus this
		// early is a suspect for the mouse-tracking bug (see open()'s post-
		// openFile focus call below) — Excalidraw may be latching onto the
		// wrong window as "active" for its own pointer-tracking listener if
		// focus changes before its view exists.

		const savedBounds = this.plugin.geometry.get(filePath);
		if (savedBounds) {
			const boundsResult = setWindowBoundsById(newWindowId, savedBounds);
			console.log("[Excalidraw PureRef] restored saved bounds:", savedBounds, "result:", boundsResult);
		}
	}
}
