import { getWindowBoundsById, setWindowBoundsById, type ElectronBounds } from "./electron";

const DRAG_THRESHOLD_PX = 4;

interface DragState {
	startScreenX: number;
	startScreenY: number;
	startBounds: ElectronBounds;
	dragging: boolean;
	rafId: number | null;
	pendingDelta: { dx: number; dy: number } | null;
}

/**
 * PureRef-style "hold right mouse button and drag to move the window
 * itself." Only ever attached to a Popout's document (wired up in
 * popout-manager.ts) — real PureRef's own defining interaction, and one we
 * only want active while PureRef mode is on, never in the normal Excalidraw
 * view where right-click still needs to open Excalidraw's own context menu.
 *
 * A plain right-click (no movement past the threshold) is left alone so
 * Excalidraw's context menu still opens as normal; only once the user has
 * actually dragged do we take over and suppress the contextmenu event that
 * would otherwise fire on release.
 */
export function attachWindowDrag(doc: Document, windowId: number): () => void {
	// Use the Popout's own `window`, not this module's global `window` (the
	// main Obsidian window it actually executes in as shared same-origin
	// JS). Chromium throttles/suspends rAF for a minimized/hidden window, so
	// scheduling against the main window's rAF stalls dragging whenever the
	// main window is minimized — even though the Popout itself is fully
	// visible and its own mouse events keep firing normally.
	const popoutWindow = doc.defaultView ?? window;

	let state: DragState | null = null;
	let suppressNextContextMenu = false;

	const applyPendingDelta = () => {
		if (!state?.pendingDelta) return;
		const { dx, dy } = state.pendingDelta;
		state.pendingDelta = null;
		state.rafId = null;
		setWindowBoundsById(windowId, {
			x: state.startBounds.x + dx,
			y: state.startBounds.y + dy,
			width: state.startBounds.width,
			height: state.startBounds.height,
		});
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 2) return;
		const bounds = getWindowBoundsById(windowId);
		if (!bounds) return;
		state = {
			startScreenX: event.screenX,
			startScreenY: event.screenY,
			startBounds: bounds,
			dragging: false,
			rafId: null,
			pendingDelta: null,
		};
	};

	const onMouseMove = (event: MouseEvent) => {
		if (!state) return;
		const dx = event.screenX - state.startScreenX;
		const dy = event.screenY - state.startScreenY;

		if (!state.dragging) {
			if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
			state.dragging = true;
		}

		state.pendingDelta = { dx, dy };
		if (state.rafId == null) {
			state.rafId = popoutWindow.requestAnimationFrame(applyPendingDelta);
		}
	};

	const onMouseUp = (event: MouseEvent) => {
		if (event.button !== 2 || !state) return;
		if (state.dragging) {
			suppressNextContextMenu = true;
		}
		// Flush the final frame before tearing down: cancelling a pending rAF
		// without applying it would drop the last few pixels of movement, so
		// the window lands slightly behind where the button was released.
		if (state.rafId != null) {
			popoutWindow.cancelAnimationFrame(state.rafId);
			applyPendingDelta();
		}
		state = null;
	};

	const onContextMenu = (event: MouseEvent) => {
		if (!suppressNextContextMenu) return;
		suppressNextContextMenu = false;
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	// Capture phase so we see the event before Excalidraw's own handlers can
	// stop its propagation.
	doc.addEventListener("mousedown", onMouseDown, true);
	doc.addEventListener("mousemove", onMouseMove, true);
	doc.addEventListener("mouseup", onMouseUp, true);
	doc.addEventListener("contextmenu", onContextMenu, true);

	return () => {
		doc.removeEventListener("mousedown", onMouseDown, true);
		doc.removeEventListener("mousemove", onMouseMove, true);
		doc.removeEventListener("mouseup", onMouseUp, true);
		doc.removeEventListener("contextmenu", onContextMenu, true);
		if (state?.rafId != null) popoutWindow.cancelAnimationFrame(state.rafId);
		state = null;
	};
}
