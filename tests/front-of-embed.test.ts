import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MASK_ANTIALIAS_ALLOWANCE_PX,
	MASK_JITTER_ALLOWANCE,
	isFrontOfEmbedEligible,
	maskDilation,
	maskShapeFor,
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

	it("excludes grouped elements", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "a", groupIds: ["g1"] })), false);
	});

	it("excludes framed elements", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "a", frameId: "f1" })), false);
	});

	it("excludes a container and its bound text as a pair", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "label", type: "text", containerId: "box" })), false);
		assert.equal(
			isFrontOfEmbedEligible(el({ id: "box", boundElements: [{ id: "label", type: "text" }] })),
			false,
		);
	});

	it("does not exclude a container whose bound elements are only arrows", () => {
		assert.equal(isFrontOfEmbedEligible(el({ id: "box", boundElements: [{ id: "a1", type: "arrow" }] })), true);
	});

	it("excludes bound and elbowed arrows, whose points aren't where they're drawn", () => {
		const arrow = { id: "a", type: "arrow", points: [[0, 0], [10, 10]] } as const;
		assert.equal(isFrontOfEmbedEligible(el({ ...arrow, startBinding: { elementId: "box" } })), false);
		assert.equal(isFrontOfEmbedEligible(el({ ...arrow, endBinding: { elementId: "box" } })), false);
		assert.equal(isFrontOfEmbedEligible(el({ ...arrow, elbowed: true })), false);
		// An unbound, non-elbowed arrow is drawn through its own points, so it stays.
		assert.equal(isFrontOfEmbedEligible(el({ ...arrow, startBinding: null, endBinding: null })), true);
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

	it("Send to Back removes an element from the candidate set", () => {
		const inFront = [el({ id: "embed", type: "embeddable" }), el({ id: "img", type: "image" })];
		assert.deepEqual(ids(inFront), ["img"]);

		const sentToBack = [el({ id: "img", type: "image" }), el({ id: "embed", type: "embeddable" })];
		assert.deepEqual(ids(sentToBack), []);
	});

	it("bails out on grouped or framed elements even if otherwise eligible", () => {
		const elements = [
			el({ id: "embed", type: "embeddable" }),
			el({ id: "grouped", type: "image", groupIds: ["g1"] }),
			el({ id: "framed", type: "image", frameId: "f1" }),
		];
		assert.deepEqual(ids(elements), []);
	});

	it("bails out when the embeddable itself is grouped or framed", () => {
		const elements = [el({ id: "embed", type: "embeddable", frameId: "f1" }), el({ id: "img", type: "image" })];
		assert.deepEqual(ids(elements), []);
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

describe("maskShapeFor", () => {
	it("masks an image as its whole box", () => {
		assert.deepEqual(maskShapeFor(el({ id: "i", type: "image" })), { kind: "box" });
	});

	it("masks an unfilled shape as its outline only, so the embeddable shows through its interior", () => {
		const outlined = maskShapeFor(el({ id: "r", type: "rectangle", backgroundColor: "transparent", strokeWidth: 2 }));
		assert.equal(outlined.kind, "path");
		assert.equal(outlined.kind === "path" && outlined.fill, false);
		assert.equal(outlined.kind === "path" && outlined.closed, true);
	});

	it("treats a missing backgroundColor as unfilled", () => {
		assert.equal(maskShapeFor(el({ id: "r", type: "rectangle" })).kind === "path", true);
		const shape = maskShapeFor(el({ id: "r", type: "rectangle" }));
		assert.equal(shape.kind === "path" && shape.fill, false);
	});

	it("masks a filled shape's interior too", () => {
		const filled = maskShapeFor(el({ id: "r", type: "rectangle", backgroundColor: "#ffc9c9" }));
		assert.equal(filled.kind === "path" && filled.fill, true);
	});

	it("masks an ellipse as an ellipse", () => {
		const shape = maskShapeFor(el({ id: "e", type: "ellipse", strokeWidth: 4 }));
		assert.deepEqual(shape, { kind: "ellipse", fill: false, strokeWidth: 4 });
	});

	it("masks a diamond as its four vertices", () => {
		const shape = maskShapeFor(el({ id: "d", type: "diamond", width: 100, height: 60 }));
		assert.equal(shape.kind, "path");
		assert.deepEqual(shape.kind === "path" ? shape.points : null, [
			[50, 0],
			[100, 30],
			[50, 60],
			[0, 30],
		]);
	});

	it("masks a linear element along its own points, never closing the path", () => {
		const points = [
			[0, 0],
			[50, 20],
			[100, 0],
		];
		const arrow = maskShapeFor(el({ id: "a", type: "arrow", points }));
		assert.deepEqual(arrow.kind === "path" ? arrow.points : null, points);
		// Closing would mask a chord straight back to the first point -- a band of
		// scene background across the embeddable, for a stroke that never went there.
		assert.equal(arrow.kind === "path" && arrow.closed, false);
		for (const type of ["arrow", "line", "freedraw"]) {
			const shape = maskShapeFor(el({ id: "x", type, points }));
			assert.equal(shape.kind, "path", `${type} should mask along its points`);
			assert.equal(shape.kind === "path" && shape.closed, false, `${type} should not close its path`);
		}
	});

	it("smooths a curved line/arrow, whose points are control points rather than the drawn path", () => {
		const points = [
			[0, 0],
			[50, 20],
			[100, 0],
		];
		const curved = maskShapeFor(el({ id: "a", type: "arrow", points, roundness: { type: 2 } }));
		assert.equal(curved.kind === "path" && curved.smooth, true);

		const sharp = maskShapeFor(el({ id: "a", type: "arrow", points, roundness: null }));
		assert.equal(sharp.kind === "path" && sharp.smooth, false);

		// freedraw points already trace the drawn stroke, so they are used as-is.
		const stroke = maskShapeFor(el({ id: "f", type: "freedraw", points, roundness: { type: 2 } }));
		assert.equal(stroke.kind === "path" && stroke.smooth, false);
	});

	it("falls back to the box for a degenerate single-point linear element", () => {
		// Only ever seen mid-creation, before the second vertex exists.
		assert.deepEqual(maskShapeFor(el({ id: "a", type: "arrow", points: [[0, 0]] })), { kind: "box" });
	});

	it("masks text as its own lines, so only the glyphs occlude the embeddable", () => {
		const shape = maskShapeFor(
			el({ id: "t", type: "text", text: "two\r\nlines", fontSize: 20, lineHeight: 1.25, fontFamily: 5 }),
		);
		assert.deepEqual(shape, {
			kind: "text",
			lines: ["two", "lines"],
			lineHeightPx: 25,
			horizontalOffset: 0,
			textAlign: "left",
			fontSize: 20,
			fontFamily: 5,
		});
	});

	it("masks a diamond and rectangle without smoothing, so their corners stay sharp", () => {
		for (const type of ["diamond", "rectangle"]) {
			const shape = maskShapeFor(el({ id: "s", type, roundness: { type: 3 } }));
			assert.equal(shape.kind === "path" && shape.smooth, false, `${type} should not be smoothed`);
		}
	});

	it("offsets text horizontally to match Excalidraw's own alignment handling", () => {
		const centered = maskShapeFor(el({ id: "t", type: "text", text: "x", width: 80, textAlign: "center" }));
		assert.equal(centered.kind === "text" && centered.horizontalOffset, 40);

		const right = maskShapeFor(el({ id: "t", type: "text", text: "x", width: 80, textAlign: "right" }));
		assert.equal(right.kind === "text" && right.horizontalOffset, 80);
	});
});

describe("maskDilation", () => {
	it("adds the jitter allowance only for rough.js-drawn strokes", () => {
		assert.equal(maskDilation(1, true) - maskDilation(1, false), MASK_JITTER_ALLOWANCE);
	});

	it("shrinks the antialias allowance in scene units as zoom rises, so it stays ~constant on screen", () => {
		// A fixed scene-space rim would grow on screen when zoomed in, haloing text
		// in scene background; expressing it in screen pixels keeps it a hairline.
		assert.equal(maskDilation(1, false), MASK_ANTIALIAS_ALLOWANCE_PX);
		assert.equal(maskDilation(4, false), MASK_ANTIALIAS_ALLOWANCE_PX / 4);
		assert.equal(maskDilation(0.25, false), MASK_ANTIALIAS_ALLOWANCE_PX * 4);
	});

	it("stays finite at absurd zoom levels", () => {
		assert.ok(Number.isFinite(maskDilation(0, true)));
	});
});
