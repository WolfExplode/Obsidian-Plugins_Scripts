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

/** Applied to a Popout window's <body>; see styles.css for what it hides. */
export const CHROME_HIDDEN_CLASS = "epr-popout-mode";

const FINALIZE_MAX_ATTEMPTS = 10;
const FINALIZE_RETRY_DELAY_MS = 75;

interface OpenBoardPopout {
	leaf: WorkspaceLeaf;
	windowId: number | null;
	doc: Document | null;
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
		this.pending = { filePath: file.path, existingWindowIds, timeoutId: null };

		const leaf = this.plugin.app.workspace.openPopoutLeaf();
		this.openBoards.set(file.path, { leaf, windowId: null, doc: null });

		try {
			await leaf.openFile(file, { active: true });
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

		const newWindowId = findNewBrowserWindowId(existingWindowIds);
		if (newWindowId == null) {
			if (attempt >= FINALIZE_MAX_ATTEMPTS) {
				console.error("Excalidraw PureRef: could not identify the new popout window.");
				this.pending = null;
				return;
			}
			this.pending.timeoutId = window.setTimeout(
				() => this.finalizePendingOpen(doc, attempt + 1),
				FINALIZE_RETRY_DELAY_MS,
			);
			return;
		}

		this.pending = null;

		const entry = this.openBoards.get(filePath);
		if (entry) {
			entry.windowId = newWindowId;
			entry.doc = doc;
		}

		markPopupDocument(doc, filePath);
		doc.body.classList.add(CHROME_HIDDEN_CLASS);

		setWindowAlwaysOnTopById(newWindowId, true);
		focusWindowById(newWindowId);

		const savedBounds = this.plugin.geometry.get(filePath);
		if (savedBounds) {
			setWindowBoundsById(newWindowId, savedBounds);
		}
	}
}
