import { Plugin, WorkspaceWindow } from "obsidian";
import { GeometryStore } from "src/geometry-store";
import { PopoutManager } from "src/popout-manager";
import { ExcalidrawPureRefSettingTab } from "src/settings-tab";
import { DEFAULT_SETTINGS, ExcalidrawPureRefSettings } from "src/settings";
import { getActiveExcalidrawFile } from "src/excalidraw-view";
import { attachPackKeydown } from "src/pack-keys";
import { installKeyRelay, removeKeyRelay, cleanupOrphanPrototypes } from "src/transparent-proto";

export default class ExcalidrawPureRefPlugin extends Plugin {
	settings: ExcalidrawPureRefSettings = DEFAULT_SETTINGS;
	geometry!: GeometryStore;
	popouts!: PopoutManager;

	async onload(): Promise<void> {
		this.geometry = new GeometryStore(this);
		await this.geometry.load();

		this.popouts = new PopoutManager(this);

		// Close any transparent windows orphaned by a previous session (e.g. an
		// earlier build whose window id we no longer hold), then route F10/F11
		// pressed inside the transparent window back to the popout manager.
		cleanupOrphanPrototypes(this);
		installKeyRelay((msg) => this.popouts.handleReadOnlyKey(msg));

		// PureRef-style Ctrl+Arrow pack in the main window. Popout windows get
		// their own binding when they open (see PopoutManager). Capture-phase, so
		// it preempts Excalidraw's own arrow handling — see attachPackKeydown.
		this.register(attachPackKeydown(window, this.app));

		this.addCommand({
			id: "toggle-pureref-popout",
			name: "Toggle PureRef popout",
			hotkeys: [{ modifiers: [], key: "F11" }],
			checkCallback: (checking) => {
				const file = getActiveExcalidrawFile(this.app);
				// Also available while read-only mode is up, so F11 can close it even
				// when no Excalidraw view is the active leaf.
				if (!file && !this.popouts.isReadOnlyOpen()) return false;
				if (checking) return true;
				void this.popouts.toggle(file);
				return true;
			},
		});

		this.addCommand({
			id: "toggle-readonly-transparent-prototype",
			name: "Toggle transparent reference mode",
			hotkeys: [{ modifiers: [], key: "F10" }],
			checkCallback: (checking) => {
				const file = getActiveExcalidrawFile(this.app);
				if (!this.popouts.canToggleReadOnlyPrototype(file)) return false;
				if (checking) return true;
				void this.popouts.toggleReadOnlyPrototype(file);
				return true;
			},
		});

		this.addCommand({
			id: "decrease-pureref-popout-opacity",
			name: "Decrease PureRef popout opacity",
			hotkeys: [{ modifiers: ["Ctrl"], key: "-" }],
			checkCallback: (checking) => {
				if (checking) return this.popouts.canAdjustFocusedPopoutOpacity();
				this.popouts.adjustFocusedPopoutOpacity(-1);
				return true;
			},
		});

		this.addCommand({
			id: "increase-pureref-popout-opacity",
			name: "Increase PureRef popout opacity",
			hotkeys: [
				{ modifiers: ["Ctrl"], key: "=" },
				{ modifiers: ["Ctrl", "Shift"], key: "=" },
			],
			checkCallback: (checking) => {
				if (checking) return this.popouts.canAdjustFocusedPopoutOpacity();
				this.popouts.adjustFocusedPopoutOpacity(1);
				return true;
			},
		});

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
		removeKeyRelay();
		this.popouts?.dispose();
	}
}
