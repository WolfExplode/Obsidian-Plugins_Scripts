/**
 * Auto-confirms the Excalidraw plugin's "Insert File From Vault" modal when it
 * offers exactly one choice.
 *
 * When you drag a file in from outside the vault, Obsidian copies it in and the
 * Excalidraw plugin then asks how to insert it. For an image or PDF the modal
 * offers a real choice ("as Image" / "PDF as Image" vs "as Embeddable"), but for
 * a video the only valid action is "as Embeddable" — so the modal is a redundant
 * extra click. We watch for it and, *only when it presents a single action
 * button*, click that button for you. When it offers more than one option we
 * leave it alone so your choice is never made for you.
 *
 * This reaches into another plugin's modal DOM by design (per ADR 0001 we don't
 * import its code). It keys on standard Obsidian structure — the plugin builds
 * the modal with `Modal` + `Setting.addButton`, so the action buttons are always
 * `.setting-item-control button` and the close button is not — and on the
 * modal's English title. The plugin renders all three action buttons up front
 * (Embeddable / PDF / Image) in one Setting and hides the inapplicable ones with
 * a `display: none` CSS class rather than omitting them, so we count only buttons
 * whose *computed* display is visible to tell "one real choice" from "many".
 * If Obsidian's UI language isn't English the title won't
 * match and we simply do nothing (the modal shows as normal): a safe no-op, never
 * a wrong click.
 */

/** The English UIFM_TITLE string the plugin sets on this specific modal. */
const MODAL_TITLE = "Insert File From Vault";
/** Marks a modal we've already acted on, so a re-fired observer won't double-click. */
const HANDLED_FLAG = "eprInsertAutoConfirmed";

/** Clicks the sole action button if this is the target modal and offers one option. */
function tryAutoConfirm(modal: HTMLElement): void {
	if (modal.dataset[HANDLED_FLAG]) return;
	if (!modal.classList.contains("excalidraw-modal")) return;
	if (modal.querySelector(".modal-title")?.textContent?.trim() !== MODAL_TITLE) return;

	// The plugin renders every action button and hides the inapplicable ones by
	// adding a `display: none !important` CSS class (not inline style), so we count
	// what's actually rendered via computed display — not the raw DOM node count.
	const buttons = Array.from(
		modal.querySelectorAll<HTMLButtonElement>(".setting-item-control button"),
	).filter((btn) => {
		const view = btn.ownerDocument.defaultView ?? window;
		return view.getComputedStyle(btn).display !== "none";
	});
	// 0 → content not rendered yet (caller retries); >1 → a genuine choice, leave it.
	if (buttons.length !== 1) return;

	modal.dataset[HANDLED_FLAG] = "1";
	buttons[0].click();
}

/**
 * Considers a node that was just added to the document: if it is (or contains) the
 * target modal, try to auto-confirm it. Descendant mutations are considered as
 * well as the initial container insertion because the modal shell is attached
 * before its buttons are rendered.
 */
function considerNode(node: Node): void {
	if (!node.instanceOf(HTMLElement)) return;
	const modal = node.matches?.(".modal.excalidraw-modal")
		? node
		: node.closest<HTMLElement>(".modal.excalidraw-modal")
			?? node.querySelector<HTMLElement>(".modal.excalidraw-modal");
	if (!modal) return;
	tryAutoConfirm(modal);
}

/**
 * Installs the auto-confirmer on one document (main window or a popout). Returns a
 * detach function. Mirrors the drop bridge's per-document lifecycle.
 */
export function attachInsertModalAutoConfirm(doc: Document): () => void {
	const win = doc.defaultView ?? window;
	const observer = new win.MutationObserver((mutations) => {
		for (const m of mutations) {
			for (const node of Array.from(m.addedNodes)) considerNode(node);
		}
	});
	observer.observe(doc.body, { childList: true, subtree: true });
	// A modal already open when we attach (e.g. after a plugin reload).
	for (const modal of Array.from(doc.querySelectorAll<HTMLElement>(".modal.excalidraw-modal"))) {
		considerNode(modal);
	}
	return () => observer.disconnect();
}
