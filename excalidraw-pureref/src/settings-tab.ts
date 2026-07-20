import { App, PluginSettingTab, Setting } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";

export class ExcalidrawPureRefSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: ExcalidrawPureRefPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Excalidraw PureRef" });
		containerEl.createEl("p", {
			text:
				"Press F11 while an Excalidraw board is focused to open (or close) a chrome-free, " +
				"always-on-top PureRef-style popout of that board. There is no in-canvas UI for this " +
				"feature by design — everything is hotkey/mouse-driven inside the popout, and configured here.",
		});

		new Setting(containerEl)
			.setName("F11 hotkey")
			.setDesc("Rebind the popout toggle from Settings → Hotkeys → \"Excalidraw PureRef: Toggle PureRef popout\".")
			.addButton((button) =>
				button.setButtonText("Open Hotkeys settings").onClick(() => {
					const appWithSetting = this.app as unknown as {
						setting: { open(): void; openTabById(id: string): void };
					};
					appWithSetting.setting.open();
					appWithSetting.setting.openTabById("hotkeys");
				}),
			);

		new Setting(containerEl)
			.setName("Forget remembered popout positions")
			.setDesc("Clears every Board's saved popout window position/size (per CONTEXT.md's geometry-persistence contract). Popouts will reopen at Obsidian's default position next time.")
			.addButton((button) =>
				button
					.setButtonText("Forget all")
					.setWarning()
					.onClick(async () => {
						await this.plugin.geometry.clearAll();
					}),
			);
	}
}
