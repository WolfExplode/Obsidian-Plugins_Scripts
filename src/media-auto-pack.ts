import type { WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { localLinkpath } from "./board-render";
import { getSceneElementFile, isExcalidrawLeaf, optimalPackElementsById, readSceneElements } from "./excalidraw-view";
import { desanitizeAttachmentName } from "./popout-drop-bridge";
import { attachPerLeafScanner, onEvent, type LeafScannerApi, type LeafScannerHandle } from "./leaf-scanner";
import { importFileMatchesVaultPath } from "./import-file-match";

/**
 * Packs imported media only after every file in an observed import transaction
 * has produced its matching scene element. Drop/paste handlers provide the
 * transaction's expected files; scene changes provide the authoritative commit
 * signal — packing waits for the importer's own `synchronizeWithData` call to
 * resolve, not a debounce timer. FALLBACK_PACK_MS below is the one deliberate
 * exception, for import paths that never call synchronizeWithData at all; see
 * its comment for why a timer is unavoidable there.
 *
 * The attach/detach lifecycle across the main window and every Popout is shared
 * with the other scene watchers — see leaf-scanner.ts.
 */

interface MediaElement {
	id?: string;
	type?: string;
	fileId?: string | null;
	link?: string | null;
	isDeleted?: boolean;
}

interface Candidate {
	name: string;
	size: number;
	paths: Set<string>;
	matchedId: string | null;
}

interface Transaction {
	candidates: Candidate[];
	baselineIds: Set<string>;
	mediaIds: Set<string>;
	/** All expected elements exist; wait for the importer's following board save. */
	readyToPack: boolean;
	/**
	 * Safety-net timer for import paths that never call `synchronizeWithData`
	 * (see FALLBACK_PACK_MS below). Cleared whenever the primary signal packs
	 * the transaction first, or the transaction is invalidated.
	 */
	fallbackTimer: number | null;
	/** Removes a transaction that stops making progress; never triggers packing. */
	expiryTimer: number | null;
}

/**
 * Some import paths never re-trigger `view.synchronizeWithData` at all — e.g.
 * confirming the "Insert File From Vault" modal for a PDF calls
 * `ea.addElementsToView()` -> `view.addElements({save: true})` ->
 * `view.save()` directly, and nothing ever calls synchronizeWithData for that
 * insert. A transaction can then sit at readyToPack forever with no signal to
 * pack it.
 *
 * `view.save()` was considered as a tighter trigger here (traced into the
 * Excalidraw plugin's bundled source: addElements only awaits `this.save()`
 * when its `save` param is true). It was rejected: instrumenting a live save
 * showed `view.save()` firing *twice* for a single PDF insert — once from
 * addElements, once more shortly after from the embeddable's own async resize
 * once its rendered size is measured — so a save resolving does not reliably
 * mean "nothing more is coming." The normal drag-drop path likely calls save()
 * per file too, while still following up with the real synchronizeWithData
 * reload the rest of this module is built around. Using save() to shorten the
 * wait risks packing early on that path and then having the later
 * synchronizeWithData reload silently revert it — the exact race this module's
 * synchronizeWithData-only design exists to avoid.
 *
 * There is no way to positively detect "no synchronizeWithData is ever
 * coming" — only bound how long we wait for one. This is that bound: long
 * enough that every observed synchronizeWithData-driven pack in this codebase
 * finished well within it, so it should never race a real one; hit only when
 * synchronizeWithData is confirmed to never fire, as measured for this
 * PDF-via-modal path.
 *
 * Note: Excalidraw's own bundle reaches for the identical tool for a
 * structurally identical gap — `ExcalidrawView.setPreventReload()` arms its
 * self-reload guard with a plain `window.setTimeout(..., 2000)` because
 * there's no event for "it is now safe to reload" either. Same shape of
 * problem, same shape of fix, from the plugin whose internals we don't
 * control — not a workaround to keep trying to eliminate.
 */
const FALLBACK_PACK_MS = 1000;

/**
 * Incomplete imports have no authoritative "this file will never create an
 * element" event. Bound their in-memory lifetime after the last observed
 * progress without using elapsed time to decide when it is safe to pack.
 */
const TRANSACTION_IDLE_EXPIRY_MS = 5 * 60_000;

/** Per-view state: the document/view hooks this leaf owns plus its import transactions. */
interface PackState {
	detachDocument: () => void;
	detachBoardSync: () => void;
	known: Set<string>;
	transactions: Transaction[];
	lastDropSignature: string | null;
	lastDropWasTrusted: boolean;
}

function isMedia(el: MediaElement): boolean {
	return !!el.id && !el.isDeleted && (el.type === "image" || (el.type === "embeddable" && !!localLinkpath(el.link)));
}

function getLeafForNode(plugin: ExcalidrawPureRefPlugin, node: Node | null, doc: Document): WorkspaceLeaf | null {
	let containing: WorkspaceLeaf | null = null;
	let sameDocument: WorkspaceLeaf | null = null;
	plugin.app.workspace.iterateAllLeaves((leaf) => {
		if (containing || !isExcalidrawLeaf(leaf)) return;
		const container = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
		if (!container || container.ownerDocument !== doc) return;
		if (node && container.contains(node)) containing = leaf;
		else if (!sameDocument) sameDocument = leaf;
	});
	return containing ?? sameDocument;
}

function fileCandidates(transfer: DataTransfer | ClipboardEvent["clipboardData"]): Array<{ name: string; size: number }> {
	return Array.from(transfer?.files ?? []).map((file) => ({ name: file.name, size: file.size }));
}

function candidateSignature(files: Array<{ name: string; size: number }>): string {
	// Canonicalize names so the bridge's sanitized re-dispatch (see
	// desanitizeAttachmentName) produces the same signature as the original
	// trusted drop it echoes, letting the synthetic-duplicate check below
	// recognize and suppress it instead of seeding a second transaction.
	return files.map((file) => `${desanitizeAttachmentName(file.name)}\u0000${file.size}`).join("\u0001");
}

function scenePath(plugin: ExcalidrawPureRefPlugin, leaf: WorkspaceLeaf, el: MediaElement): string | null {
	if (el.type === "image" && el.fileId) return getSceneElementFile(leaf, el.fileId)?.path ?? null;
	const path = localLinkpath(el.link);
	if (!path) return null;
	const boardPath = (leaf.view as unknown as { file?: { path?: string } }).file?.path;
	return boardPath ? plugin.app.metadataCache.getFirstLinkpathDest(path, boardPath)?.path ?? null : null;
}

function seedTransaction(plugin: ExcalidrawPureRefPlugin, leaf: WorkspaceLeaf, files: Array<{ name: string; size: number }>, known: Set<string>): Transaction {
	const boardPath = (leaf.view as unknown as { file?: { path?: string } }).file?.path;
	const candidates = files.map((file) => {
		const paths = new Set<string>();
		if (boardPath) {
			const dest = plugin.app.metadataCache.getFirstLinkpathDest(file.name, boardPath);
			if (dest) paths.add(dest.path);
		}
		return { name: file.name, size: file.size, paths, matchedId: null };
	});
	return {
		candidates,
		baselineIds: new Set(known),
		mediaIds: new Set(),
		readyToPack: false,
		fallbackTimer: null,
		expiryTimer: null,
	};
}

function addVaultPath(transaction: Transaction, path: string): boolean {
	const candidate = transaction.candidates.find(
		(item) => !item.paths.has(path) && importFileMatchesVaultPath(item.name, path),
	);
	if (!candidate) return false;
	candidate.paths.add(path);
	return true;
}

function isComplete(transaction: Transaction): boolean {
	return transaction.candidates.length > 0 && transaction.candidates.every((candidate) => candidate.matchedId !== null);
}

export function attachMediaAutoPack(plugin: ExcalidrawPureRefPlugin): () => void {
	const debugEvents: Array<Record<string, unknown>> = [];
	const debug = (kind: string, data: Record<string, unknown> = {}) => {
		debugEvents.push({ at: Date.now(), kind, ...data });
		if (debugEvents.length > 100) debugEvents.shift();
	};

	const clearTransactionTimers = (transaction: Transaction) => {
		if (transaction.fallbackTimer != null) window.clearTimeout(transaction.fallbackTimer);
		if (transaction.expiryTimer != null) window.clearTimeout(transaction.expiryTimer);
		transaction.fallbackTimer = null;
		transaction.expiryTimer = null;
	};

	const scheduleExpiry = (state: PackState, transaction: Transaction) => {
		if (transaction.expiryTimer != null) window.clearTimeout(transaction.expiryTimer);
		transaction.expiryTimer = window.setTimeout(() => {
			transaction.expiryTimer = null;
			if (!state.transactions.includes(transaction)) return;
			if (transaction.fallbackTimer != null) window.clearTimeout(transaction.fallbackTimer);
			transaction.fallbackTimer = null;
			debug("transaction-expired", {
				matched: Array.from(transaction.mediaIds),
				pending: transaction.candidates.filter((candidate) => !candidate.matchedId).map((candidate) => candidate.name),
			});
			state.transactions = state.transactions.filter((item) => item !== transaction);
		}, TRANSACTION_IDLE_EXPIRY_MS);
	};

	/** Packs one transaction and removes it from state, wherever the trigger came from. */
	const packTransaction = (leaf: WorkspaceLeaf, state: PackState, transaction: Transaction, source: string) => {
		if (!state.transactions.includes(transaction)) return;
		clearTransactionTimers(transaction);
		const packed = optimalPackElementsById(leaf, transaction.mediaIds);
		debug("packed", { source, ids: Array.from(transaction.mediaIds), packed });
		state.transactions = state.transactions.filter((item) => item !== transaction);
	};

	/** (Re)schedules a transaction's fallback pack after `delayMs`, replacing any pending one. */
	const scheduleFallback = (leaf: WorkspaceLeaf, state: PackState, transaction: Transaction, delayMs: number) => {
		if (transaction.fallbackTimer != null) window.clearTimeout(transaction.fallbackTimer);
		transaction.fallbackTimer = window.setTimeout(() => {
			transaction.fallbackTimer = null;
			packTransaction(leaf, state, transaction, "fallback-timer");
		}, delayMs);
	};

	const matchElement = (leaf: WorkspaceLeaf, transaction: Transaction, el: MediaElement): boolean => {
		if (!el.id || transaction.baselineIds.has(el.id) || transaction.mediaIds.has(el.id)) return false;
		const path = scenePath(plugin, leaf, el);
		if (!path) {
			debug("no-scene-path", {
				id: el.id,
				type: el.type,
				fileId: el.fileId ?? null,
				link: el.link ?? null,
				pendingCandidates: transaction.candidates.filter((c) => !c.matchedId).map((c) => c.name),
			});
			return false;
		}
		const candidate = transaction.candidates.find(
			(item) => item.matchedId === null && (item.paths.has(path) || importFileMatchesVaultPath(item.name, path)),
		);
		if (!candidate) {
			debug("no-candidate-for-path", {
				id: el.id,
				type: el.type,
				path,
				pendingCandidates: transaction.candidates.filter((c) => !c.matchedId).map((c) => ({ name: c.name, paths: Array.from(c.paths) })),
			});
			return false;
		}
		candidate.matchedId = el.id;
		transaction.mediaIds.add(el.id);
		return true;
	};

	const scan = (leaf: WorkspaceLeaf, state: PackState) => {
		const elements = readSceneElements(leaf) ?? [];

		// Some import paths (e.g. Excalidraw's native animated-image handling)
		// insert an element, then asynchronously swap it for a different element
		// at the same file (add the replacement, delete the original). If a
		// candidate already matched the now-deleted element, its slot must be
		// freed so the replacement — which shares the same vault path but a
		// different id — can bind instead of being permanently orphaned.
		const currentIds = new Set(elements.map((raw) => (raw as MediaElement).id).filter((id): id is string => !!id));
		for (const transaction of state.transactions) {
			for (const candidate of transaction.candidates) {
				if (!candidate.matchedId || currentIds.has(candidate.matchedId)) continue;
				const staleId = candidate.matchedId;
				transaction.mediaIds.delete(staleId);
				candidate.matchedId = null;
				transaction.readyToPack = false;
				if (transaction.fallbackTimer != null) {
					window.clearTimeout(transaction.fallbackTimer);
					transaction.fallbackTimer = null;
				}
				debug("candidate-freed-element-deleted", { name: candidate.name, staleId });
			}
		}

		for (const raw of elements) {
			const el = raw as MediaElement;
			if (!isMedia(el) || !el.id || state.known.has(el.id)) continue;
			let matched = false;
			for (const transaction of state.transactions) {
				if (matchElement(leaf, transaction, el)) {
					matched = true;
					state.known.add(el.id);
					scheduleExpiry(state, transaction);
					debug("matched", { id: el.id, type: el.type, remaining: transaction.candidates.filter((c) => !c.matchedId).map((c) => c.name) });
					if (isComplete(transaction)) {
						// Each importer branch eventually saves the Board after adding its
						// elements. Updating in this onChange is too early: a pending
						// embeddable write can subsequently restore an older scene snapshot.
						transaction.readyToPack = true;
						debug("ready-for-board-save", { ids: Array.from(transaction.mediaIds) });
						scheduleFallback(leaf, state, transaction, FALLBACK_PACK_MS);
					}
					break;
				}
			}
			// Keep an unresolved new element eligible for a later scan: Excalidraw
			// can publish the scene element before its image registry entry exists.
			// Once no transaction is waiting, it is ordinary pre-existing content.
			if (!matched && state.transactions.length === 0) state.known.add(el.id);
			else if (!matched) debug("unmatched-no-transaction-accepted", { id: el.id, type: el.type });
		}
	};

	const begin = (leaf: WorkspaceLeaf, state: PackState, files: Array<{ name: string; size: number }>, trusted: boolean) => {
		if (files.length === 0) return;
		const signature = candidateSignature(files);
		// The filename-sanitizing bridge re-dispatches the same drop as a synthetic
		// event. The first event is trusted when this listener is installed before
		// the bridge; suppress only that exact follow-up, never arbitrary drops.
		if (!trusted && state.lastDropWasTrusted && state.lastDropSignature === signature) {
			debug("ignored-synthetic-duplicate", { files: files.map((file) => file.name) });
			return;
		}
		state.lastDropSignature = signature;
		state.lastDropWasTrusted = trusted;
		const transaction = seedTransaction(plugin, leaf, files, state.known);
		state.transactions.push(transaction);
		scheduleExpiry(state, transaction);
		debug("begin", { trusted, files: files.map((file) => file.name) });
	};

	/**
	 * Obsidian Excalidraw imports each file, saves the Board, then asynchronously
	 * runs synchronizeWithData() to apply that saved snapshot. Packing on the
	 * vault "modify" event races that final sync and is overwritten. The promise
	 * resolving is the authoritative, timer-free "import scene is settled" signal.
	 */
	const attachAfterBoardSync = (
		leaf: WorkspaceLeaf,
		state: PackState,
		scanner: LeafScannerHandle<PackState>,
	): (() => void) => {
		const view = leaf.view as unknown as {
			synchronizeWithData?: (this: unknown, ...args: unknown[]) => Promise<unknown>;
		};
		const original = view.synchronizeWithData;
		if (typeof original !== "function") return () => {};
		const wrapped = function (this: unknown, ...args: unknown[]) {
			const result = original.call(this, ...args);
			void Promise.resolve(result).then(() => {
				if (scanner.isDisposed()) return;
				const stillOwned = scanner.entries().some(([ownedLeaf, ownedState]) => ownedLeaf === leaf && ownedState === state);
				if (!stillOwned) return;
				debug("board-sync-resolved", {
					transactions: state.transactions.map((t) => ({
						readyToPack: t.readyToPack,
						pending: t.candidates.filter((c) => !c.matchedId).map((c) => c.name),
					})),
				});
				for (const transaction of [...state.transactions]) {
					if (!transaction.readyToPack) continue;
					packTransaction(leaf, state, transaction, "board-sync");
				}
			});
			return result;
		};
		view.synchronizeWithData = wrapped;
		return () => {
			if (view.synchronizeWithData === wrapped) view.synchronizeWithData = original;
		};
	};

	const attachDocument = (leaf: WorkspaceLeaf, state: PackState): (() => void) => {
		const doc = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl?.ownerDocument;
		if (!doc) return () => {};
		const onDrop = (event: DragEvent) => {
			if (!event.dataTransfer) return;
			if (getLeafForNode(plugin, event.target as Node | null, doc) !== leaf) return;
			begin(leaf, state, fileCandidates(event.dataTransfer), event.isTrusted);
		};
		const onPaste = (event: ClipboardEvent) => {
			if (getLeafForNode(plugin, event.target as Node | null, doc) !== leaf || !event.clipboardData) return;
			begin(leaf, state, fileCandidates(event.clipboardData), event.isTrusted);
		};
		doc.addEventListener("drop", onDrop, true);
		doc.addEventListener("paste", onPaste, true);
		return () => {
			doc.removeEventListener("drop", onDrop, true);
			doc.removeEventListener("paste", onPaste, true);
		};
	};

	const setup = (leaf: WorkspaceLeaf, api: LeafScannerApi, scanner: LeafScannerHandle<PackState>): PackState | null => {
		const known = new Set<string>();
		try {
			for (const el of api.getSceneElements()) if (el.id) known.add(el.id);
		} catch {
			return null;
		}
		const state: PackState = {
			detachDocument: () => {},
			detachBoardSync: () => {},
			known,
			transactions: [],
			lastDropSignature: null,
			lastDropWasTrusted: false,
		};
		state.detachDocument = attachDocument(leaf, state);
		state.detachBoardSync = attachAfterBoardSync(leaf, state, scanner);
		return state;
	};

	const teardown = (_leaf: WorkspaceLeaf, state: PackState) => {
		for (const transaction of state.transactions) {
			clearTransactionTimers(transaction);
		}
		if (state.transactions.length) {
			debug("subscription-torn-down-with-pending-transactions", {
				transactions: state.transactions.map((t) => ({
					readyToPack: t.readyToPack,
					pending: t.candidates.filter((c) => !c.matchedId).map((c) => c.name),
				})),
			});
		}
		state.transactions = [];
		state.detachDocument();
		state.detachBoardSync();
	};

	return attachPerLeafScanner<PackState>(plugin, {
		setup,
		scan,
		teardown,
		extras: (scanner) => {
			// Released through the vault, NOT the workspace: an EventRef must be
			// unregistered on the same Events instance it was registered on.
			const vault = plugin.app.vault;
			const detachCreate = onEvent(vault, () =>
				vault.on("create", (file) => {
					for (const [leaf, state] of scanner.entries()) {
						for (const transaction of state.transactions) {
							if (addVaultPath(transaction, file.path)) scheduleExpiry(state, transaction);
						}
						if (state.transactions.length) scanner.rescan(leaf);
					}
				}),
			);

			// Kept as a live diagnostic because imports may arrive through native drops,
			// the filename-sanitizing bridge, or a modal long after the initial event.
			// It is read-only and lets us inspect which transaction/file is still waiting.
			(window as unknown as Record<string, unknown>).__eprMediaPackDebug = {
				state: () => ({
					events: debugEvents,
					subscriptions: scanner.entries().map(([leaf, state]) => ({
						file: (leaf.view as unknown as { file?: { path?: string } }).file?.path,
						transactions: state.transactions.map((transaction) => ({
							readyToPack: transaction.readyToPack,
							candidates: transaction.candidates.map((candidate) => ({
								name: candidate.name,
								paths: Array.from(candidate.paths),
								matchedId: candidate.matchedId,
							})),
						})),
					})),
				}),
			};

			return [
				detachCreate,
				() => {
					delete (window as unknown as Record<string, unknown>).__eprMediaPackDebug;
				},
			];
		},
	});
}
