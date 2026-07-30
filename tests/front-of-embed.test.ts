import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	embeddablesBehind,
	isFrontOfEmbedEligible,
	overlappingEmbeddableIds,
	planFrontOfEmbedCandidates,
	planFrontOfEmbedOverlaps,
	type FrontOfEmbedElement,
} from "../src/front-of-embed";

const el = (over: Partial<FrontOfEmbedElement> & { id: string }): FrontOfEmbedElement => ({
	type: "rectangle",
	x: 0,
	y: 0,
	width: 100,
	height: 100,
	...over,
});

describe("isFrontOfEmbedEligible", () => {
	it("excludes deleted elements", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "a", isDeleted: true })), false);
	});

	it("excludes embeddables themselves", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "a", type: "embeddable" })), false);
	});

	it("excludes grouped elements", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "a", groupIds: ["g1"] })), false);
	});

	it("excludes framed elements", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "a", frameId: "f1" })), false);
	});

	it("includes ordinary images, shapes, and text", () => {
		for (const type of ["image", "rectangle", "freedraw", "arrow", "text"]) {
			assert.equal(isFrontOfEmbedEligible(el({ id: "a", type })), true, `${type} should be eligible`);
		}
	});
});

describe("planFrontOfEmbedCandidates", () => {
	it("returns empty when there are no embeddables", () => {
		const elements = [el({ id: "a" }), el({ id: "b", x: 10, y: 10 })];
		assert.deepEqual([...planFrontOfEmbedCandidates(elements)], []);
	});

	it("flags an element positioned after and overlapping an embeddable", () => {
		const elements = [el({ id: "embed", type: "embeddable" }), el({ id: "img", type: "image" })];
		assert.deepEqual([...planFrontOfEmbedCandidates(elements)], ["img"]);
	});

	it("does not flag an element positioned before the embeddable, even if it overlaps", () => {
		const elements = [el({ id: "img", type: "image" }), el({ id: "embed", type: "embeddable" })];
		assert.deepEqual([...planFrontOfEmbedCandidates(elements)], []);
	});

	it("does not flag an element that doesn't overlap the embeddable", () => {
		const elements = [
			el({ id: "embed", type: "embeddable" }),
			el({ id: "img", type: "image", x: 1000, y: 1000 }),
		];
		assert.deepEqual([...planFrontOfEmbedCandidates(elements)], []);
	});

	it("Send to Back removes an element from the candidate set", () => {
		const inFront = [el({ id: "embed", type: "embeddable" }), el({ id: "img", type: "image" })];
		assert.deepEqual([...planFrontOfEmbedCandidates(inFront)], ["img"]);

		const sentToBack = [el({ id: "img", type: "image" }), el({ id: "embed", type: "embeddable" })];
		assert.deepEqual([...planFrontOfEmbedCandidates(sentToBack)], []);
	});

	it("bails out on grouped or framed elements even if otherwise eligible", () => {
		const elements = [
			el({ id: "embed", type: "embeddable" }),
			el({ id: "grouped", type: "image", groupIds: ["g1"] }),
			el({ id: "framed", type: "image", frameId: "f1" }),
		];
		assert.deepEqual([...planFrontOfEmbedCandidates(elements)], []);
	});

	it("bails out when the embeddable itself is grouped or framed", () => {
		const elements = [el({ id: "embed", type: "embeddable", frameId: "f1" }), el({ id: "img", type: "image" })];
		assert.deepEqual([...planFrontOfEmbedCandidates(elements)], []);
	});

	it("multi-embeddable interleaving: flags an element in front of either embeddable (documented limitation)", () => {
		// Embed A (back) -> Image X -> Embed B (front). X is only "meant" to be in
		// front of A, but the single-layer overlay can't distinguish that -- it's
		// flagged regardless, matching the documented known limitation.
		const elements = [
			el({ id: "embedA", type: "embeddable" }),
			el({ id: "x", type: "image" }),
			el({ id: "embedB", type: "embeddable" }),
		];
		assert.deepEqual([...planFrontOfEmbedCandidates(elements)], ["x"]);
	});
});

describe("planFrontOfEmbedOverlaps", () => {
	it("records which embeddable(s) each qualifying element overlaps", () => {
		const elements = [
			el({ id: "embedA", type: "embeddable", x: 0, y: 0, width: 100, height: 100 }),
			el({ id: "x", type: "image", x: 0, y: 0, width: 100, height: 100 }),
			el({ id: "embedB", type: "embeddable", x: 500, y: 500, width: 100, height: 100 }),
		];
		const overlaps = planFrontOfEmbedOverlaps(elements);
		assert.deepEqual([...overlaps.keys()], ["x"]);
		assert.deepEqual(overlaps.get("x"), ["embedA"]);
	});

	it("its key set matches planFrontOfEmbedCandidates", () => {
		const elements = [
			el({ id: "embedA", type: "embeddable" }),
			el({ id: "x", type: "image" }),
			el({ id: "embedB", type: "embeddable" }),
		];
		assert.deepEqual(new Set(planFrontOfEmbedOverlaps(elements).keys()), planFrontOfEmbedCandidates(elements));
	});
});

describe("embeddablesBehind + overlappingEmbeddableIds (gesture-time incremental check)", () => {
	it("finds only embeddables positioned earlier than the given element", () => {
		const elements = [
			el({ id: "embedA", type: "embeddable" }),
			el({ id: "moving", type: "image" }),
			el({ id: "embedB", type: "embeddable" }),
		];
		const behind = embeddablesBehind(elements, "moving");
		assert.deepEqual(behind.map((e) => e.id), ["embedA"]);
	});

	it("recomputes overlap cheaply as the element's live geometry changes", () => {
		const embeddable = el({ id: "embed", type: "embeddable", x: 0, y: 0, width: 100, height: 100 });
		const candidates = [embeddable];

		const farAway = el({ id: "moving", type: "image", x: 1000, y: 1000, width: 50, height: 50 });
		assert.deepEqual(overlappingEmbeddableIds(farAway, candidates), []);

		const draggedOnTop = el({ id: "moving", type: "image", x: 50, y: 50, width: 50, height: 50 });
		assert.deepEqual(overlappingEmbeddableIds(draggedOnTop, candidates), ["embed"]);
	});
});
