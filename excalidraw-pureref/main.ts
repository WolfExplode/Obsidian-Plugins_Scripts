import { Plugin, WorkspaceWindow } from "obsidian";
import { GeometryStore } from "src/geometry-store";
import { PopoutManager } from "src/popout-manager";
import { ExcalidrawPureRefSettingTab } from "src/settings-tab";
import { DEFAULT_SETTINGS, ExcalidrawPureRefSettings } from "src/settings";
import { getActiveExcalidrawFile } from "src/excalidraw-view";
import { registerPurInterchangeCommands } from "src/pur-interchange";

export default class ExcalidrawPureRefPlugin extends Plugin {
	settings: ExcalidrawPureRefSettings = DEFAULT_SETTINGS;
	geometry!: GeometryStore;
	popouts!: PopoutManager;

	async onload(): Promise<void> {
		this.geometry = new GeometryStore(this);
		await this.geometry.load();

		this.popouts = new PopoutManager(this);

		this.addCommand({
			id: "toggle-pureref-popout",
			name: "Toggle PureRef popout",
			hotkeys: [{ modifiers: [], key: "F11" }],
			checkCallback: (checking) => {
				const file = getActiveExcalidrawFile(this.app);
				if (!file) return false;
				if (checking) return true;
				void this.popouts.toggle(file);
				return true;
			},
		});

		registerPurInterchangeCommands(this);

		this.registerEvent(
			this.app.workspace.on("window-open", (win: WorkspaceWindow) => {
				this.popouts.handleWindowOpened(win);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("window-close", (win: WorkspaceWindow) => {
				void this.popouts.handleWindowClosed(win);
			}),
		);

		this.addSettingTab(new ExcalidrawPureRefSettingTab(this.app, this));
	}

	onunload(): void {
		this.popouts?.dispose();
	}
}
