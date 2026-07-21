import { Notice, TFile, WorkspaceLeaf, WorkspaceWindow } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import {
	getBrowserWindowIds,
	findNewBrowserWindowId,
	setWindowAlwaysOnTopById,
	focusWindowById,
	getWindowPhysicalBoundsById,
	setWindowPhysicalBoundsById,
	onWindowCloseById,
} from "./electron";
import { markPopupDocument, getPopupFilePath, clearPopupDocumentMarker } from "./document-marker";
import { attachWindowDrag } from "./window-drag";
import { applyChromeHiding } from "./chrome-hider";
import { openWithTransparentHost, logTransparentHostSnapshot } from "./transparent-host";
import { ExcalidrawRefitSuspender } from "./excalidraw-settings";
import {
	EXCALIDRAW_VIEW_TYPE,
	readViewport,
	applyViewport,
	enableZenMode,
	readMainWindowViewportForFile,
	readContainerSize,
	mirrorViewport,
	readPresentationState,
	applyPresentationState,
	type ExcalidrawPresentationState,
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
const CANVAS_READY_MAX_MS = 3000;
/** Poll interval for the canvas-ready wait, on the main-window timer. */
const CANVAS_READY_POLL_MS = 16;

let diagnosticSequence = 0;
function trace(stage: string, data: unknown = {}): void {
	console.log(`[EPR popout ${++diagnosticSequence}] ${stage} ${JSON.stringify(data)}`);
}

function inspectRenderedLayers(doc: Document): Record<string, unknown> {
	const view = doc.defaultView;
	const selectors = [
		"html", "body", ".app-container", ".horizontal-main-container", ".workspace",
		".workspace-tabs", ".workspace-leaf", ".workspace-leaf-content", ".view-content",
		".excalidraw-wrapper", ".excalidraw",
	];
	const layers = selectors.map((selector) => {
		const element = doc.querySelector<HTMLElement>(selector);
		if (!element || !view) return { selector, present: false };
		const computed = view.getComputedStyle(element);
		return {
			selector,
			present: true,
			computedBackground: computed.backgroundColor,
			display: computed.display,
			opacity: computed.opacity,
		};
	});
	const canvases = Array.from(doc.querySelectorAll<HTMLCanvasElement>("canvas")).map((canvas) => {
		let cornerPixel: number[] | string = "unread";
		try {
			const context = canvas.getContext("2d", { willReadFrequently: true });
			cornerPixel = context ? Array.from(context.getImageData(0, 0, 1, 1).data) : "no-2d-context";
		} catch (error) {
			cornerPixel = `error: ${String(error)}`;
		}
		return {
			className: canvas.className,
			width: canvas.width,
			height: canvas.height,
			cssWidth: canvas.getBoundingClientRect().width,
			cssHeight: canvas.getBoundingClientRect().height,
			computedBackground: view?.getComputedStyle(canvas).backgroundColor,
			cornerPixel,
		};
	});
	const isTransparent = (color: unknown): boolean => {
		if (typeof color !== "string") return false;
		const normalized = color.replace(/\s/g, "").toLowerCase();
		return normalized === "transparent" || normalized === "rgba(0,0,0,0)";
	};
	return {
		readyState: doc.readyState,
		hasFocus: doc.hasFocus(),
		presentLayerCount: layers.filter((layer) => layer.present).length,
		missingLayers: layers.filter((layer) => !layer.present).map((layer) => layer.selector),
		nonTransparentLayers: layers.filter((layer) =>
			layer.present && !isTransparent(layer.computedBackground)),
		canvases,
	};
}

interface OpenBoardPopout {
	leaf: WorkspaceLeaf;
	windowId: number | null;
	doc: Document | null;
	detachWindowDrag: (() => void) | null;
	detachChromeHiding: (() => void) | null;
	detachBoundsSaving: (() => void) | null;
	transparentHostProbe: boolean;
	previousPresentation: ExcalidrawPresentationState | null;
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

	async toggleTransparentHostProbe(file: TFile): Promise<void> {
		trace("toggleTransparentHostProbe.enter", { filePath: file.path, alreadyOpen: this.openBoards.has(file.path) });
		const existing = this.openBoards.get(file.path);
		if (existing?.transparentHostProbe) {
			this.close(file.path);
			return;
		}
		if (existing) {
			this.close(file.path);
			const deadline = performance.now() + 2000;
			while (this.openBoards.has(file.path) && performance.now() < deadline) {
				await new Promise((resolve) => window.setTimeout(resolve, 25));
			}
			if (this.openBoards.has(file.path)) {
				new Notice("The existing Popout did not finish closing; try F10 again.");
				return;
			}
		}
		await this.open(file, true);
	}

	private async open(file: TFile, transparentHostProbe = false): Promise<void> {
		trace("open.enter", { filePath: file.path, transparentHostProbe });
		if (this.pending) {
			new Notice("A PureRef popout is still opening — try again in a moment.");
			return;
		}

		// Snapshot the originating (main-window) view's camera NOW, before opening
		// the Popout steals focus/active state, so a first-ever launch can mirror
		// it (per the "mirror on first launch, then persist" decision). Ignored
		// once this Board has a saved Popout viewport. null if the Board isn't
		// currently open in the main window.
		const sourceViewState = readMainWindowViewportForFile(this.plugin.app, file.path);

		const existingWindowIds = new Set(getBrowserWindowIds());
		trace("open.browser-windows.before", { ids: Array.from(existingWindowIds) });
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
			detachBoundsSaving: null,
			transparentHostProbe,
			previousPresentation: null,
		};
		this.openBoards.set(file.path, entry);

		// Suppress Excalidraw's global zoom-to-fit-on-resize for as long as a
		// Popout is open, so RMB window-drag (which emits resize events on
		// Windows via Electron's setBounds) doesn't refit the board. Balanced
		// by resume() in handleWindowClosed(), and in the catch below if the
		// open fails before the window is ever marked. See excalidraw-settings.ts.
		this.refitSuspender.suspend();

		let leaf: WorkspaceLeaf;
		try {
			trace("openPopoutLeaf.call", { transparentHostProbe });
			leaf = transparentHostProbe
				? openWithTransparentHost(this.plugin, () => this.plugin.app.workspace.openPopoutLeaf())
				: this.plugin.app.workspace.openPopoutLeaf();
		} catch (error) {
			console.error("[Excalidraw PureRef] transparent WebContentsView host failed:", error);
			new Notice("Transparent WebContentsView host failed; see the developer console.");
			this.openBoards.delete(file.path);
			this.pending = null;
			this.refitSuspender.resume();
			return;
		}
		entry.leaf = leaf;
		trace("openPopoutLeaf.result", {
			viewType: leaf.view.getViewType(),
			documentCaptured: Boolean(entry.doc),
			windowId: entry.windowId,
		});

		// Wait for the popout to actually become the focused window before
		// mounting Excalidraw into it via openFile() — see waitForPopoutFocus
		// for why. 'window-open' fires synchronously inside openPopoutLeaf()
		// above, so entry.doc is already populated by the time we get here.
		await this.waitForPopoutFocus(entry.doc, FOCUS_WAIT_MAX_MS);
		trace("open.focus-wait.finished", { hasFocus: entry.doc?.hasFocus(), windowId: entry.windowId });

		try {
			trace("setViewState.begin", { filePath: file.path });
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
			trace("setViewState.resolved", { viewType: leaf.view.getViewType(), windowId: entry.windowId });

			// Focus is grabbed here — after Excalidraw's view has mounted —
			// rather than during the pre-mount window-open handling. See the
			// comment in finalizePendingOpen() for why.
			if (entry.windowId != null) {
				focusWindowById(entry.windowId);
			}

			// Nudge the canvas to its final size and set the startup camera — but
			// only once Excalidraw's API is actually live. setViewState resolves
			// well before that (mount + scene/image load runs on for a few hundred
			// ms more), so poking Excalidraw here directly would fire a resize and
			// updateScene INTO a half-loaded scene — a suspected cause of the
			// occasional "stuck on loading scene". finalizeCanvasWhenReady defers
			// both until the API responds. Fire-and-forget; it self-cancels if the
			// Popout is closed while still loading.
			void this.finalizeCanvasWhenReady(entry, file.path, sourceViewState);
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
		// `leaf.detach()` tears down the Electron window before Obsidian delivers
		// `window-close` in current builds, so snapshot bounds while the window is
		// still addressable. Native close still uses the handler below as a fallback.
		this.persistWindowBounds(filePath, entry);
		// Detaching the leaf closes the popout window (it's the only leaf in
		// it). State cleanup remains in handleWindowClosed().
		entry.leaf.detach();
	}

	/** Wired to app.workspace.on('window-open', ...) in main.ts. */
	handleWindowOpened(win: WorkspaceWindow): void {
		trace("workspace.window-open", {
			pending: this.pending?.filePath ?? null,
			readyState: win.doc.readyState,
		});
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
		// Capture the Popout's final camera while its view is still mounted — this
		// 'window-close' handler fires early enough that excalidrawAPI is still
		// live (verified). Reopening restores this exact framing.
		const viewport = readViewport(entry?.leaf ?? null);
		if (entry?.transparentHostProbe && entry.previousPresentation) {
			applyPresentationState(entry.leaf, entry.previousPresentation);
		}

		this.openBoards.delete(filePath);
		clearPopupDocumentMarker(win.doc);
		entry?.detachWindowDrag?.();
		entry?.detachChromeHiding?.();
		entry?.detachBoundsSaving?.();
		// Restore Excalidraw's zoom-to-fit-on-resize once the last Popout closes.
		this.refitSuspender.resume();

		if (viewport) {
			await this.plugin.geometry.setViewport(filePath, viewport);
		}

		this.persistWindowBounds(filePath, entry);
	}

	private persistWindowBounds(filePath: string, entry: OpenBoardPopout | undefined): void {
		if (entry?.windowId == null) return;
		const bounds = getWindowPhysicalBoundsById(entry.windowId);
		if (bounds) void this.plugin.geometry.set(filePath, bounds);
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
		if (!win) return;

		const start = performance.now();
		trace("canvas.wait.begin", { filePath, transparentHostProbe: entry.transparentHostProbe });
		while (this.openBoards.get(filePath) === entry) {
			// readContainerSize returns non-null only once excalidrawAPI is live.
			if (readContainerSize(entry.leaf) !== null) break;
			if (performance.now() - start > CANVAS_READY_MAX_MS) break;
			await new Promise((r) => window.setTimeout(r, CANVAS_READY_POLL_MS));
		}

		// The Popout may have been closed while we were waiting.
		if (this.openBoards.get(filePath) !== entry) return;
		trace("canvas.wait.finished", {
			filePath,
			elapsedMs: Math.round(performance.now() - start),
			containerSize: readContainerSize(entry.leaf),
		});

		win.dispatchEvent(new Event("resize"));
		// One frame so the resize has settled the canvas size before we set the
		// camera — otherwise Excalidraw's post-resize fit would clobber it.
		win.requestAnimationFrame(() => {
			if (this.openBoards.get(filePath) !== entry) return;
			enableZenMode(entry.leaf);
			if (entry.transparentHostProbe) {
				entry.previousPresentation = readPresentationState(entry.leaf);
				trace("transparency.before", {
					presentation: entry.previousPresentation,
					document: entry.doc ? inspectRenderedLayers(entry.doc) : null,
				});
				const applied = applyPresentationState(entry.leaf, {
					viewBackgroundColor: "transparent",
					gridModeEnabled: false,
					gridSize: 0,
				});
				trace("transparency.updateScene.returned", { applied });
				win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
					trace("transparency.after-two-frames", {
						presentation: readPresentationState(entry.leaf),
						document: entry.doc ? inspectRenderedLayers(entry.doc) : null,
					});
					logTransparentHostSnapshot("after-transparency-two-frames");
				}));
			}
			this.applyStartupViewport(entry.leaf, filePath, sourceViewState);
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
		leaf: WorkspaceLeaf,
		filePath: string,
		sourceViewState: ReturnType<typeof readMainWindowViewportForFile>,
	): void {
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
		trace("window-id.detect", {
			attempt,
			before: Array.from(existingWindowIds),
			current: getBrowserWindowIds(),
			found: newWindowId,
		});
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
			entry.detachChromeHiding = applyChromeHiding(doc, entry.transparentHostProbe);
			trace("chrome-hiding.applied", {
				transparentHostProbe: entry.transparentHostProbe,
				document: inspectRenderedLayers(doc),
			});
			entry.detachBoundsSaving = onWindowCloseById(newWindowId, () =>
				this.persistWindowBounds(filePath, entry),
			);
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
