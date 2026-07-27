/** True while focus is in a field where a shortcut key should type/navigate, not act on the Board. */
export function isEditableTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el || typeof el.tagName !== "string") return false;
	return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}
