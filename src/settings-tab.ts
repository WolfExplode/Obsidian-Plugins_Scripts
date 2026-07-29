import { App, PluginSettingTab, Setting } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";

const FIXED_HOTKEYS: ReadonlyArray<readonly [string, string]> = [
	["F10", "inside an open Popout, switch between the editable popout and the read-only always-on-top transparent window."],
	["G / R / S", "with elements selected, start a Blender-style modal move / rotate / scale. Move with the mouse, type digits during Scale to enter an exact factor, Enter to confirm, Escape to cancel."],
	["C (hold) + drag", "crop the selected image(s) to the dragged rectangle. Alt+double-click an image to remove a custom crop (or its native crop, if any)."],
	["Alt+Shift + drag", "with image elements selected, flip horizontally (left/right drag) or vertically (up/down drag). Alt-drag duplication is disabled; Alt-drag just moves."],
	["Ctrl/Cmd + Arrow", "gravity-pack the selected elements toward that edge."],
	["Ctrl/Cmd+Shift+P", "\"Optimal\" compact-arrange the selected elements."],
	["Ctrl/Cmd + ] / [", "overlap-aware Bring Forward / Send Backward (steps past the whole run of overlapping elements instead of one at a time)."],
	["Ctrl/Cmd+F", "with exactly one element selected, find and select its duplicates on the board."],
	["Ctrl+Alt + Arrow", "with images selected, normalize them: Left = match height, Right = match width, Up = match size, Down = match scale."],
	["Ctrl/Cmd + - / +", "with elements selected, change their opacity by 10%. With no selection in a focused Popout, changes the whole window's opacity by 5% instead. Opacity carries across read-only/edit mode switches."],
];

/**
 * Uses the imperative `display()` API, not the declarative
 * `getSettingDefinitions()` one: the installed "obsidian" npm package's
 * .d.ts documents getSettingDefinitions() as available since 1.13.0, but no
 * released Obsidian build (the dev vault here runs 1.9.12) implements it —
 * Settings.openTab() still calls tab.display() directly and throws
 * "e.display is not a function" if it's missing. Revisit if/when 1.13.0
 * actually ships.
 */
export class ExcalidrawPureRefSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: ExcalidrawPureRefPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("F11 hotkey")
			.setDesc(
				"Press F11 on an open Excalidraw board to toggle open/close PureRef-style popout. " +
					"Rebind it from Settings → Hotkeys → \"Excalidraw PureRef: Toggle PureRef popout\".",
			)
			.addButton((button) =>
				button.setButtonText("Open hotkeys settings").onClick(() => {
					const appWithSetting = this.app as unknown as {
						setting: { open(): void; openTabById(id: string): void };
					};
					appWithSetting.setting.open();
					appWithSetting.setting.openTabById("hotkeys");
				}),
			);

		new Setting(containerEl).setName("Other hotkeys").setHeading();
		containerEl.createEl("p", {
			text:
				"These are fixed and not rebindable from Settings → Hotkeys. Most of them intercept or " +
				"override native Excalidraw/Obsidian keys, which only works by claiming a specific key " +
				"combination directly.",
		});

		const hotkeyList = containerEl.createEl("ul");
		for (const [combo, desc] of FIXED_HOTKEYS) {
			const li = hotkeyList.createEl("li");
			li.createEl("strong", { text: combo });
			li.appendText(" - " + desc);
		}

		new Setting(containerEl)
			.setName("Forget remembered popout positions")
			.setDesc("Clears every Board's saved popout window position/size (per CONTEXT.md's geometry-persistence contract). Popouts will reopen at Obsidian's default position next time.")
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
}
