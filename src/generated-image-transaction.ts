import {
	elementRevisionMatches,
	stampElementPatch,
	type ElementPatch,
	type MutableSceneElement,
} from "./excalidraw-element-mutation";

export interface GeneratedImageElement extends MutableSceneElement {
	id: string;
	fileId?: string | null;
	[key: string]: unknown;
}

export interface GeneratedImageBinary {
	id: string;
	dataURL: string;
	mimeType: string;
	created: number;
}

export interface GeneratedImageAsset {
	id: string;
	path: string;
	data: ArrayBuffer;
	binary: GeneratedImageBinary;
}

export interface GeneratedImageRef {
	fileId: string;
	path: string;
}

export interface GeneratedImageChange {
	id: string;
	expected: { version?: number; versionNonce?: number };
	patch: ElementPatch<GeneratedImageElement>;
}

export type GeneratedImageFileMap = Record<string, {
	dataURL?: string;
	mimeType?: string;
	created?: number;
} | undefined>;

export interface GeneratedImageTransactionAdapter<TAsset extends GeneratedImageAsset> {
	readElements(): readonly GeneratedImageElement[];
	createAttachment(asset: TAsset): Promise<void>;
	registerGenerated(asset: TAsset): void | Promise<void>;
	stageCoreFiles(files: readonly GeneratedImageBinary[]): GeneratedImageFileMap;
	writeScene(elements: readonly GeneratedImageElement[], files?: GeneratedImageFileMap): void;
	rollbackRegistration(asset: TAsset): void | Promise<void>;
	retireRegistration(fileId: string): void | Promise<void>;
	deleteAttachment(path: string): Promise<void>;
	afterRendererTurn(): Promise<void>;
	randomVersionNonce(): number;
	now(): number;
}

export type GeneratedImageTransactionStage = "preflight" | "create" | "register" | "core" | "commit";

export type GeneratedImageTransactionResult =
	| { status: "applied"; changedIds: string[]; cleanupPending: GeneratedImageRef[]; cleanupErrors: unknown[] }
	| { status: "conflict"; rollbackErrors: unknown[] }
	| { status: "failed"; stage: GeneratedImageTransactionStage; error: unknown; rollbackErrors: unknown[] }
	| { status: "indeterminate"; error?: unknown };

export interface GeneratedImageTransaction<TAsset extends GeneratedImageAsset> {
	changes: readonly GeneratedImageChange[];
	created: readonly TAsset[];
	/** Existing binaries that changed elements will reference after the commit. */
	requiredCoreFiles?: readonly GeneratedImageBinary[];
	retire?: readonly GeneratedImageRef[];
	cleanupAttempts?: number;
}

function revisionsMatch(elements: readonly GeneratedImageElement[], changes: readonly GeneratedImageChange[]): boolean {
	const byId = new Map(elements.map((element) => [element.id, element]));
	return changes.every((change) => elementRevisionMatches(byId.get(change.id), change.expected));
}

async function rollbackCreated<TAsset extends GeneratedImageAsset>(
	adapter: GeneratedImageTransactionAdapter<TAsset>,
	created: readonly TAsset[],
): Promise<unknown[]> {
	const errors: unknown[] = [];
	for (const asset of [...created].reverse()) {
		let registrationRemoved = true;
		try {
			await adapter.rollbackRegistration(asset);
		} catch (error) {
			registrationRemoved = false;
			errors.push(error);
		}
		// Retaining an orphaned attachment is safer than leaving a durable
		// registration pointing at a path this rollback deleted.
		if (!registrationRemoved) continue;
		try {
			await adapter.deleteAttachment(asset.path);
		} catch (error) {
			errors.push(error);
		}
	}
	return errors;
}

async function retireDetached<TAsset extends GeneratedImageAsset>(
	adapter: GeneratedImageTransactionAdapter<TAsset>,
	files: readonly GeneratedImageRef[],
	maxAttempts: number,
): Promise<{ pending: GeneratedImageRef[]; errors: unknown[] }> {
	let pending = [...files];
	const errors: unknown[] = [];
	for (let attempt = 0; attempt < maxAttempts && pending.length > 0; attempt++) {
		try {
			await adapter.afterRendererTurn();
		} catch (error) {
			errors.push(error);
			continue;
		}

		let referenced: Set<string>;
		try {
			referenced = new Set(adapter.readElements().map((element) => element.fileId).filter((id): id is string => !!id));
		} catch (error) {
			errors.push(error);
			continue;
		}

		const nextPending: GeneratedImageRef[] = [];
		for (const file of pending) {
			if (referenced.has(file.fileId)) {
				nextPending.push(file);
				continue;
			}
			try {
				await adapter.retireRegistration(file.fileId);
				await adapter.deleteAttachment(file.path);
			} catch (error) {
				errors.push(error);
				nextPending.push(file);
			}
		}
		pending = nextPending;
	}
	return { pending, errors };
}

