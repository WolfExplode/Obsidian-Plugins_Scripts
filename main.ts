import { Plugin, WorkspaceWindow } from "obsidian";
import { GeometryStore } from "src/geometry-store";
import { PopoutManager } from "src/popout-manager";
import { ExcalidrawPureRefSettingTab } from "src/settings-tab";
import { DEFAULT_SETTINGS, ExcalidrawPureRefSettings } from "src/settings";
import { getActiveExcalidrawFile, getActiveExcalidrawLeaf } from "src/excalidraw-view";
import { exportSelectedMedia } from "src/media-export";
import { attachPackKeydown } from "src/pack-keys";
import { attachPopoutDropBridge } from "src/popout-drop-bridge";
import { attachInsertModalAutoConfirm } from "src/insert-modal-autoconfirm";
import { attachAnimatedImageEmbedConversion } from "src/animated-image-drop";
import { attachVideoAspectCorrector } from "src/video-aspect";
import { attachMediaAutoPack } from "src/media-auto-pack";
import { attachCropDrag, installCropDebugHook } from "src/crop-drag";
import { attachOpacityKeydown } from "src/opacity-keys";
import { attachFlipDrag } from "src/flip-drag";
import { attachAltDragDuplicateBlocker } from "src/alt-drag";
import { attachTransformKeydown } from "src/transform-keys";
import { attachSnapKeyBlocker } from "src/snap-keys";
import { attachAltRHotkey } from "src/alt-r";
import { attachImageNormalize } from "src/image-normalize";
import { installKeyRelay, removeKeyRelay, cleanupOrphanPrototypes } from "src/transparent-proto";

export default class ExcalidrawPureRefPlugin extends Plugin {
	settings: ExcalidrawPureRefSettings = DEFAULT_SETTINGS;
	geometry!: GeometryStore;
	popouts!: PopoutManager;
	private diagnosticEvents: Array<{ timestamp: number; type: string; data: unknown }> = [];

	recordDiagnostic(type: string, data: unknown = {}): void {
		this.diagnosticEvents.push({ timestamp: Date.now(), type, data });
		if (this.diagnosticEvents.length > 2000) this.diagnosticEvents.splice(0, this.diagnosticEvents.length - 2000);
	}

	getDiagnostics(): unknown {
		return {
			pluginId: this.manifest.id,
			loaded: true,
			popouts: this.popouts?.getLifecycleDiagnostics() ?? null,
			events: this.diagnosticEvents.slice(),
		};
	}

	async onload(): Promise<void> {
		this.recordDiagnostic("plugin-load");
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
		this.register(attachOpacityKeydown(window, this.app));

		// Sanitize wikilink-unsafe characters out of dropped attachment filenames
		// in the main window. Popout windows get their own bridge when they open
		// (see PopoutManager); there the bridge also heals cross-realm drops, so it
		// takes over every file drop. Here it only intervenes when a name needs
		// fixing, leaving Excalidraw's native import path untouched otherwise.
		// Refit freshly-inserted local media (videos/animated images) to their true
		// aspect ratio across every Excalidraw view — main window and popouts. Hooks
		// each view's scene changes, so it needs no drop listener.
		this.register(attachVideoAspectCorrector(this));
		// Keep a multi-file import compact, like PureRef. The observer only packs
		// media newly created by an import; it seeds existing Board content first.
		this.register(attachMediaAutoPack(this));
		this.register(attachPopoutDropBridge(window.document, { alwaysBridge: false }));

		// PureRef-style hold-C + drag to crop the selected images, in the main window.
		// Popouts get their own binding when they open (see PopoutManager), so the
		// edit window inherits the feature. The console hook (window.__eprCropDebug)
		// stays available to drive the same crop primitive without a pointer gesture.
		this.register(attachCropDrag(window, this.app));
		this.register(attachFlipDrag(window, this.app));
		this.register(attachAltDragDuplicateBlocker(window, this.app));
		this.register(attachTransformKeydown(window, this.app));
		this.register(attachImageNormalize(window, this.app));
		// Drop Excalidraw's Alt+S "toggle object snap" shortcut inside a Board, since
		// it also force-disables grid mode. Popouts get their own binding in
		// PopoutManager. See attachSnapKeyBlocker.
		this.register(attachSnapKeyBlocker(window, this.app));
		// Claim Alt+R while a drawing is the active leaf so it stops triggering
		// Templater (which errors with no markdown editor). Reserved for an upcoming
		// feature. Rides Obsidian's global keymap, so one registration covers popouts
		// too — see attachAltRHotkey.
		this.register(attachAltRHotkey(this));
		this.register(installCropDebugHook(this.app));

		// Skip the Excalidraw "Insert File From Vault" popup when it offers only one
		// option (e.g. a dropped video → "as Embeddable"). Popouts get their own
		// observer when they open (see PopoutManager).
		this.register(attachInsertModalAutoConfirm(window.document));

		// Convert a freshly-inserted animated image (gif/webp/apng) from a static
		// Image into a playing Embeddable — see animated-image-drop.ts for why
		// Excalidraw's own drag-drop never offers that choice for this case. Spans
		// main window and popouts alike, same as the aspect/scale correctors above.
		this.register(attachAnimatedImageEmbedConversion(this));

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
				this.recordDiagnostic("workspace-window-open", { hasDocument: !!win.doc });
				this.popouts.handleWindowOpened(win);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("window-close", (win: WorkspaceWindow) => {
				this.recordDiagnostic("workspace-window-close", { hasDocument: !!win.doc });
				void this.popouts.handleWindowClosed(win);
			}),
		);

		// Deliberately reassigns Excalidraw's own Ctrl+Shift+E ("Export image" dialog)
		// the same way the opacity commands above already reassign its Ctrl+-/Ctrl+=
		// zoom shortcuts: an Obsidian command's own hotkey wins over Excalidraw's
		// internal bubble-phase handler, so no DOM-capture trick is needed here.
		this.addCommand({
			id: "export-selected-media",
			name: "Export selected media to folder",
			hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "E" }],
			checkCallback: (checking) => {
				const leaf = getActiveExcalidrawLeaf(this.app);
				if (!leaf) return false;
				if (checking) return true;
				void exportSelectedMedia(this.app, leaf);
				return true;
			},
		});

		this.addSettingTab(new ExcalidrawPureRefSettingTab(this.app, this));
	}

	onunload(): void {
		this.recordDiagnostic("plugin-unload");
		removeKeyRelay();
		this.popouts?.dispose();
	}
}
