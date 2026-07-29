import { App, type ButtonComponent, type Modifier, Notice, PluginSettingTab, Setting } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { findGlobalConflicts, type GlobalConflict } from "./hotkey-conflicts";
import { currentModifiers, describeBindings } from "./hotkey-match";
import { HOTKEY_ACTIONS, type HotkeyActionDef, type HotkeyBinding } from "./hotkey-registry";

/** Names KeyboardEvent.key reports for a bare modifier press, before a "real" key follows. */
const MODIFIER_KEY_NAMES = new Set(["Control", "Alt", "Shift", "Meta"]);

/** Maps a recorded keydown to the Obsidian-style key label the registry/matcher use (see hotkey-match.ts). */
function normalizeRecordedKey(event: KeyboardEvent): string {
	if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
	if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
	if (event.code === "BracketLeft") return "[";
	if (event.code === "BracketRight") return "]";
	return event.key;
}

function describeGlobalConflicts(conflicts: readonly GlobalConflict[]): string {
	return conflicts.map((conflict) => `"${conflict.name}"`).join(", ");
}

export class ExcalidrawPureRefSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: ExcalidrawPureRefPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Hotkeys").setHeading();

		const conflicts = this.plugin.hotkeys.findConflicts();
		if (conflicts.size > 0) {
			const banner = containerEl.createEl("p");
			banner.setCssStyles({ color: "var(--text-error)" });
			banner.setText(
				"Two or more actions below resolve to the same binding — only one of them will actually " +
					"trigger. Conflicting entries are highlighted.",
			);
		}

		const conflictingActionIds = new Set<string>();
		for (const ids of conflicts.values()) for (const id of ids) conflictingActionIds.add(id);

		for (const action of HOTKEY_ACTIONS) {
			this.renderAction(containerEl, action, conflictingActionIds.has(action.id));
		}

		new Setting(containerEl)
			.setName("Forget remembered popout positions")
			.setDesc(
				"Clears every Board's saved popout window position/size (per CONTEXT.md's geometry-persistence " +
					"contract). Popouts will reopen at Obsidian's default position next time.",
			)
			.addButton((button) =>
				button
					.setButtonText("Forget all")
					.setWarning()
					.setCta()
					.onClick(async () => {
						await this.plugin.geometry.clearAll();
					}),
			);
	}

	private renderAction(containerEl: HTMLElement, action: HotkeyActionDef, hasConflict: boolean): void {
		const store = this.plugin.hotkeys;
		const bindings = store.get(action.id);
		const globalConflicts = bindings.flatMap((binding) => findGlobalConflicts(this.app, this.plugin.manifest.id, binding));

		const setting = new Setting(containerEl).setName(action.name).setDesc(action.desc);

		const chip = setting.controlEl.createSpan({ text: describeBindings(bindings) });
		chip.setCssStyles({
			marginRight: "0.5em",
			fontFamily: "var(--font-monospace)",
			color: hasConflict || globalConflicts.length > 0 ? "var(--text-error)" : "",
		});

		setting.addButton((button) => {
			button.setButtonText("Record…").onClick(() => this.startRecording(action, button));
		});
		setting.addExtraButton((button) =>
			button
				.setIcon("rotate-ccw")
				.setTooltip("Reset to default")
				.setDisabled(!store.isOverridden(action.id))
				.onClick(async () => {
					await store.reset(action.id);
					this.display();
				}),
		);

		if (globalConflicts.length > 0) {
			const warning = containerEl.createEl("p", { text: `Already bound to ${describeGlobalConflicts(globalConflicts)}.` });
			warning.setCssStyles({ color: "var(--text-error)", fontSize: "var(--font-ui-smaller)", marginTop: "-0.5em", marginBottom: "0.5em" });
		}
	}

	private startRecording(action: HotkeyActionDef, button: ButtonComponent): void {
		const store = this.plugin.hotkeys;
		const originalLabel = "Record…";
		button.setButtonText(action.kind === "modifier" ? "Hold the modifiers, then release… (Esc to cancel)" : "Press keys… (Esc to cancel)");
		button.setDisabled(true);

		const doc = this.containerEl.ownerDocument;
		// For a "modifier" action, the fullest chord seen while any modifier is
		// still held — e.g. recording Ctrl+Alt sees Ctrl alone on the first
		// keydown (Alt not pressed yet), so committing on that keydown would
		// only ever capture the first key. Instead this accumulates the peak
		// chord and only commits on keyup once every modifier has been let go.
		let capturedModifiers: Modifier[] = [];

		const cleanup = () => {
			doc.removeEventListener("keydown", onKeyDown, true);
			doc.removeEventListener("keyup", onKeyUp, true);
			button.setDisabled(false);
			button.setButtonText(originalLabel);
		};
		const finish = (bindings: HotkeyBinding[] | null) => {
			cleanup();
			if (!bindings) return;
			const conflicts = bindings.flatMap((binding) => findGlobalConflicts(this.app, this.plugin.manifest.id, binding));
			if (conflicts.length > 0) {
				new Notice(`"${action.name}" is already bound to ${describeGlobalConflicts(conflicts)}. Saved anyway — you can Reset if that's not what you wanted.`, 8000);
			}
			void store.set(action.id, bindings).then(() => this.display());
		};

		const onKeyDown = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.key === "Escape") {
				finish(null);
				return;
			}

			if (action.kind === "modifier") {
				if (!MODIFIER_KEY_NAMES.has(event.key)) return;
				const modifiers = currentModifiers(event);
				if (modifiers.length > capturedModifiers.length) capturedModifiers = modifiers;
				return;
			}

			// A "key" action needs a real, non-modifier key to land on.
			if (MODIFIER_KEY_NAMES.has(event.key)) return;
			finish([{ modifiers: currentModifiers(event), key: normalizeRecordedKey(event) }]);
		};

		const onKeyUp = (event: KeyboardEvent) => {
			if (action.kind !== "modifier") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (currentModifiers(event).length > 0) return; // at least one modifier is still held
			finish(capturedModifiers.length ? [{ modifiers: capturedModifiers, key: null }] : null);
		};

		doc.addEventListener("keydown", onKeyDown, true);
		doc.addEventListener("keyup", onKeyUp, true);
	}
}
