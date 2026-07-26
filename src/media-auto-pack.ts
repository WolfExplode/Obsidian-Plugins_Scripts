import type { EventRef, WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { localLinkpath } from "./board-render";
import { getSceneElementFile, isExcalidrawLeaf, optimalPackElementsById, readSceneElements } from "./excalidraw-view";
import { desanitizeAttachmentName } from "./popout-drop-bridge";

const READY_RETRY_MS = 300;
const READY_RETRY_MAX = 20;

interface MediaElement {
	id?: string;
	type?: string;
	fileId?: string | null;
	link?: string | null;
	isDeleted?: boolean;
}

interface MediaPackApi {
	onChange(cb: () => void): () => void;
	getSceneElements(): readonly MediaElement[];
	isDestroyed?: boolean | (() => boolean);
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

interface Subscription {
	unsub: () => void;
	detachDocument: () => void;
	detachBoardSync: () => void;
	known: Set<string>;
	transactions: Transaction[];
	lastDropSignature: string | null;
	lastDropWasTrusted: boolean;
}

function getApi(leaf: WorkspaceLeaf): MediaPackApi | null {
	const api = (leaf.view as unknown as { excalidrawAPI?: Partial<MediaPackApi> }).excalidrawAPI;
	if (!api || typeof api.onChange !== "function" || typeof api.getSceneElements !== "function") return null;
	return api as MediaPackApi;
}

function apiDestroyed(api: MediaPackApi): boolean {
	const destroyed = api.isDestroyed;
	return typeof destroyed === "function" ? destroyed() === true : destroyed === true;
}

function isStillLoading(leaf: WorkspaceLeaf): boolean {
	return (leaf.view as unknown as { semaphores?: { justLoaded?: boolean } }).semaphores?.justLoaded === true;
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

function matchElement(
	plugin: ExcalidrawPureRefPlugin,
	leaf: WorkspaceLeaf,
	transaction: Transaction,
	el: MediaElement,
	debug: (kind: string, data?: Record<string, unknown>) => void,
): boolean {
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
}

function isComplete(transaction: Transaction): boolean {
	return transaction.candidates.length > 0 && transaction.candidates.every((candidate) => candidate.matchedId !== null);
}

/**
 * Packs imported media only after every file in an observed import transaction
 * has produced its matching scene element. Drop/paste handlers provide the
 * transaction's expected files; scene changes provide the authoritative commit
 * signal. No elapsed-time debounce is used.
 */
export function attachMediaAutoPack(plugin: ExcalidrawPureRefPlugin): () => void {
	const subscriptions = new Map<WorkspaceLeaf, Subscription>();
	const debugEvents: Array<Record<string, unknown>> = [];
	const debug = (kind: string, data: Record<string, unknown> = {}) => {
		debugEvents.push({ at: Date.now(), kind, ...data });
		if (debugEvents.length > 100) debugEvents.shift();
	};
	let disposed = false;
	let retryTimer: number | null = null;
	let retriesLeft = READY_RETRY_MAX;

	const scan = (leaf: WorkspaceLeaf, sub: Subscription) => {
		if (disposed) return;
		const elements = readSceneElements(leaf) ?? [];
		for (const raw of elements) {
			const el = raw as MediaElement;
			if (!isMedia(el) || !el.id || sub.known.has(el.id)) continue;
			let matched = false;
			for (const transaction of sub.transactions) {
				if (matchElement(plugin, leaf, transaction, el, debug)) {
					matched = true;
					sub.known.add(el.id);
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
			if (!matched && sub.transactions.length === 0) sub.known.add(el.id);
			else if (!matched) debug("unmatched-no-transaction-accepted", { id: el.id, type: el.type });
		}
	};

	const begin = (leaf: WorkspaceLeaf, sub: Subscription, files: Array<{ name: string; size: number }>, trusted: boolean) => {
		if (files.length === 0) return;
		const signature = candidateSignature(files);
		// The filename-sanitizing bridge re-dispatches the same drop as a synthetic
		// event. The first event is trusted when this listener is installed before
		// the bridge; suppress only that exact follow-up, never arbitrary drops.
		if (!trusted && sub.lastDropWasTrusted && sub.lastDropSignature === signature) {
			debug("ignored-synthetic-duplicate", { files: files.map((file) => file.name) });
			return;
		}
		sub.lastDropSignature = signature;
		sub.lastDropWasTrusted = trusted;
		sub.transactions.push(seedTransaction(plugin, leaf, files, sub.known));
		debug("begin", { trusted, files: files.map((file) => file.name) });
	};


	/**
	 * Obsidian Excalidraw imports each file, saves the Board, then asynchronously
	 * runs synchronizeWithData() to apply that saved snapshot. Packing on the
	 * vault "modify" event races that final sync and is overwritten. The promise
	 * resolving is the authoritative, timer-free "import scene is settled" signal.
	 */
	const attachAfterBoardSync = (leaf: WorkspaceLeaf, sub: Subscription): (() => void) => {
		const view = leaf.view as unknown as {
			synchronizeWithData?: (...args: unknown[]) => Promise<unknown>;
		};
		const original = view.synchronizeWithData;
		if (typeof original !== "function") return () => {};
		const wrapped = function (this: unknown, ...args: unknown[]) {
			const result = original.apply(this, args);
			void Promise.resolve(result).then(() => {
				if (disposed) return;
				debug("board-sync-resolved", {
					transactions: sub.transactions.map((t) => ({
						readyToPack: t.readyToPack,
						pending: t.candidates.filter((c) => !c.matchedId).map((c) => c.name),
					})),
				});
				for (const transaction of [...sub.transactions]) {
					if (!transaction.readyToPack) continue;
					const packed = optimalPackElementsById(leaf, transaction.mediaIds);
					debug("packed-after-board-sync", { ids: Array.from(transaction.mediaIds), packed });
					sub.transactions = sub.transactions.filter((item) => item !== transaction);
				}
			});
			return result;
		};
		view.synchronizeWithData = wrapped;
		return () => {
			if (view.synchronizeWithData === wrapped) view.synchronizeWithData = original;
		};
	};

	const attachDocument = (leaf: WorkspaceLeaf, sub: Subscription): (() => void) => {
		const doc = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl?.ownerDocument;
		if (!doc) return () => {};
		const onDrop = (event: DragEvent) => {
			if (!event.dataTransfer) return;
			if (getLeafForNode(plugin, event.target as Node | null, doc) !== leaf) return;
			begin(leaf, sub, fileCandidates(event.dataTransfer), event.isTrusted);
		};
		const onPaste = (event: ClipboardEvent) => {
			if (getLeafForNode(plugin, event.target as Node | null, doc) !== leaf || !event.clipboardData) return;
			begin(leaf, sub, fileCandidates(event.clipboardData), event.isTrusted);
		};
		doc.addEventListener("drop", onDrop, true);
		doc.addEventListener("paste", onPaste, true);
		return () => {
			doc.removeEventListener("drop", onDrop, true);
			doc.removeEventListener("paste", onPaste, true);
		};
	};

	const attach = (leaf: WorkspaceLeaf): boolean => {
		if (subscriptions.has(leaf)) return true;
		if (!isExcalidrawLeaf(leaf)) return true;
		const api = getApi(leaf);
		if (!api || isStillLoading(leaf)) return false;
		const known = new Set<string>();
		try {
			for (const el of api.getSceneElements()) if (el.id) known.add(el.id);
		} catch {
			return false;
		}
		const sub: Subscription = {
			unsub: () => {},
			detachDocument: () => {},
			detachBoardSync: () => {},
			known,
			transactions: [],
			lastDropSignature: null,
			lastDropWasTrusted: false,
		};
		sub.detachDocument = attachDocument(leaf, sub);
		sub.detachBoardSync = attachAfterBoardSync(leaf, sub);
		try {
			sub.unsub = api.onChange(() => scan(leaf, sub));
		} catch {
			sub.detachDocument();
			sub.detachBoardSync();
			return false;
		}
		subscriptions.set(leaf, sub);
		return true;
	};

	const onCreate = (file: { path: string }) => {
		for (const [leaf, sub] of subscriptions) {
			for (const transaction of sub.transactions) addVaultPath(transaction, file.path);
			if (sub.transactions.length) scan(leaf, sub);
		}
	};

	const prune = () => {
		for (const [leaf, sub] of subscriptions) {
			const api = getApi(leaf);
			if (isExcalidrawLeaf(leaf) && api && !apiDestroyed(api)) continue;
			if (sub.transactions.length) {
				debug("subscription-torn-down-with-pending-transactions", {
					transactions: sub.transactions.map((t) => ({
						readyToPack: t.readyToPack,
						pending: t.candidates.filter((c) => !c.matchedId).map((c) => c.name),
					})),
				});
			}
			try {
				sub.unsub();
				sub.detachDocument();
				sub.detachBoardSync();
			} catch {
				/* view already torn down */
			}
			subscriptions.delete(leaf);
		}
	};

	const reconcile = () => {
		if (disposed) return;
		prune();
		let allReady = true;
		plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!isExcalidrawLeaf(leaf)) return;
			if (!attach(leaf)) allReady = false;
		});
		if (!allReady && retriesLeft > 0 && retryTimer == null) {
			retriesLeft--;
			retryTimer = window.setTimeout(() => {
				retryTimer = null;
				reconcile();
			}, READY_RETRY_MS);
		} else if (allReady) retriesLeft = READY_RETRY_MAX;
	};

	const refs: EventRef[] = [
		plugin.app.workspace.on("layout-change", reconcile),
		plugin.app.workspace.on("active-leaf-change", reconcile),
		plugin.app.vault.on("create", onCreate),
	];
	reconcile();

	// Kept as a live diagnostic because imports may arrive through native drops,
	// the filename-sanitizing bridge, or a modal long after the initial event.
	// It is read-only and lets us inspect which transaction/file is still waiting.
	(window as unknown as Record<string, unknown>).__eprMediaPackDebug = {
		state: () =>
			({
				events: debugEvents,
				subscriptions: Array.from(subscriptions.entries()).map(([leaf, sub]) => ({
				file: (leaf.view as unknown as { file?: { path?: string } }).file?.path,
				transactions: sub.transactions.map((transaction) =>
					({
						readyToPack: transaction.readyToPack,
						candidates: transaction.candidates.map((candidate) => ({
							name: candidate.name,
							paths: Array.from(candidate.paths),
							matchedId: candidate.matchedId,
						})),
					}),
				),
			})),
			}),
	};

	return () => {
		disposed = true;
		if (retryTimer != null) window.clearTimeout(retryTimer);
		for (const ref of refs) plugin.app.workspace.offref(ref);
		for (const sub of subscriptions.values()) {
			try {
				sub.unsub();
				sub.detachDocument();
				sub.detachBoardSync();
			} catch {
				/* ignore */
			}
		}
		subscriptions.clear();
		delete (window as unknown as Record<string, unknown>).__eprMediaPackDebug;
	};
}
