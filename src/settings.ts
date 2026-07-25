/**
 * Per CONTEXT.md's "Plugin settings tab" entry: this is the sole
 * configuration surface for the feature. There is deliberately no in-canvas
 * settings UI.
 */
export interface ExcalidrawPureRefSettings {
	// Reserved for future options (e.g. a fallback always-on-top level if
	// 'screen-saver' misbehaves on a given machine). Empty for now — v1 has
	// no user-facing knobs beyond the F11 hotkey itself, which Obsidian's own
	// Hotkeys settings page already covers.
}

export const DEFAULT_SETTINGS: ExcalidrawPureRefSettings = {};
