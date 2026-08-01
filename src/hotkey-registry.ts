import type { Modifier } from "obsidian";

/**
 * A single chord. `key` is an Obsidian-style key label ("G", "P", "[", "F10",
 * "-", "="), normalized against the live KeyboardEvent by hotkey-match.ts.
 * `key` is null only for "modifier" actions, whose physical key is fixed by
 * semantics (e.g. gravity-pack's arrow keys) — only the modifier chord is
 * ever stored/compared for those.
 */
export interface HotkeyBinding {
	modifiers: Modifier[];
	key: string | null;
}

export type HotkeyActionKind = "key" | "modifier";

export interface HotkeyActionDef {
	id: string;
	name: string;
	desc: string;
	kind: HotkeyActionKind;
	/** Obsidian command id (sub-id under the plugin namespace) for actions backed by a real command. */
	commandId?: string;
	default: HotkeyBinding[];
}

/**
 * Every user-configurable hotkey in the plugin, "key" actions (a specific
 * modifiers+key chord) and "modifier" actions (only the modifier chord is
 * rebindable; the physical key/direction is fixed by what the gesture means).
 * See docs/adr and CONTEXT.md's hotkey-config section for the actions
 * deliberately left OUT of this list: modal-transform internals (Escape/
 * Enter/digits), the Board-scoped Alt+R reset, Alt+S reset, and X→Delete —
 * those are operation semantics, not top-level triggers.
 */
export const HOTKEY_ACTIONS: readonly HotkeyActionDef[] = [
	{
		id: "toggle-popout",
		name: "Toggle PureRef popout",
		desc: "Open/close the PureRef-style popout for the active Board.",
		kind: "key",
		commandId: "toggle-pureref-popout",
		default: [{ modifiers: [], key: "F11" }],
	},
	{
		id: "toggle-readonly-transparent",
		name: "Toggle transparent reference mode",
		desc: "Switch between the editable popout and the read-only always-on-top transparent window.",
		kind: "key",
		commandId: "toggle-readonly-transparent-prototype",
		default: [{ modifiers: [], key: "F10" }],
	},
	{
		id: "opacity-decrease",
		name: "Decrease opacity",
		desc: "With elements selected, decrease their opacity by 10%. With no selection in a focused popout, decreases the whole window's opacity by 5% instead.",
		kind: "key",
		commandId: "decrease-pureref-popout-opacity",
		default: [{ modifiers: ["Ctrl"], key: "-" }],
	},
	{
		id: "opacity-increase",
		name: "Increase opacity",
		desc: "With elements selected, increase their opacity by 10%. With no selection in a focused popout, increases the whole window's opacity by 5% instead.",
		kind: "key",
		commandId: "increase-pureref-popout-opacity",
		default: [{ modifiers: ["Ctrl"], key: "=" }],
	},
	{
		id: "export-media",
		name: "Export selected media to folder",
		desc: "Export the selected image/embeddable elements to a folder.",
		kind: "key",
		commandId: "export-selected-media",
		default: [{ modifiers: ["Ctrl", "Shift"], key: "E" }],
	},
	{
		id: "transform-move",
		name: "Modal transform: Move",
		desc: "With elements selected, start a Blender-style modal move. Move with the mouse, Enter to confirm, Escape to cancel.",
		kind: "key",
		default: [{ modifiers: [], key: "G" }],
	},
	{
		id: "transform-rotate",
		name: "Modal transform: Rotate",
		desc: "With elements selected, start a Blender-style modal rotate about the selection center.",
		kind: "key",
		default: [{ modifiers: [], key: "R" }],
	},
	{
		id: "transform-scale",
		name: "Modal transform: Scale",
		desc: "With elements selected, start a Blender-style modal scale. Type digits to enter an exact factor.",
		kind: "key",
		default: [{ modifiers: [], key: "S" }],
	},
	{
		id: "pack-optimal",
		name: "Optimal arrange",
		desc: "\"Optimal\" compact-arrange the selected elements.",
		kind: "key",
		default: [{ modifiers: ["Ctrl", "Shift"], key: "P" }],
	},
	{
		id: "pack-gravity-modifier",
		name: "Gravity pack (modifier)",
		desc: "Held with an Arrow key, gravity-packs the selected elements toward that edge.",
		kind: "modifier",
		default: [{ modifiers: ["Mod"], key: null }],
	},
	{
		id: "zorder-forward",
		name: "Bring forward (overlap-aware)",
		desc: "Steps the selection past the whole run of overlapping elements instead of one at a time.",
		kind: "key",
		default: [{ modifiers: ["Mod"], key: "]" }],
	},
	{
		id: "zorder-backward",
		name: "Send backward (overlap-aware)",
		desc: "Steps the selection past the whole run of overlapping elements instead of one at a time.",
		kind: "key",
		default: [{ modifiers: ["Mod"], key: "[" }],
	},
	{
		id: "crop-hold",
		name: "Crop (hold + drag)",
		desc: "Hold and drag a rectangle over the Board; on release every selected image is cropped to the part of it inside that rectangle.",
		kind: "key",
		default: [{ modifiers: [], key: "C" }],
	},
	{
		id: "duplicate-finder",
		name: "Find duplicates",
		desc: "With exactly one element selected, find and select its duplicates on the board.",
		kind: "key",
		default: [{ modifiers: ["Mod"], key: "F" }],
	},
	{
		id: "normalize-modifier",
		name: "Normalize (modifier)",
		desc: "Held with an Arrow key, normalizes selected images: Left = match height, Right = match width, Up = match size, Down = match scale.",
		kind: "modifier",
		default: [{ modifiers: ["Ctrl", "Alt"], key: null }],
	},
	{
		id: "flip-drag-modifier",
		name: "Flip (drag modifier)",
		desc: "Held while dragging image elements, flips them horizontally (left/right drag) or vertically (up/down drag).",
		kind: "modifier",
		default: [{ modifiers: ["Alt", "Shift"], key: null }],
	},
];

export function getHotkeyAction(id: string): HotkeyActionDef | undefined {
	return HOTKEY_ACTIONS.find((action) => action.id === id);
}
