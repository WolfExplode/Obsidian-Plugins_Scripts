import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	elementPlacement,
	isFrontOfEmbedEligible,
	paintPlanFor,
	planFrontOfEmbedCandidates,
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

const ids = (elements: readonly FrontOfEmbedElement[]): string[] =>
	planFrontOfEmbedCandidates(elements).map((element) => element.id);

describe("isFrontOfEmbedEligible", () => {
	it("excludes deleted elements", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "a", isDeleted: true })), false);
	});

	it("excludes embeddables and frames themselves", () => {
		for (const type of ["embeddable", "iframe", "frame", "magicframe", "selection"]) {
			assert.equal(isFrontOfEmbedEligible(el({ id: "a", type })), false, `${type} should be ineligible`);
		}
	});

	it("includes grouped elements -- grouping changes nothing about how one is drawn", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "a", groupIds: ["g1"] })), true);
	});

	it("excludes framed elements, which a frame clips and the mask does not", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "a", frameId: "f1" })), false);
	});

	it("includes a labelled shape and its label", () => {
		const box = el({ id: "box", boundElements: [{ id: "label", type: "text" }] });
		assert.equal(isFrontOfEmbedEligible(box), true);
		assert.equal(isFrontOfEmbedEligible(el({ id: "label", type: "text", containerId: "box" }), box), true);
	});

	it("includes a labelled arrow and its label", () => {
		// The label's stored x/y aren't trusted -- the view layer repositions it via
		// computeArrowLabelPosition -- but eligibility itself no longer excludes it.
		const arrow = el({ id: "arrow", type: "arrow", boundElements: [{ id: "label", type: "text" }] });
		assert.equal(isFrontOfEmbedEligible(arrow), true);
		assert.equal(isFrontOfEmbedEligible(el({ id: "label", type: "text", containerId: "arrow" }), arrow), true);
	});

	it("excludes a label whose container can't be resolved", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "label", type: "text", containerId: "gone" }), null), false);
	});

	it("does not exclude a container whose bound elements are only arrows", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "box", boundElements: [{ id: "a1", type: "arrow" }] })), true);
	});

	it("includes bound and elbowed arrows -- their points ARE where they're drawn", () => {
		// A bound endpoint's pull-back and an elbow's routed segments are both
		// written into `points` by Excalidraw's own binding/routing maintenance,
		// and its shape generator reads nothing but `points`.
		const arrow = { id: "a", type: "arrow", points: [[0, 0], [10, 10]] } as const;
		assert.equal(isFrontOfEmbedEligible(el({ ...arrow })), true);
	});

	it("includes ordinary images, shapes, and text", () => {
		for (const type of ["image", "rectangle", "freedraw", "arrow", "text"]) {
			assert.equal(isFrontOfEmbedEligible(el({ id: "a", type })), true, `${type} should be eligible`);
		}
	});
});

