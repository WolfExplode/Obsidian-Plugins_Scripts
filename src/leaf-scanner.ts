import type { EventRef, Events, WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { isExcalidrawLeaf } from "./excalidraw-view";

/**
 * The shared lifecycle behind every per-view scene watcher: video-aspect.ts
 * and media-auto-pack.ts.
 *
 * Both want the same thing — "run my scan whenever any Excalidraw view's
 * scene changes, in the main window and every Popout, attaching to views as they
 * mount and detaching as they close" — and each had grown its own copy of the
 * attach/prune/reconcile/retry machinery. They differ only in what per-leaf state
 * they seed and what they do on a change, which is what `setup` and `scan` are.
 *
 * Consolidating matters beyond deduplication: `isApiDestroyed` below encodes a
 * bug that silently broke Popout support once already (see its comment), and
 * separate hand-maintained copies is more chances to get it wrong again.
 */

/** How long to keep retrying attachment while a view's API finishes mounting. */
const READY_RETRY_MS = 300;
const READY_RETRY_MAX = 20;

/**
 * The minimal Excalidraw element shape the seeding logic reads. Deliberately a
 * permissive superset of what its consumers need, so each can narrow it to
 * its own element interface without the scanner knowing about images vs embeds.
 */
export interface ScannerElement {
	id?: string;
	type?: string;
	fileId?: string | null;
	link?: string | null;
	isDeleted?: boolean;
}

/** The slice of the Excalidraw imperative API a per-view scanner needs. */
export interface LeafScannerApi {
	onChange(cb: () => void): () => void;
	getSceneElements(): readonly ScannerElement[];
	/**
	 * In the bundled Excalidraw this is a boolean PROPERTY, not a method — some
	 * builds may expose it as a getter/function, so callers must handle both.
	 */
	isDestroyed?: boolean | (() => boolean);
}

/**
 * Whether a view's API reports itself torn down, tolerating property-or-method form.
 *
 * DO NOT collapse this to `api.isDestroyed?.()`. In the bundled Excalidraw
 * `isDestroyed` is a boolean *property*, so `?.()` becomes `false.call(api)` and
 * throws "d.call is not a function". That throw is silent and nasty: it fired
 * inside `prune()`, which only iterates once a leaf is attached — so the first
 * (empty) reconcile attached the main window fine, then every later reconcile
 * threw before reaching the popout leaf. Net effect was the corrector working in
 * the main window but never in popouts, with no error surfaced.
 */
export function isApiDestroyed(api: LeafScannerApi): boolean {
	const destroyed = api.isDestroyed;
	return typeof destroyed === "function" ? destroyed() === true : destroyed === true;
}

export function getLeafScannerApi(leaf: WorkspaceLeaf): LeafScannerApi | null {
	const api = (leaf.view as unknown as { excalidrawAPI?: Partial<LeafScannerApi> }).excalidrawAPI;
	if (!api || typeof api.onChange !== "function" || typeof api.getSceneElements !== "function") return null;
	return api as LeafScannerApi;
}

/**
 * Whether the Excalidraw view is still loading its saved scene into the API.
 *
 * The Excalidraw plugin sets `view.semaphores.justLoaded = true` before it
 * populates the API with a file's persisted elements, clearing it again on the
 * first `onChange` after that population completes. Without this, seeding "seen"
 * the instant the API exists can race the persisted elements landing — every
 * element already on a board opened for the first time then looks like a
 * brand-new insert. Fails open (seeds immediately) if the property is absent.
 */
export function isLeafStillLoading(leaf: WorkspaceLeaf): boolean {
	return (leaf.view as unknown as { semaphores?: { justLoaded?: boolean } }).semaphores?.justLoaded === true;
}

/** The document a leaf's view lives in, or null. */
export function leafDocument(leaf: WorkspaceLeaf): Document | null {
	return (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl?.ownerDocument ?? null;
}

/** "MAIN" or "POPOUT" for a leaf, by which window its view lives in. */
export function leafWindowLabel(leaf: WorkspaceLeaf): "MAIN" | "POPOUT" {
	return leafDocument(leaf)?.defaultView === window ? "MAIN" : "POPOUT";
}

/** Live view onto the scanner, for event handlers and debug hooks. */
export interface LeafScannerHandle<TState> {
	/** Every currently-attached leaf with its state. */
	entries(): Array<[WorkspaceLeaf, TState]>;
	/** Re-run `scan` for one attached leaf. No-op if it isn't attached. */
	rescan(leaf: WorkspaceLeaf): void;
	/** Attach newly-mounted views and drop closed ones. */
	reconcile(): void;
	isDisposed(): boolean;
}

export interface LeafScannerOptions<TState> {
	/**
	 * Build this leaf's state once its API is mounted and its saved scene has
	 * loaded. Return null to report "not ready yet" and be retried.
	 */
	setup(leaf: WorkspaceLeaf, api: LeafScannerApi, scanner: LeafScannerHandle<TState>): TState | null;
	/** Runs on every scene change for an attached leaf. */
	scan(leaf: WorkspaceLeaf, state: TState, scanner: LeafScannerHandle<TState>): void;
	/** Extra per-leaf cleanup, beyond unsubscribing from onChange. */
	teardown?(leaf: WorkspaceLeaf, state: TState): void;
	/**
	 * Extra listeners/hooks owned for the scanner's lifetime. Returns disposers
	 * rather than EventRefs on purpose: an EventRef must be released through the
	 * SAME emitter it was registered on, and `Vault` and `Workspace` are separate
	 * `Events` instances. Passing a vault ref to `workspace.offref` silently does
	 * nothing and leaks the listener across a plugin reload — which is exactly the
	 * bug the previous hand-rolled copies of this loop had.
	 */
	extras?(scanner: LeafScannerHandle<TState>): Array<() => void>;
}

/** Registers an Obsidian event and returns a disposer bound to the right emitter. */
export function onEvent(emitter: Events, register: () => EventRef): () => void {
	const ref = register();
	return () => emitter.offref(ref);
}

/**
 * Installs a scene-change scanner across every Excalidraw view — main window and
 * Popouts alike. Returns a dispose function.
 *
 * Path-independent by design: it reacts to scene changes rather than to drops or
 * paste events, so it catches every way media can reach a board (drag-drop,
 * paste, the "Insert File From Vault" modal) with no timing race.
 */
export function attachPerLeafScanner<TState>(
	plugin: ExcalidrawPureRefPlugin,
	options: LeafScannerOptions<TState>,
): () => void {
	const states = new Map<WorkspaceLeaf, TState>();
	// A WorkspaceLeaf survives a view-type round trip. In particular, Excalidraw's
	// "Open as Markdown" / "Open as Excalidraw" commands replace `leaf.view` and
	// its imperative API while preserving the leaf object. Keying ownership only
	// by leaf therefore leaves the old state and dead onChange subscription in
	// place when the Board returns. Remember the exact API instance each state was
	// attached to so `prune` can release and rebuild it after that replacement.
	const apis = new Map<WorkspaceLeaf, LeafScannerApi>();
	const unsubscribes = new Map<WorkspaceLeaf, () => void>();
	// Retry readiness per leaf and per concrete view/API instance. A fileless or
	// otherwise permanently-unready Excalidraw leaf must not consume one global
	// budget and prevent a different Board from attaching after it remounts.
	const retries = new Map<WorkspaceLeaf, { identity: object; attempts: number }>();
	let disposed = false;
	let retryTimer: number | null = null;

	const release = (leaf: WorkspaceLeaf) => {
		const state = states.get(leaf);
		try {
			unsubscribes.get(leaf)?.();
		} catch {
			/* view already torn down */
		}
		unsubscribes.delete(leaf);
		apis.delete(leaf);
		retries.delete(leaf);
		states.delete(leaf);
		if (state !== undefined) {
			try {
				options.teardown?.(leaf, state);
			} catch {
				/* view already torn down */
			}
		}
	};

	/** False means "an Excalidraw view exists but isn't ready" — retry shortly. */
	const attach = (leaf: WorkspaceLeaf): boolean => {
		if (states.has(leaf)) return true;
		if (!isExcalidrawLeaf(leaf)) return true; // not our concern; treat as settled
		const api = getLeafScannerApi(leaf);
		if (!api) return false; // an Excalidraw view whose API hasn't mounted yet
		// Wait for the persisted elements to land before seeding "already seen".
		if (isLeafStillLoading(leaf)) return false;

		let state: TState | null;
		try {
			state = options.setup(leaf, api, handle);
		} catch {
			return false;
		}
		if (state === null) return false;

		states.set(leaf, state);
		apis.set(leaf, api);
		try {
			unsubscribes.set(
				leaf,
				api.onChange(() => {
					// A destroyed API can still deliver a queued callback after a view
					// replacement. Only the subscription that still owns this leaf may scan.
					if (disposed || states.get(leaf) !== state || apis.get(leaf) !== api) return;
					// TState is narrowed to non-null above, but this project's pinned TS 4.7.4
					// doesn't carry that narrowing for a generic `let` across a closure boundary
					// (removing the assertion breaks `tsc`, even though newer TS versions accept it).
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- verified with tsc: the assertion is load-bearing on this project's pinned TypeScript version
					options.scan(leaf, state as TState, handle);
				}),
			);
		} catch {
			apis.delete(leaf);
			states.delete(leaf);
			try {
				options.teardown?.(leaf, state);
			} catch {
				/* ignore */
			}
			return false;
		}
		return true;
	};

	/** Drops subscriptions for views that have closed or been destroyed. */
	const prune = () => {
		for (const leaf of Array.from(states.keys())) {
			const api = getLeafScannerApi(leaf);
			if (
				isExcalidrawLeaf(leaf) &&
				api &&
				api === apis.get(leaf) &&
				!isApiDestroyed(api)
			) continue;
			release(leaf);
		}
	};

	const reconcile = () => {
		if (disposed) return;
		prune();
		const pendingRetries: Array<{ leaf: WorkspaceLeaf; identity: object; attempts: number }> = [];
		plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!isExcalidrawLeaf(leaf)) return;
			if (attach(leaf)) {
				retries.delete(leaf);
				return;
			}

			// Before the API mounts, the view object is the readiness identity. Once
			// it mounts, the API becomes the identity, replenishing the budget for
			// the saved-scene load that follows. Replacing either one also starts a
			// fresh budget without affecting any other leaf.
			const identity = getLeafScannerApi(leaf) ?? leaf.view;
			const previous = retries.get(leaf);
			const attempts = previous?.identity === identity ? previous.attempts : 0;
			if (attempts < READY_RETRY_MAX) {
				pendingRetries.push({ leaf, identity, attempts });
			}
		});
		// A just-opened view's imperative API mounts a beat after the workspace
		// event fires; keep retrying briefly until it's there. Count an attempt only
		// when scheduling the next check: a burst of workspace events while that
		// check is already pending must not consume the whole budget at once.
		if (pendingRetries.length > 0 && retryTimer == null) {
			for (const { leaf, identity, attempts } of pendingRetries) {
				retries.set(leaf, { identity, attempts: attempts + 1 });
			}
			retryTimer = window.setTimeout(() => {
				retryTimer = null;
				reconcile();
			}, READY_RETRY_MS);
		}
	};

	const handle: LeafScannerHandle<TState> = {
		entries: () => Array.from(states.entries()),
		rescan: (leaf) => {
			if (disposed) return;
			const state = states.get(leaf);
			if (state !== undefined) options.scan(leaf, state, handle);
		},
		reconcile,
		isDisposed: () => disposed,
	};

	const workspace = plugin.app.workspace;
	const disposers: Array<() => void> = [
		onEvent(workspace, () => workspace.on("layout-change", reconcile)),
		onEvent(workspace, () => workspace.on("active-leaf-change", reconcile)),
		...(options.extras?.(handle) ?? []),
	];

	reconcile();

	return () => {
		disposed = true;
		if (retryTimer != null) window.clearTimeout(retryTimer);
		for (const dispose of disposers) {
			try {
				dispose();
			} catch {
				/* ignore */
			}
		}
		for (const leaf of Array.from(states.keys())) release(leaf);
	};
}
