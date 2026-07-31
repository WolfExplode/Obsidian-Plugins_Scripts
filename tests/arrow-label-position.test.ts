import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeArrowLabelPosition } from "../src/arrow-label-position";
import type { FrontOfEmbedElement, AbsoluteBounds } from "../src/front-of-embed";

const arrow = (over: Partial<FrontOfEmbedElement> & { id: string }): FrontOfEmbedElement => ({
	type: "arrow",
	x: 0,
	y: 0,
	width: 100,
	height: 100,
	points: [
		[0, 0],
		[100, 0],
	],
	...over,
});

const boundsOf = (a: FrontOfEmbedElement): AbsoluteBounds => {
	const xs = a.points!.map((p) => a.x + p[0]);
	const ys = a.points!.map((p) => a.y + p[1]);
	return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};

describe("computeArrowLabelPosition", () => {
	it("centres a 2-point sharp arrow's label on the segment midpoint", () => {
		const a = arrow({ id: "a", points: [[0, 0], [100, 0]] });
		const pos = computeArrowLabelPosition(a, boundsOf(a), { width: 20, height: 10 });
		assert.deepEqual(pos, { x: 50 - 10, y: 0 - 5 });
	});

	it("centres a 2-point rounded arrow's label on the same point -- a straight bezier's arc-length midpoint equals its endpoint average", () => {
		const a = arrow({ id: "a", points: [[0, 0], [100, 0]], roundness: { type: 2 } });
		const pos = computeArrowLabelPosition(a, boundsOf(a), { width: 20, height: 10 });
		assert.ok(pos);
		assert.ok(Math.abs(pos!.x - 40) < 0.01, `x was ${pos!.x}`);
		assert.ok(Math.abs(pos!.y - -5) < 0.01, `y was ${pos!.y}`);
	});

	it("centres an odd-point-count arrow's label on the actual middle point", () => {
		const a = arrow({ id: "a", points: [[0, 0], [40, 10], [100, 0]] });
		const pos = computeArrowLabelPosition(a, boundsOf(a), { width: 20, height: 10 });
		assert.deepEqual(pos, { x: 40 - 10, y: 10 - 5 });
	});

	it("rotates the odd-point-count case about the arrow's bounds centre", () => {
		// A 3-point arrow along the x-axis, rotated 90 degrees about its own bounds
		// centre: the middle point (the bounds centre itself) doesn't move.
		const a = arrow({ id: "a", points: [[0, 0], [50, 0], [100, 0]], angle: Math.PI / 2 });
		const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 0 };
		const pos = computeArrowLabelPosition(a, bounds, { width: 0, height: 0 });
		assert.ok(pos);
		assert.ok(Math.abs(pos!.x - 50) < 1e-9, `x was ${pos!.x}`);
		assert.ok(Math.abs(pos!.y - 0) < 1e-9, `y was ${pos!.y}`);
	});

	it("averages the two elbow points at the segment index without rotating", () => {
		const a = arrow({
			id: "a",
			elbowed: true,
			points: [
				[0, 0],
				[0, 40],
				[80, 40],
				[80, 80],
			],
		});
		const pos = computeArrowLabelPosition(a, boundsOf(a), { width: 0, height: 0 });
		// points.length = 4 (even) -> opIndex = 2 -> average of points[1] and points[2]
		assert.deepEqual(pos, { x: (0 + 80) / 2, y: (40 + 40) / 2 });
	});

	it("bows a multi-point rounded arrow's middle segment away from the straight-line midpoint", () => {
		// An asymmetric zig-zag through 4 points with rounded corners: the drawn
		// curve at the middle segment is pulled toward the neighbouring points, so
		// its arc-length midpoint is measurably off the raw segment's own
		// straight-line midpoint. (A point-symmetric layout would put both at the
		// same spot regardless of curvature, which would defeat this test.)
		const a = arrow({
			id: "a",
			roundness: { type: 2 },
			points: [
				[0, 0],
				[50, -150],
				[150, 30],
				[280, 40],
			],
		});
		const pos = computeArrowLabelPosition(a, boundsOf(a), { width: 0, height: 0 });
		assert.ok(pos);
		const straightMidpoint = { x: (50 + 150) / 2, y: (-60 + 60) / 2 };
		const distance = Math.hypot(pos!.x - straightMidpoint.x, pos!.y - straightMidpoint.y);
		assert.ok(distance > 1, `expected the rounded midpoint to diverge from the straight one, distance was ${distance}`);
	});

	it("returns null when there aren't enough points to place a label", () => {
		const a = arrow({ id: "a", points: [[0, 0]] });
		assert.equal(computeArrowLabelPosition(a, boundsOf({ ...a, points: [[0, 0], [0, 0]] }), { width: 10, height: 10 }), null);
	});
});