describe("planFrontOfEmbedCandidates", () => {
	it("returns empty when there are no embeddables", () => {
		assert.deepEqual(ids([el({ id: "a" }), el({ id: "b", x: 10, y: 10 })]), []);
	});

	it("flags an element positioned after and overlapping an embeddable", () => {
		assert.deepEqual(ids([el({ id: "embed", type: "embeddable" }), el({ id: "img", type: "image" })]), ["img"]);
	});

	it("does not flag an element positioned before the embeddable, even if it overlaps", () => {
		assert.deepEqual(ids([el({ id: "img", type: "image" }), el({ id: "embed", type: "embeddable" })]), []);
	});

	it("does not flag an element that doesn't overlap the embeddable", () => {
		const elements = [
			el({ id: "embed", type: "embeddable" }),
			el({ id: "img", type: "image", x: 1000, y: 1000 }),
		];
		assert.deepEqual(ids(elements), []);
	});

	it("accounts for rotation when testing overlap", () => {
		// A tall thin element beside the embeddable clears it while upright, but its
		// rotated bounding box reaches over it.
		const embeddable = el({ id: "embed", type: "embeddable", x: 0, y: 0, width: 100, height: 100 });
		const upright = el({ id: "bar", type: "rectangle", x: 120, y: -100, width: 20, height: 300 });
		assert.deepEqual(ids([embeddable, upright]), []);
		assert.deepEqual(ids([embeddable, { ...upright, angle: Math.PI / 2 }]), ["bar"]);
	});

	it("tests a stroke's real extent, not a box hanging off its starting point", () => {
		// A scribble drawn right-to-left: its origin is where the pen went down, and
		// every point runs left and up from there. Taking x/y as the top-left corner
		// put its box entirely below-right of that origin -- so the embeddable it
		// actually covers was missed, and one it never reaches was flagged.
		const scribble = el({
			id: "scribble",
			type: "freedraw",
			x: 1000,
			y: 1000,
			width: 500,
			height: 400,
			points: [[0, 0], [-500, -400], [-250, -200]],
		});
		const covered = el({ id: "covered", type: "embeddable", x: 600, y: 700, width: 200, height: 200 });
		const untouched = el({ id: "untouched", type: "embeddable", x: 1200, y: 1200, width: 200, height: 200 });

		assert.deepEqual(ids([covered, scribble]), ["scribble"]);
		assert.deepEqual(ids([untouched, scribble]), []);
	});

	it("Send to Back removes an element from the candidate set", () => {
		const inFront = [el({ id: "embed", type: "embeddable" }), el({ id: "img", type: "image" })];
		assert.deepEqual(ids(inFront), ["img"]);

		const sentToBack = [el({ id: "img", type: "image" }), el({ id: "embed", type: "embeddable" })];
		assert.deepEqual(ids(sentToBack), []);
	});

	it("flags a grouped element, and bails out on a framed one", () => {
		const elements = [
			el({ id: "embed", type: "embeddable" }),
			el({ id: "grouped", type: "image", groupIds: ["g1"] }),
			el({ id: "framed", type: "image", frameId: "f1" }),
		];
		assert.deepEqual(ids(elements), ["grouped"]);
	});

	it("flags an element in front of a grouped embeddable, but not of a framed one", () => {
		const grouped = [el({ id: "embed", type: "embeddable", groupIds: ["g1"] }), el({ id: "img", type: "image" })];
		assert.deepEqual(ids(grouped), ["img"]);

		const framed = [el({ id: "embed", type: "embeddable", frameId: "f1" }), el({ id: "img", type: "image" })];
		assert.deepEqual(ids(framed), []);
	});

	it("flags a whole group whose members straddle the embeddable", () => {
		// Excalidraw keeps a group's members contiguous in the array, so the group's
		// z-position against the embeddable is just its members' own.
		const elements = [
			el({ id: "embed", type: "embeddable" }),
			el({ id: "over", type: "image", groupIds: ["g1"] }),
			el({ id: "beside", type: "image", groupIds: ["g1"], x: 1000, y: 1000 }),
		];
		assert.deepEqual(ids(elements), ["over"]);
	});

	it("carries a qualifying container's label across with it", () => {
		const elements = [
			el({ id: "embed", type: "embeddable" }),
			el({ id: "box", boundElements: [{ id: "label", type: "text" }] }),
			el({ id: "label", type: "text", containerId: "box", x: 20, y: 40, width: 60, height: 25 }),
		];
		assert.deepEqual(ids(elements), ["box", "label"]);
	});

	it("leaves a label behind when its container is behind the embeddable", () => {
		const elements = [
			el({ id: "box", boundElements: [{ id: "label", type: "text" }] }),
			el({ id: "label", type: "text", containerId: "box", x: 20, y: 40, width: 60, height: 25 }),
			el({ id: "embed", type: "embeddable" }),
		];
		assert.deepEqual(ids(elements), []);
	});

	it("takes a label from its container's verdict even when the label itself clears the embeddable", () => {
		// The container's mask stops at its own outline, so a label inside it that
		// doesn't happen to overlap still has to travel with it.
		const elements = [
			el({ id: "embed", type: "embeddable", x: 0, y: 0, width: 100, height: 100 }),
			el({ id: "box", x: 50, y: 0, width: 400, height: 100 }),
			el({ id: "label", type: "text", containerId: "box", x: 300, y: 40, width: 60, height: 25 }),
		];
		assert.deepEqual(ids(elements), ["box", "label"]);
	});

	it("flags a labelled arrow together with its label", () => {
		const elements = [
			el({ id: "embed", type: "embeddable" }),
			el({ id: "arrow", type: "arrow", points: [[0, 0], [80, 80]], boundElements: [{ id: "label", type: "text" }] }),
			el({ id: "label", type: "text", containerId: "arrow", x: 20, y: 40, width: 60, height: 25 }),
		];
		assert.deepEqual(ids(elements), ["arrow", "label"]);
	});

	it("returns candidates in scene order", () => {
		const elements = [
			el({ id: "embed", type: "embeddable" }),
			el({ id: "first", type: "image" }),
			el({ id: "second", type: "rectangle" }),
		];
		assert.deepEqual(ids(elements), ["first", "second"]);
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
		assert.deepEqual(ids(elements), ["x"]);
	});
});

