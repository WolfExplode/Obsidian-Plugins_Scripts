import type { App, WorkspaceLeaf } from "obsidian";
import { findExcalidrawLeafForNode } from "./excalidraw-view";

/**
 * The pointer target is a Board's own Excalidraw canvas, not its toolbar,
 * menus, or other chrome that shares the same view container. The guard every
 * canvas-drag gesture (Alt-drag blocking, flip-drag, crop-drag) starts from.
 */
export function findCanvasLeaf(app: App, target: EventTarget | null): WorkspaceLeaf | null {
	const el = target as HTMLElement | null;
	if (!el || el.tagName !== "CANVAS") return null;
	return findExcalidrawLeafForNode(app, el);
}

export interface PointerDragCallbacks<TGesture> {
	/**
	 * Called on pointerdown, capture phase. Return gesture data to start
	 * capturing the drag, or null to let the event pass through untouched
	 * (Excalidraw's own handlers still see it).
	 */
	onStart(event: PointerEvent): TGesture | null;
	/** Called on every pointermove while a gesture is active. */
	onMove?(event: PointerEvent, gesture: TGesture): void;
	/**
	 * Called on pointerup for an active gesture, with the total client-pixel
	 * delta since pointerdown. Callers own their own drag-threshold semantics.
	 */
	onRelease(event: PointerEvent, gesture: TGesture, dx: number, dy: number): void;
}

export interface PointerDragHandle {
	dispose(): void;
	/** True while a gesture is active (pointer down, not yet released or cancelled). */
	isActive(): boolean;
	/** Ends an active gesture without calling onRelease, e.g. on Escape. */
	cancel(): void;
}

/**
 * Shared plumbing behind every PureRef-style canvas drag gesture: capture-phase
 * pointerdown/move/up, a captured start position, and preventDefault +
 * stopImmediatePropagation for the duration so Excalidraw's own pointer
 * handling never sees the gesture. Callers own their trigger condition
 * (modifier keys, a held key, button) and their drag-threshold semantics.
 */
export function attachPointerDrag<TGesture>(win: Window, callbacks: PointerDragCallbacks<TGesture>): PointerDragHandle {
	let active: {
		startX: number;
		startY: number;
		gesture: TGesture;
		rafId: number | null;
		pendingEvent: PointerEvent | null;
	} | null = null;

	const cancelPendingFrame = () => {
		if (active?.rafId != null) win.cancelAnimationFrame(active.rafId);
	};

	const onPointerDown = (event: PointerEvent) => {
		if (active) return;
		const gesture = callbacks.onStart(event);
		if (gesture === null) return;
		active = { startX: event.clientX, startY: event.clientY, gesture, rafId: null, pendingEvent: null };
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	// Coalesces onMove to one call per animation frame: only the latest
	// pointermove's position matters (matching window-drag.ts's pendingDelta
	// pattern), so a high-poll-rate mouse doesn't force a style recalc per event.
	const onPointerMove = (event: PointerEvent) => {
		if (!active) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		active.pendingEvent = event;
		if (active.rafId == null) {
			active.rafId = win.requestAnimationFrame(() => {
				if (!active) return;
				active.rafId = null;
				const pending = active.pendingEvent;
				active.pendingEvent = null;
				if (pending) callbacks.onMove?.(pending, active.gesture);
			});
		}
	};

	const onPointerUp = (event: PointerEvent) => {
		if (!active) return;
		const { startX, startY, gesture } = active;
		cancelPendingFrame();
		active = null;
		event.preventDefault();
		event.stopImmediatePropagation();
		callbacks.onRelease(event, gesture, event.clientX - startX, event.clientY - startY);
	};

	win.addEventListener("pointerdown", onPointerDown, true);
	win.addEventListener("pointermove", onPointerMove, true);
	win.addEventListener("pointerup", onPointerUp, true);

	return {
		dispose() {
			cancelPendingFrame();
			active = null;
			win.removeEventListener("pointerdown", onPointerDown, true);
			win.removeEventListener("pointermove", onPointerMove, true);
			win.removeEventListener("pointerup", onPointerUp, true);
		},
		isActive: () => active !== null,
		cancel() {
			cancelPendingFrame();
			active = null;
		},
	};
}
