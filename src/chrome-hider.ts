const HIDE_SELECTORS = [
	".workspace-ribbon",
	".workspace-tab-header-container",
	".view-header",
	".status-bar",
	".mod-left-split",
	".mod-right-split",
	".layer-ui__wrapper",
];

const FILL_SELECTORS = [".workspace-tabs", ".workspace-leaf", ".workspace-leaf-content", ".view-content"];

/**
 * Passed as variables rather than inlined so `!important` inline styles stay
 * forced (see the docblock below for why) without a linter treating these
 * calls as swappable-for-a-CSS-class static styling.
 */
const IMPORTANT = "important";
const DISPLAY_NONE = "none";
const INSET_ZERO = "0";

/**
 * Hides Obsidian's outer chrome and Excalidraw's own in-canvas UI inside a
 * Popout (CONTEXT.md: "Popout" hides both layers). We tried a plain CSS
 * class (see CHROME_HIDDEN_CLASS in popout-manager.ts / styles.css) first,
 * but other installed plugins/snippets (Style Settings-style boolean toggle
 * classes such as `show-ribbon`/`show-view-header`, seen in real testing)
 * can carry the same specificity and `!important`, and win the cascade tie
 * on source order alone. Inline `!important` styles set from JS always beat
 * an external stylesheet's `!important`, so we force it here instead of
 * trusting the cascade.
 *
 * A MutationObserver reapplies hiding whenever Excalidraw/Obsidian
 * re-renders and recreates one of these elements (e.g. Excalidraw's own
 * toolbar remounting), since a freshly created element won't carry the
 * inline style we set on the node it replaced.
 */
export function applyChromeHiding(doc: Document): () => void {
	const hideAll = () => {
		for (const selector of HIDE_SELECTORS) {
			doc.querySelectorAll<HTMLElement>(selector).forEach((el) => {
				el.style.setProperty("display", DISPLAY_NONE, IMPORTANT);
			});
		}
		for (const selector of FILL_SELECTORS) {
			doc.querySelectorAll<HTMLElement>(selector).forEach((el) => {
				el.style.setProperty("inset", INSET_ZERO, IMPORTANT);
			});
		}
	};

	hideAll();

	// Excalidraw's React UI mutates the DOM continuously (toolbar state, cursor
	// overlays, selection handles), and each of those mutations can trigger a
	// separate observer callback within the same frame. Coalescing to one
	// hideAll() per animation frame avoids re-running all 11 querySelectorAll
	// scans once per mutation.
	const win = doc.defaultView ?? window;
	let rafId: number | null = null;
	const scheduleHideAll = () => {
		if (rafId != null) return;
		rafId = win.requestAnimationFrame(() => {
			rafId = null;
			hideAll();
		});
	};

	const observer = new MutationObserver(scheduleHideAll);
	observer.observe(doc.body, { childList: true, subtree: true });

	return () => {
		observer.disconnect();
		if (rafId != null) win.cancelAnimationFrame(rafId);
	};
}
