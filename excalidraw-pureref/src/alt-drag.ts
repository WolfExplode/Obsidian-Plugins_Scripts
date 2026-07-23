import type { App } from "obsidian";
import { findExcalidrawLeafForNode } from "./excalidraw-view";

const RELAYED_POINTER_EVENT = "__eprAltDragRelayed";

/**
 * Replays an Alt-drag with Alt removed. Excalidraw interprets a trusted
 * Alt-drag as "duplicate while moving"; replaying the pointer stream keeps the
 * ordinary move interaction while suppressing only that duplication modifier.
 */
function relayWithoutAlt(event: PointerEvent): void {
	const target = event.target as EventTarget | null;
	if (!target) return;
	const replay = new PointerEvent(event.type, {
		bubbles: true,
		cancelable: true,
		composed: true,
		pointerId: event.pointerId,
		pointerType: event.pointerType,
		isPrimary: event.isPrimary,
		button: event.button,
		buttons: event.buttons,
		clientX: event.clientX,
		clientY: event.clientY,
		screenX: event.screenX,
		screenY: event.screenY,
		ctrlKey: event.ctrlKey,
		shiftKey: event.shiftKey,
		metaKey: event.metaKey,
		altKey: false,
	});
	Object.defineProperty(replay, RELAYED_POINTER_EVENT, { value: true });
	target.dispatchEvent(replay);
}

/**
 * Disables Excalidraw's Alt-drag duplication in every window the host plugin
 * owns. A plain Alt-drag still moves the element normally. Alt+Shift is left to
 * `attachFlipDrag`, which intercepts it first for the PureRef flip gesture.
 */
export function attachAltDragDuplicateBlocker(win: Window, app: App): () => void {
	const shouldRelayMove = (event: PointerEvent): boolean => {
		if ((event as unknown as Record<string, unknown>)[RELAYED_POINTER_EVENT]) return false;
		if (!event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return false;
		const target = event.target as HTMLElement | null;
		return !!target && target.tagName === "CANVAS" && !!findExcalidrawLeafForNode(app, target);
	};

	const onPointerMove = (event: PointerEvent) => {
		if (!shouldRelayMove(event)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		relayWithoutAlt(event);
	};

	win.addEventListener("pointermove", onPointerMove, true);
	return () => {
		win.removeEventListener("pointermove", onPointerMove, true);
	};
}
