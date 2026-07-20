import type { App } from "obsidian";

/**
 * Reaches the third-party Excalidraw community plugin's settings object to
 * temporarily suppress its "zoom to fit on view resize" behavior while a
 * Popout is open. Per ADR 0001 we drive Excalidraw from the OUTSIDE and never
 * import its code — this is a runtime, best-effort reach into its public
 * plugin instance, not a compile-time dependency.
 *
 * WHY: real PureRef windows don't refit the board when the window is resized
 * or moved. Excalidraw's `zoomToFitOnResize` refits on every `resize` event —
 * and RMB window-drag (window-drag.ts) emits a stream of resize events on
 * Windows because Electron's setBounds carries a size component. With the
 * setting on, dragging the Popout snaps the canvas to fit the board's content,
 * which is exactly the behavior we do not want here.
 *
 * IMPORTANT: `zoomToFitOnResize` is a single GLOBAL Excalidraw setting, not a
 * per-view one. Suspending it therefore also affects the originating main-
 * window view for as long as any Popout is open. The Question above was
 * decided in favor of this trade-off (see CONTEXT.md's Popout entry). The
 * original value is captured on first suspend and restored on last resume, so
 * the user's own preference is preserved across the Popout lifecycle.
 */

const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";
const SETTING_KEY = "zoomToFitOnResize";

interface ExcalidrawSettingsBag {
	[SETTING_KEY]?: boolean;
}

interface ExcalidrawPluginLike {
	settings?: ExcalidrawSettingsBag;
}

interface AppWithPlugins {
	plugins?: { plugins?: Record<string, unknown> };
}

function getExcalidrawSettings(app: App): ExcalidrawSettingsBag | null {
	const registry = (app as unknown as AppWithPlugins).plugins?.plugins;
	const plugin = registry?.[EXCALIDRAW_PLUGIN_ID] as ExcalidrawPluginLike | undefined;
	const settings = plugin?.settings;
	if (!settings || typeof settings[SETTING_KEY] !== "boolean") return null;
	return settings;
}

/**
 * Suspends `zoomToFitOnResize` while at least one Popout is open, restoring the
 * user's original value once the last one closes. Reference-counted so it is
 * safe to call suspend()/resume() once per Popout open/close, in any order.
 */
export class ExcalidrawRefitSuspender {
	private openCount = 0;
	private savedValue: boolean | null = null;

	constructor(private readonly app: App) {}

	/** Call when a Popout opens. Idempotent per open (reference-counted). */
	suspend(): void {
		this.openCount += 1;
		if (this.openCount > 1) return;

		const settings = getExcalidrawSettings(this.app);
		if (!settings) {
			console.warn(
				`[Excalidraw PureRef] could not reach Excalidraw's "${SETTING_KEY}" setting; ` +
					"canvas may refit while dragging the Popout. See CONTEXT.md.",
			);
			return;
		}
		this.savedValue = settings[SETTING_KEY] ?? null;
		settings[SETTING_KEY] = false;
	}

	/** Call when a Popout closes. Restores the original value at the last close. */
	resume(): void {
		if (this.openCount === 0) return;
		this.openCount -= 1;
		if (this.openCount > 0) return;

		if (this.savedValue == null) return;
		const settings = getExcalidrawSettings(this.app);
		if (settings) settings[SETTING_KEY] = this.savedValue;
		this.savedValue = null;
	}

	/** Force-restore regardless of count (used on plugin unload). */
	reset(): void {
		if (this.openCount > 0 && this.savedValue != null) {
			const settings = getExcalidrawSettings(this.app);
			if (settings) settings[SETTING_KEY] = this.savedValue;
		}
		this.openCount = 0;
		this.savedValue = null;
	}
}
