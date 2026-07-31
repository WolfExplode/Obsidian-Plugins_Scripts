import { Plugin, WorkspaceWindow } from "obsidian";
import { GeometryStore } from "src/geometry-store";
import { PopoutManager } from "src/popout-manager";
import { ExcalidrawPureRefSettingTab } from "src/settings-tab";
import { getActiveExcalidrawFile, getActiveExcalidrawLeaf } from "src/excalidraw-view";
import { exportSelectedMedia } from "src/media-export";
import { attachBoardGestures } from "src/board-gestures";
import { attachPopoutDropBridge } from "src/popout-drop-bridge";
import { attachInsertModalAutoConfirm } from "src/insert-modal-autoconfirm";
import { attachAnimatedImageEmbedConversion } from "src/animated-image-drop";
import { attachVideoAspectCorrector } from "src/video-aspect";
import { attachMediaAutoPack } from "src/media-auto-pack";
import { attachFrontOfEmbedRendering } from "src/front-of-embed-view";
import { installCropDebugHook } from "src/crop-drag";
import { attachAltRHotkey } from "src/alt-r";
import { installKeyRelay, removeKeyRelay, cleanupOrphanPrototypes } from "src/transparent-proto";
import { HotkeyStore } from "src/hotkey-store";
import { syncObsidianHotkeys } from "src/hotkey-sync";

/**
 * The only persisted state is per-Board window geometry (GeometryStore) and
 * user hotkey overrides (HotkeyStore, src/hotkey-store.ts). Every plugin
 * hotkey — including the ones backed by a real Obsidian command — is
 * configurable from the plugin's own Settings tab (settings-tab.ts), which is
 * the single place to see and rebind all of them; syncObsidianHotkeys keeps
 * Obsidian's own command hotkeys in lockstep with that store instead of
 * relying on Settings → Hotkeys.
 */
export default class ExcalidrawPureRefPlugin extends Plugin {
	geometry!: GeometryStore;
	popouts!: PopoutManager;
	hotkeys!: HotkeyStore;
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

		this.hotkeys = new HotkeyStore(this);
		await this.hotkeys.load();

		this.popouts = new PopoutManager(this);

		// Close any transparent windows orphaned by a previous session (e.g. an
		// earlier build whose window id we no longer hold), then route F10/F11
		// pressed inside the transparent window back to the popout manager.
		cleanupOrphanPrototypes(this);
		installKeyRelay((msg) => this.popouts.handleReadOnlyKey(msg));

		// Every PureRef Board gesture (pack, z-order, opacity, hold-C crop, flip,
		// alt-drag blocking, modal transforms, Normalize) bound to the main window
		// in one call. Popout windows get their own binding when they open — see
		// PopoutManager, which calls the same attachBoardGestures.
		this.register(attachBoardGestures(window, this.app, { hotkeys: this.hotkeys }));

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
		// Makes elements already in front of an embeddable per scene z-order
		// actually render in front of it, by copying Excalidraw's own static canvas
		// onto a DOM overlay through a mask of those elements' shapes -- see
		// docs/behavior/front-of-embed-rendering.md and ADR 0010. Spans the main
		// window and every Popout via the same leaf-scanner lifecycle as the
		// correctors above.
		this.register(attachFrontOfEmbedRendering(this));

		// The console hook (window.__eprCropDebug) stays available to drive the
		// hold-C crop primitive (bound above via attachBoardGestures) without a
		// pointer gesture.
		this.register(installCropDebugHook(this.app));
		// Claim Alt+R while a drawing is the active leaf so it stops triggering
		// Templater (which errors with no markdown editor). Reserved for an upcoming
		// feature. Rides Obsidian's global keymap, so one registration covers popouts
		// too — see attachAltRHotkey.
		this.register(attachAltRHotkey(this));

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
			checkCallback: (checking) => {
				if (checking) return this.popouts.canAdjustFocusedPopoutOpacity();
				this.popouts.adjustFocusedPopoutOpacity(-1);
				return true;
			},
		});

		this.addCommand({
			id: "increase-pureref-popout-opacity",
			name: "Increase PureRef popout opacity",
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
			checkCallback: (checking) => {
				const leaf = getActiveExcalidrawLeaf(this.app);
				if (!leaf) return false;
				if (checking) return true;
				void exportSelectedMedia(this.app, leaf);
				return true;
			},
		});

		// The 5 commands above are registered with no static hotkey: their
		// binding is driven entirely by HotkeyStore/settings-tab.ts, applied here
		// and re-applied on every settings change so the plugin's own hotkey UI
		// is the single source of truth instead of Settings → Hotkeys.
		syncObsidianHotkeys(this, this.hotkeys);
		this.register(this.hotkeys.onChange(() => syncObsidianHotkeys(this, this.hotkeys)));

		this.addSettingTab(new ExcalidrawPureRefSettingTab(this.app, this));
	}

	onunload(): void {
		this.recordDiagnostic("plugin-unload");
		removeKeyRelay();
		this.popouts?.dispose();
	}
}