describe("paintPlanFor", () => {
	it("draws every path-emitting type from Excalidraw's own export", () => {
		// No shape knowledge here at all: rectangle, ellipse, diamond, line, arrow and
		// freedraw are all "whatever exportToSvg emitted for it".
		for (const type of ["rectangle", "ellipse", "diamond", "line", "arrow", "freedraw"]) {
			assert.deepEqual(paintPlanFor(el({ id: "a", type })), { kind: "emitted" }, type);
		}
	});

	it("blits an image, whose pixels exist nowhere but Excalidraw's canvas", () => {
		assert.deepEqual(paintPlanFor(el({ id: "a", type: "image" })), { kind: "image" });
	});

	it("lays text out itself, since Excalidraw exports it as <text> rather than as paths", () => {
		const plan = paintPlanFor(
			el({ id: "t", type: "text", text: "two\r\nlines", fontSize: 20, lineHeight: 1.25, fontFamily: 5 }),
		);
		assert.deepEqual(plan, {
			kind: "text",
			lines: ["two", "lines"],
			lineHeightPx: 25,
			horizontalOffset: 0,
			textAlign: "left",
			fontSize: 20,
			fontFamily: 5,
		});
	});

	it("offsets text horizontally to match Excalidraw's own alignment handling", () => {
		const centered = paintPlanFor(el({ id: "t", type: "text", text: "x", width: 80, textAlign: "center" }));
		assert.equal(centered.kind === "text" && centered.horizontalOffset, 40);

		const right = paintPlanFor(el({ id: "t", type: "text", text: "x", width: 80, textAlign: "right" }));
		assert.equal(right.kind === "text" && right.horizontalOffset, 80);
	});
});

describe("elementPlacement", () => {
	const curve = (over: Partial<FrontOfEmbedElement> = {}) =>
		el({ id: "curve", type: "line", x: 1000, y: 500, width: 400, height: 200, points: [[0, 0], [400, 200]], ...over });

	it("rotates about the centre of the drawn bounds, not of x/y/width/height", () => {
		// A stroke whose drawn curve reaches left of its origin: its box centre is
		// 100 units left of where `width/2` alone would put it.
		const placement = elementPlacement(curve({ points: [[0, 0], [-200, 200]] }), {
			minX: 800,
			minY: 500,
			maxX: 1200,
			maxY: 700,
		});
		assert.equal(placement.pivotX, 0);
		assert.equal(placement.pivotY, 100);
	});

	it("displaces the paint when Excalidraw's own canvas placement displaces the element", () => {
		// Drawn bounds start 1.5 below the element's y: Excalidraw clamps its canvas
		// offset to 0 in that case and paints the element that far low, so the mask
		// has to follow it down.
		const placement = elementPlacement(curve(), { minX: 1000, minY: 501.5, maxX: 1400, maxY: 701.5 });
		assert.equal(placement.shiftX, 0);
		assert.equal(placement.shiftY, 1.5);
	});

	it("does not displace the mask in the usual case, where the drawn geometry reaches past the origin", () => {
		const placement = elementPlacement(curve(), { minX: 998, minY: 497.5, maxX: 1400, maxY: 700 });
		assert.equal(placement.shiftX, 0);
		assert.equal(placement.shiftY, 0);
	});

	it("leaves shapes alone -- only linear and freedraw elements go through that canvas", () => {
		const rect = el({ id: "r", type: "rectangle", x: 1000, y: 500, width: 400, height: 200 });
		const placement = elementPlacement(rect, { minX: 1002, minY: 502, maxX: 1400, maxY: 700 });
		assert.equal(placement.shiftX, 0);
		assert.equal(placement.shiftY, 0);
	});

	it("falls back to the points' own box when Excalidraw's bounds aren't available", () => {
		const placement = elementPlacement(curve({ points: [[0, 0], [-400, -200]] }), null);
		assert.deepEqual(placement, { shiftX: 0, shiftY: 0, pivotX: -200, pivotY: -100 });
	});
});
