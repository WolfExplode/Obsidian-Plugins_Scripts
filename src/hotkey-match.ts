import { Platform, type Modifier } from "obsidian";
import type { HotkeyBinding } from "./hotkey-registry";

/** The modifier-flag shape shared by KeyboardEvent, MouseEvent, and PointerEvent. */
interface ModifierEvent {
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
}

function modifiersMatch(event: ModifierEvent, modifiers: readonly Modifier[]): boolean {
	const wantCtrl = modifiers.includes("Ctrl") || (modifiers.includes("Mod") && !Platform.isMacOS);
	const wantMeta = modifiers.includes("Meta") || (modifiers.includes("Mod") && Platform.isMacOS);
	const wantShift = modifiers.includes("Shift");
	const wantAlt = modifiers.includes("Alt");
	return event.ctrlKey === wantCtrl && event.metaKey === wantMeta && event.shiftKey === wantShift && event.altKey === wantAlt;
}

/**
 * Matches a configured key label against the event. Letters/digits compare
 * via event.code (layout-independent); "[" / "]" map to the bracket codes
 * Excalidraw/Obsidian also use for z-order; "=" additionally accepts "+" since
 * some layouts report that for the same physical key even without Shift.
 * Anything else (F-keys, "-") falls back to a case-insensitive event.key compare.
 */
function keyMatches(event: KeyboardEvent, key: string): boolean {
	if (/^[A-Za-z0-9]$/.test(key)) return event.code === `Key${key.toUpperCase()}` || event.code === `Digit${key}`;
	if (key === "[") return event.code === "BracketLeft";
	if (key === "]") return event.code === "BracketRight";
	if (key === "=") return event.key === "=" || event.key === "+";
	return event.key.toLowerCase() === key.toLowerCase();
}

/** For "key"-kind actions: does this keydown match one of the configured chords? */
export function eventMatchesAnyBinding(event: KeyboardEvent, bindings: readonly HotkeyBinding[]): boolean {
	return bindings.some((binding) => binding.key !== null && keyMatches(event, binding.key) && modifiersMatch(event, binding.modifiers));
}

/** For "modifier"-kind actions: is the event's modifier chord one of the configured ones (key ignored)? */
export function chordMatches(event: ModifierEvent, bindings: readonly HotkeyBinding[]): boolean {
	return bindings.some((binding) => modifiersMatch(event, binding.modifiers));
}

const MODIFIER_LABELS: Record<Modifier, string> = {
	Mod: Platform.isMacOS ? "Cmd" : "Ctrl",
	Ctrl: "Ctrl",
	Meta: Platform.isMacOS ? "Cmd" : "Win",
	Shift: "Shift",
	Alt: Platform.isMacOS ? "Opt" : "Alt",
};
const MODIFIER_ORDER: readonly Modifier[] = ["Ctrl", "Mod", "Meta", "Alt", "Shift"];

function describeModifiers(modifiers: readonly Modifier[]): string[] {
	return MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)).map((modifier) => MODIFIER_LABELS[modifier]);
}

/** Human-readable label for one binding, e.g. "Ctrl + Shift + P" or "Alt + Shift" for a modifier-only binding. */
export function describeBinding(binding: HotkeyBinding): string {
	const parts = describeModifiers(binding.modifiers);
	if (binding.key !== null) parts.push(binding.key);
	return parts.length ? parts.join(" + ") : "(unbound)";
}

export function describeBindings(bindings: readonly HotkeyBinding[]): string {
	return bindings.length ? bindings.map(describeBinding).join(", ") : "(unbound)";
}

/** Modifiers currently held by a keyboard event, in the plugin's own Modifier vocabulary. */
export function currentModifiers(event: KeyboardEvent): Modifier[] {
	const modifiers: Modifier[] = [];
	if (event.ctrlKey) modifiers.push("Ctrl");
	if (event.metaKey) modifiers.push("Meta");
	if (event.shiftKey) modifiers.push("Shift");
	if (event.altKey) modifiers.push("Alt");
	return modifiers;
}
