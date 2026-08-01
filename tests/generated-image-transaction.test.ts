import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyGeneratedImageTransaction,
	type GeneratedImageAsset,
	type GeneratedImageBinary,
	type GeneratedImageElement,
	type GeneratedImageFileMap,
	type GeneratedImageTransactionAdapter,
} from "../src/generated-image-transaction";

class MemoryGeneratedImages implements GeneratedImageTransactionAdapter<GeneratedImageAsset> {
	elements: GeneratedImageElement[] = [
		{ id: "target", x: 1, fileId: "old", version: 2, versionNonce: 20 },
		{ id: "other", x: 10, version: 1, versionNonce: 10 },
	];
	coreFiles: GeneratedImageFileMap = { existing: { dataURL: "existing" } };
	attachments = new Set<string>();
	registrations = new Set<string>();
	deleted: string[] = [];
	retired: string[] = [];
	writes = 0;
	nonce = 100;
	registerFailure = false;
	writeBehavior: "apply" | "noop" | "apply-then-throw" = "apply";
	throwReadsAfterWrite = false;
	onCreate?: () => void;
	onAddCore?: () => void;

	readElements(): readonly GeneratedImageElement[] {
		if (this.throwReadsAfterWrite && this.writes > 0) throw new Error("scene unreadable");
		return this.elements;
	}
	async createAttachment(asset: GeneratedImageAsset): Promise<void> {
		this.attachments.add(asset.path);
		this.onCreate?.();
	}
	registerGenerated(asset: GeneratedImageAsset): void {
		this.registrations.add(asset.id);
		if (this.registerFailure) throw new Error("register failed after mutation");
	}
	stageCoreFiles(files: readonly GeneratedImageBinary[]): GeneratedImageFileMap {
		for (const file of files) this.coreFiles[file.id] = file;
		this.onAddCore?.();
		return { ...this.coreFiles };
	}
	writeScene(elements: readonly GeneratedImageElement[], files?: GeneratedImageFileMap): void {
		this.writes++;
		if (this.writeBehavior !== "noop") {
			this.elements = [...elements];
			if (files) this.coreFiles = files;
		}
		if (this.writeBehavior === "apply-then-throw") throw new Error("host wrapper threw after apply");
	}
	rollbackRegistration(asset: GeneratedImageAsset): void { this.registrations.delete(asset.id); }
	retireRegistration(fileId: string): void {
		this.retired.push(fileId);
		this.registrations.delete(fileId);
	}
	async deleteAttachment(path: string): Promise<void> {
		this.deleted.push(path);
		this.attachments.delete(path);
	}
	async afterRendererTurn(): Promise<void> {}
	randomVersionNonce(): number { return ++this.nonce; }
	now(): number { return 1234; }
}

function asset(id = "new"): GeneratedImageAsset {
	return {
		id,
		path: `.generated/target-${id}.png`,
		data: new ArrayBuffer(1),
		binary: { id, dataURL: `data:${id}`, mimeType: "image/png", created: 1 },
	};
}

function transaction(created: readonly GeneratedImageAsset[] = [asset()]) {
	return {
		changes: [{
			id: "target",
			expected: { version: 2, versionNonce: 20 },
			patch: { x: 5, fileId: "new" },
		}],
		created,
		retire: [{ fileId: "old", path: ".generated/old.png" }],
	};
}

