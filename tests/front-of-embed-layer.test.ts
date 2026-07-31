import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { frontLayerClipPath, planReadOnlyFrontLayer } from "../src/front-of-embed-layer";
import type { FrontOfEmbedElement } from "../src/front-of-embed";

const el = (over: Partial<FrontOfEmbedElement> & { id: string }): FrontOfEmbedElement => ({
	type: "rectangle",
	x: 0,
	y: 0,
	width: 100,
	height: 100,
	...over,
});

const embeddable = (over: Partial<FrontOfEmbedElement> & { id: string }): FrontOfEmbedElement =>
	el({ type: "embeddable", ...over });

describe("planReadOnlyFrontLayer", () => {
	it("returns nothing when no element sits in front of an embeddable", () => {
		assert.equal(planReadOnlyFrontLayer([el({ id: "a" }), embeddable({ id: "e" })]), null);
	});

	it("returns the candidates in scene order, with the embeddables to clip to", () => {
		const plan = planReadOnlyFrontLayer([
			embeddable({ id: "e", x: 0, y: 0, width: 200, height: 200 }),
			el({ id: "a", x: 50, y: 50 }),
			el({ id: "b", x: 60, y: 60 }),
		]);
		assert.deepEqual(plan?.candidates.map((element) => element.id), ["a", "b"]);
		assert.deepEqual(plan?.clip.map((rect) => rect.id), ["e"]);
	});

	it("clips to every eligible embeddable, not only the one a candidate crosses", () => {
		const plan = planReadOnlyFrontLayer([
			embeddable({ id: "e1", x: 0, y: 0, width: 200, height: 200 }),
			embeddable({ id: "e2", x: 900, y: 0, width: 200, height: 200 }),
			el({ id: "a", x: 50, y: 50 }),
		]);
		assert.deepEqual(plan?.clip.map((rect) => rect.id), ["e1", "e2"]);
	});

	it("ignores a framed embeddable, which the candidate rules never counted either", () => {
		const plan = planReadOnlyFrontLayer([
			embeddable({ id: "e", x: 0, y: 0, width: 200, height: 200, frameId: "f" }),
			el({ id: "a", x: 50, y: 50 }),
		]);
		assert.equal(plan, null);
	});
});

describe("frontLayerClipPath", () => {
	it("emits one closed subpath per rect, relative to the layer origin", () => {
		const d = frontLayerClipPath([{ id: "e", minX: 100, minY: 200, maxX: 300, maxY: 500 }], 100, 200);
		assert.equal(d, "M0 0H200V300H0Z");
	});

	it("keeps subpaths separate so the region is their union", () => {
		const d = frontLayerClipPath(
			[
				{ id: "a", minX: 0, minY: 0, maxX: 10, maxY: 10 },
				{ id: "b", minX: 20, minY: 20, maxX: 30, maxY: 30 },
			],
			0,
			0,
		);
		assert.equal(d, "M0 0H10V10H0ZM20 20H30V30H20Z");
	});

	it("rounds to two decimals rather than shipping full float precision", () => {
		const d = frontLayerClipPath([{ id: "a", minX: 0.123456, minY: 0, maxX: 1, maxY: 1 }], 0, 0);
		assert.equal(d, "M0.12 0H1V1H0.12Z");
	});
});
