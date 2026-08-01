import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	captureElementRevisions,
	commitElementMutation,
	type ElementMutationAdapter,
} from "../src/excalidraw-element-mutation";

interface TestElement {
	id: string;
	x: number;
	version?: number;
	versionNonce?: number;
	updated?: number;
}

class MemoryElements implements ElementMutationAdapter<TestElement> {
	writes = 0;
	constructor(public elements: readonly TestElement[]) {}
	readElements(): readonly TestElement[] { return this.elements; }
	writeElements(elements: readonly TestElement[]): void {
		this.writes++;
		this.elements = elements;
	}
}

describe("commitElementMutation", () => {
	it("reports an unavailable runtime without invoking feature planning", () => {
		let planned = false;
		const result = commitElementMutation<TestElement>(null, () => {
			planned = true;
			return { x: 20 };
		});

		assert.equal(result.status, "unavailable");
		assert.equal(planned, false);
	});

	it("preserves untouched identities and stamps changed elements in one write", () => {
		const untouched = { id: "b", x: 20, version: 4, versionNonce: 40 };
		const adapter = new MemoryElements([
			{ id: "a", x: 10, version: 2, versionNonce: 20 },
			untouched,
		]);

		const result = commitElementMutation(adapter, (element) => element.id === "a" ? { x: 15 } : null);

		assert.deepEqual(result.status === "applied" ? result.changedIds : [], ["a"]);
		assert.equal(adapter.writes, 1);
		assert.equal(adapter.elements[0].x, 15);
		assert.equal(adapter.elements[0].version, 3);
		assert.equal(typeof adapter.elements[0].versionNonce, "number");
		assert.equal(typeof adapter.elements[0].updated, "number");
		assert.equal(adapter.elements[1], untouched);
	});

	it("does not write when patches make no observable change", () => {
		const adapter = new MemoryElements([{ id: "a", x: 10, version: 2 }]);

		const result = commitElementMutation(adapter, () => ({ x: 10 }));

		assert.equal(result.status, "no-op");
		assert.equal(adapter.writes, 0);
	});

	it("rejects an async plan when a target revision changed", () => {
		const original = { id: "a", x: 10, version: 2, versionNonce: 20 };
		const expected = captureElementRevisions([original]);
		const adapter = new MemoryElements([{ ...original, x: 50, version: 3, versionNonce: 30 }]);

		const result = commitElementMutation(adapter, () => ({ x: 15 }), expected);

		assert.deepEqual(result, { status: "conflict", conflictingIds: ["a"] });
		assert.equal(adapter.elements[0].x, 50);
		assert.equal(adapter.writes, 0);
	});

	it("returns failures distinctly from expected no-ops", () => {
		const failure = new Error("write failed");
		const adapter: ElementMutationAdapter<TestElement> = {
			readElements: () => [{ id: "a", x: 10 }],
			writeElements: () => { throw failure; },
		};

		const result = commitElementMutation(adapter, () => ({ x: 20 }));

		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.equal(result.error, failure);
	});
});