describe("applyGeneratedImageTransaction", () => {
	it("commits against fresh scene state and retires the detached image", async () => {
		const adapter = new MemoryGeneratedImages();
		adapter.attachments.add(".generated/old.png");
		adapter.registrations.add("old");
		adapter.onAddCore = () => {
			adapter.elements = adapter.elements.map((element) =>
				element.id === "other" ? { ...element, x: 99, version: 2, versionNonce: 11 } : element,
			);
		};

		const result = await applyGeneratedImageTransaction(adapter, transaction());

		assert.equal(result.status, "applied");
		assert.equal(adapter.elements.find((element) => element.id === "target")?.x, 5);
		assert.equal(adapter.elements.find((element) => element.id === "target")?.versionNonce, 101);
		assert.equal(adapter.elements.find((element) => element.id === "target")?.updated, 1234);
		assert.equal(adapter.elements.find((element) => element.id === "other")?.x, 99);
		assert.equal(adapter.coreFiles.existing?.dataURL, "existing");
		assert.equal(adapter.coreFiles.new?.dataURL, "data:new");
		assert.deepEqual(adapter.retired, ["old"]);
		assert.deepEqual(adapter.deleted, [".generated/old.png"]);
	});

	it("rolls back durable artifacts when a target changes during staging", async () => {
		const adapter = new MemoryGeneratedImages();
		adapter.onCreate = () => {
			adapter.elements[0] = { ...adapter.elements[0], version: 3, versionNonce: 30 };
		};

		const result = await applyGeneratedImageTransaction(adapter, transaction());

		assert.equal(result.status, "conflict");
		assert.equal(adapter.attachments.size, 0);
		assert.equal(adapter.registrations.size, 0);
		assert.deepEqual(adapter.deleted, [".generated/target-new.png"]);
		assert.equal(adapter.writes, 0);
	});

	it("undoes a registration that mutated before rejecting", async () => {
		const adapter = new MemoryGeneratedImages();
		adapter.registerFailure = true;

		const result = await applyGeneratedImageTransaction(adapter, transaction());

		assert.equal(result.status, "failed");
		assert.equal(result.status === "failed" ? result.stage : "", "register");
		assert.equal(adapter.registrations.size, 0);
		assert.equal(adapter.attachments.size, 0);
	});

	it("detects a swallowed no-op scene write and rolls back", async () => {
		const adapter = new MemoryGeneratedImages();
		adapter.writeBehavior = "noop";

		const result = await applyGeneratedImageTransaction(adapter, transaction());

		assert.equal(result.status, "failed");
		assert.equal(adapter.attachments.size, 0);
		assert.equal(adapter.registrations.size, 0);
	});

	it("accepts a scene write that applied before its wrapper threw", async () => {
		const adapter = new MemoryGeneratedImages();
		adapter.writeBehavior = "apply-then-throw";

		const result = await applyGeneratedImageTransaction(adapter, transaction());

		assert.equal(result.status, "applied");
		assert.equal(adapter.attachments.has(".generated/target-new.png"), true);
		assert.equal(adapter.registrations.has("new"), true);
	});

	it("retains both generations when the postcondition cannot be read", async () => {
		const adapter = new MemoryGeneratedImages();
		adapter.attachments.add(".generated/old.png");
		adapter.registrations.add("old");
		adapter.throwReadsAfterWrite = true;

		const result = await applyGeneratedImageTransaction(adapter, transaction());

		assert.equal(result.status, "indeterminate");
		assert.equal(adapter.attachments.has(".generated/target-new.png"), true);
		assert.equal(adapter.attachments.has(".generated/old.png"), true);
		assert.equal(adapter.registrations.has("old"), true);
	});

	it("can commit native-only changes without a generated-file API round trip", async () => {
		const adapter = new MemoryGeneratedImages();

		const result = await applyGeneratedImageTransaction(adapter, {
			...transaction([]),
			retire: [],
		});

		assert.equal(result.status, "applied");
		assert.equal(adapter.elements[0].x, 5);
		assert.equal(adapter.coreFiles.existing?.dataURL, "existing");
	});

	it("restages an existing source binary before restoring its fileId", async () => {
		const adapter = new MemoryGeneratedImages();

		const result = await applyGeneratedImageTransaction(adapter, {
			changes: [{
				id: "target",
				expected: { version: 2, versionNonce: 20 },
				patch: { fileId: "source" },
			}],
			created: [],
			requiredCoreFiles: [{
				id: "source",
				dataURL: "data:image/png;base64,source",
				mimeType: "image/png",
				created: 1,
			}],
		});

		assert.equal(result.status, "applied");
		assert.equal(adapter.elements[0].fileId, "source");
		assert.equal(adapter.coreFiles.source?.dataURL, "data:image/png;base64,source");
	});
});