function buildCommit(
	elements: readonly GeneratedImageElement[],
	changes: readonly GeneratedImageChange[],
	adapter: Pick<GeneratedImageTransactionAdapter<GeneratedImageAsset>, "randomVersionNonce" | "now">,
): { elements: GeneratedImageElement[]; committedNonces: Map<string, number> } | null {
	if (!revisionsMatch(elements, changes)) return null;
	const byId = new Map(changes.map((change) => [change.id, change]));
	const committedNonces = new Map<string, number>();
	const updated = adapter.now();
	const next = elements.map((element) => {
		const change = byId.get(element.id);
		if (!change) return element;
		const versionNonce = adapter.randomVersionNonce();
		committedNonces.set(element.id, versionNonce);
		return stampElementPatch(element, change.patch, versionNonce, updated);
	});
	return { elements: next, committedNonces };
}

function inspectCommit<TAsset extends GeneratedImageAsset>(
	adapter: GeneratedImageTransactionAdapter<TAsset>,
	committedNonces: ReadonlyMap<string, number>,
): "applied" | "missing" | "indeterminate" {
	try {
		const byId = new Map(adapter.readElements().map((element) => [element.id, element]));
		for (const [id, nonce] of committedNonces) {
			if (byId.get(id)?.versionNonce !== nonce) return "missing";
		}
		return "applied";
	} catch {
		return "indeterminate";
	}
}

/**
 * Creates, registers, and commits generated images as one optimistic transaction.
 * Durable rollback is complete; Excalidraw core files are additive-only and may
 * retain harmless session residue after a failed post-add commit.
 */
export async function applyGeneratedImageTransaction<TAsset extends GeneratedImageAsset>(
	adapter: GeneratedImageTransactionAdapter<TAsset>,
	transaction: GeneratedImageTransaction<TAsset>,
): Promise<GeneratedImageTransactionResult> {
	let stage: GeneratedImageTransactionStage = "preflight";
	try {
		if (!revisionsMatch(adapter.readElements(), transaction.changes)) {
			return { status: "conflict", rollbackErrors: [] };
		}
	} catch (error) {
		return { status: "failed", stage, error, rollbackErrors: [] };
	}

	const created: TAsset[] = [];
	try {
		for (const asset of transaction.created) {
			stage = "create";
			// Paths contain the transaction-unique fileId, so this transaction owns
			// cleanup even when createAttachment mutates and then rejects.
			created.push(asset);
			await adapter.createAttachment(asset);
			stage = "register";
			await adapter.registerGenerated(asset);
		}

		stage = "preflight";
		const latest = adapter.readElements();
		if (!revisionsMatch(latest, transaction.changes)) {
			return { status: "conflict", rollbackErrors: await rollbackCreated(adapter, created) };
		}

		let files: GeneratedImageFileMap | undefined;
		const binariesById = new Map(
			(transaction.requiredCoreFiles ?? []).map((binary) => [binary.id, binary]),
		);
		for (const asset of transaction.created) binariesById.set(asset.binary.id, asset.binary);
		const binaries = [...binariesById.values()];
		if (binaries.length > 0) {
			stage = "core";
			files = adapter.stageCoreFiles(binaries);
		}

		stage = "commit";
		// Core registration can synchronously notify consumers. Re-read here so
		// the full scene array cannot overwrite an unrelated edit made while this
		// transaction was staging its files.
		const commit = buildCommit(adapter.readElements(), transaction.changes, adapter);
		if (!commit) {
			return { status: "conflict", rollbackErrors: await rollbackCreated(adapter, created) };
		}
		let writeError: unknown;
		try {
			adapter.writeScene(commit.elements, files);
		} catch (error) {
			writeError = error;
		}
		const state = inspectCommit(adapter, commit.committedNonces);
		if (state === "indeterminate") return { status: "indeterminate", ...(writeError ? { error: writeError } : {}) };
		if (state !== "applied") {
			const error = writeError ?? new Error("Generated-image scene commit did not apply");
			return { status: "failed", stage, error, rollbackErrors: await rollbackCreated(adapter, created) };
		}

		const cleanup = await retireDetached(adapter, transaction.retire ?? [], transaction.cleanupAttempts ?? 20);
		return {
			status: "applied",
			changedIds: transaction.changes.map((change) => change.id),
			cleanupPending: cleanup.pending,
			cleanupErrors: cleanup.errors,
		};
	} catch (error) {
		return { status: "failed", stage, error, rollbackErrors: await rollbackCreated(adapter, created) };
	}
}
