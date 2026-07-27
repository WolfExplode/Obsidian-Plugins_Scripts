import type { WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { localLinkpath } from "./board-render";
import { getSceneElementFile, isExcalidrawLeaf, optimalPackElementsById, readSceneElements } from "./excalidraw-view";
import { desanitizeAttachmentName } from "./popout-drop-bridge";
import { attachPerLeafScanner, onEvent, type LeafScannerApi, type LeafScannerHandle } from "./leaf-scanner";

/**
 * Packs imported media only after every file in an observed import transaction
 * has produced its matching scene element. Drop/paste handlers provide the
 * transaction's expected files; scene changes provide the authoritative commit
 * signal. No elapsed-time debounce is used.
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
}

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

function basename(path: string): string {
	return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function normalizedName(name: string): string {
	// The popout-drop-bridge rewrites wikilink-unsafe characters (# ^ [ ] |) to
	// full-width look-alikes before Excalidraw ever writes the file, so the vault
	// path and the originally-dropped filename can legitimately differ only in
	// those characters. Fold both back to ASCII before comparing.
	const base = desanitizeAttachmentName(basename(name)).toLowerCase();
	return base.replace(/_(\d+)(\.[^.]+)$/i, "$2");
}

function namesMatch(source: string, targetPath: string): boolean {
	const sourceBase = desanitizeAttachmentName(basename(source)).toLowerCase();
	const targetBase = desanitizeAttachmentName(basename(targetPath)).toLowerCase();
	return sourceBase === targetBase || normalizedName(source) === normalizedName(targetPath);
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
	return { candidates, baselineIds: new Set(known), mediaIds: new Set(), readyToPack: false };
}

function addVaultPath(transaction: Transaction, path: string): void {
	const candidate = transaction.candidates.find((item) => !item.paths.has(path) && namesMatch(item.name, path));
	if (candidate) candidate.paths.add(path);
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
			(item) => item.matchedId === null && (item.paths.has(path) || namesMatch(item.name, path)),
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
		for (const raw of readSceneElements(leaf) ?? []) {
			const el = raw as MediaElement;
			if (!isMedia(el) || !el.id || state.known.has(el.id)) continue;
			let matched = false;
			for (const transaction of state.transactions) {
				if (matchElement(leaf, transaction, el)) {
					matched = true;
					state.known.add(el.id);
					debug("matched", { id: el.id, type: el.type, remaining: transaction.candidates.filter((c) => !c.matchedId).map((c) => c.name) });
					if (isComplete(transaction)) {
						// Each importer branch eventually saves the Board after adding its
						// elements. Updating in this onChange is too early: a pending
						// embeddable write can subsequently restore an older scene snapshot.
						transaction.readyToPack = true;
						debug("ready-for-board-save", { ids: Array.from(transaction.mediaIds) });
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
		state.transactions.push(seedTransaction(plugin, leaf, files, state.known));
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
			synchronizeWithData?: (...args: unknown[]) => Promise<unknown>;
		};
		const original = view.synchronizeWithData;
		if (typeof original !== "function") return () => {};
		const wrapped = function (this: unknown, ...args: unknown[]) {
			const result = original.apply(this, args);
			void Promise.resolve(result).then(() => {
				if (scanner.isDisposed()) return;
				debug("board-sync-resolved", {
					transactions: state.transactions.map((t) => ({
						readyToPack: t.readyToPack,
						pending: t.candidates.filter((c) => !c.matchedId).map((c) => c.name),
					})),
				});
				for (const transaction of [...state.transactions]) {
					if (!transaction.readyToPack) continue;
					const packed = optimalPackElementsById(leaf, transaction.mediaIds);
					debug("packed-after-board-sync", { ids: Array.from(transaction.mediaIds), packed });
					state.transactions = state.transactions.filter((item) => item !== transaction);
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
		if (state.transactions.length) {
			debug("subscription-torn-down-with-pending-transactions", {
				transactions: state.transactions.map((t) => ({
					readyToPack: t.readyToPack,
					pending: t.candidates.filter((c) => !c.matchedId).map((c) => c.name),
				})),
			});
		}
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
						for (const transaction of state.transactions) addVaultPath(transaction, file.path);
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
