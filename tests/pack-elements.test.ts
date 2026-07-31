import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	elementAABB,
	isPackable,
	planOptimalPack,
	planPack,
	type PackElement,
	type PackMove,
} from "../src/pack-elements";

const el = (over: Partial<PackElement> & { id: string }): PackElement => ({
	type: "image",
	x: 0,
	y: 0,
	width: 100,
	height: 100,
	...over,
});

/** Applies moves to elements so assertions can be written about final geometry. */
function applyMoves(elements: readonly PackElement[], moves: readonly PackMove[]): PackElement[] {
	const byId = new Map(moves.map((m) => [m.id, m]));
	return elements.map((e) => {
		const m = byId.get(e.id);
		return m ? { ...e, x: e.x + m.dx, y: e.y + m.dy } : e;
	});
}

function overlaps(a: PackElement, b: PackElement): boolean {
	const ra = elementAABB(a);
	const rb = elementAABB(b);
	return ra.minX < rb.maxX - 1e-6 && ra.maxX > rb.minX + 1e-6 && ra.minY < rb.maxY - 1e-6 && ra.maxY > rb.minY + 1e-6;
}

describe("isPackable", () => {
	it("packs reference-like elements", () => {
		for (const type of ["image", "embeddable", "iframe", "text"]) {
			assert.equal(isPackable(el({ id: "x", type })), true, `${type} should pack`);
		}
	});

	it("excludes drawings, connectors, shapes, frames, and the marquee", () => {
		for (const type of ["freedraw", "line", "arrow", "rectangle", "ellipse", "diamond", "frame", "magicframe", "selection"]) {
			assert.equal(isPackable(el({ id: "x", type })), false, `${type} should not pack`);
		}
	});

	it("excludes deleted elements", () => {
		assert.equal(isPackable(el({ id: "x", isDeleted: true })), false);
	});

	it("excludes text bound to a container, which must move with its owner", () => {
		assert.equal(isPackable(el({ id: "x", type: "text", containerId: "rect-1" })), false);
		assert.equal(isPackable(el({ id: "x", type: "text", containerId: null })), true);
	});
});

describe("elementAABB", () => {
	it("is the plain box when unrotated", () => {
		assert.deepEqual(elementAABB(el({ id: "a", x: 10, y: 20, width: 100, height: 50 })), {
			id: "a",
			minX: 10,
			minY: 20,
			maxX: 110,
			maxY: 70,
		});
	});

	it("swaps extents at 90 degrees, keeping the centre fixed", () => {
		const box = elementAABB(el({ id: "a", x: 0, y: 0, width: 100, height: 20, angle: Math.PI / 2 }));
		assert.ok(Math.abs(box.maxX - box.minX - 20) < 1e-9, "width becomes the original height");
		assert.ok(Math.abs(box.maxY - box.minY - 100) < 1e-9, "height becomes the original width");
		assert.ok(Math.abs((box.minX + box.maxX) / 2 - 50) < 1e-9);
		assert.ok(Math.abs((box.minY + box.maxY) / 2 - 10) < 1e-9);
	});

	it("grows a square's extent by sqrt(2) at 45 degrees", () => {
		const box = elementAABB(el({ id: "a", width: 100, height: 100, angle: Math.PI / 4 }));
		assert.ok(Math.abs(box.maxX - box.minX - 100 * Math.SQRT2) < 1e-9);
	});

	it("starts a linear element's box at its leftmost/topmost point, not at its origin", () => {
		// A stroke drawn up and to the left: `points[0]` is at x/y, everything else
		// is behind it, so the box hangs off the origin's top-left.
		const box = elementAABB(
			el({
				id: "a",
				type: "freedraw",
				x: 1000,
				y: 1000,
				width: 60,
				height: 40,
				points: [[0, 0], [-60, -40], [-20, -10]],
			}),
		);
		assert.deepEqual(box, { id: "a", minX: 940, minY: 960, maxX: 1000, maxY: 1000 });
	});

	it("rotates a linear element about its box centre, not its origin", () => {
		const box = elementAABB(
			el({
				id: "a",
				type: "line",
				x: 0,
				y: 0,
				width: 100,
				height: 20,
				points: [[0, 0], [-100, -20]],
				angle: Math.PI / 2,
			}),
		);
		// Centre stays at the box centre (-50, -10) with the extents swapped.
		assert.ok(Math.abs((box.minX + box.maxX) / 2 + 50) < 1e-9);
		assert.ok(Math.abs((box.minY + box.maxY) / 2 + 10) < 1e-9);
		assert.ok(Math.abs(box.maxX - box.minX - 20) < 1e-9);
		assert.ok(Math.abs(box.maxY - box.minY - 100) < 1e-9);
	});
});

describe("planPack (PureRef gravity pack)", () => {
	const GAP = 8;

	it("is a no-op for fewer than two elements, matching PureRef", () => {
		assert.deepEqual(planPack([], "down", GAP), []);
		assert.deepEqual(planPack([el({ id: "a" })], "down", GAP), []);
	});

	it("stacks overlapping elements against each other with exactly one gap", () => {
		const a = el({ id: "a", x: 0, y: 0, width: 100, height: 50 });
		const b = el({ id: "b", x: 0, y: 200, width: 100, height: 50 });
		const moves = planPack([a, b], "down", GAP);

		// b is already at the boundary and must not move; a falls to rest on it.
		assert.deepEqual(moves, [{ id: "a", dx: 0, dy: 142 }]);

		const [packedA, packedB] = applyMoves([a, b], moves);
		assert.equal(packedA.y + packedA.height + GAP, packedB.y, "one gap between the stacked pair");
	});

	it("settles non-overlapping elements into a line at the boundary", () => {
		const a = el({ id: "a", x: 0, y: 0, width: 50, height: 50 });
		const b = el({ id: "b", x: 100, y: 100, width: 50, height: 80 });
		const packed = applyMoves([a, b], planPack([a, b], "down", GAP));

		const bottoms = packed.map((e) => e.y + e.height);
		assert.deepEqual(bottoms, [180, 180], "both leading edges land on the same boundary");
	});

	it("never touches the perpendicular axis", () => {
		const elements = [
			el({ id: "a", x: 0, y: 0 }),
			el({ id: "b", x: 37, y: 400 }),
			el({ id: "c", x: -90, y: 250 }),
		];
		for (const move of planPack(elements, "down", GAP)) assert.equal(move.dx, 0);
		for (const move of planPack(elements, "up", GAP)) assert.equal(move.dx, 0);
		for (const move of planPack(elements, "left", GAP)) assert.equal(move.dy, 0);
		for (const move of planPack(elements, "right", GAP)) assert.equal(move.dy, 0);
	});

	it("packs toward the leading edge of the selection, not the origin", () => {
		// Nothing sits at y=0; "down" must gather at the lowest existing edge (250).
		const a = el({ id: "a", x: 0, y: 100, width: 50, height: 50 });
		const b = el({ id: "b", x: 200, y: 200, width: 50, height: 50 });
		const packed = applyMoves([a, b], planPack([a, b], "down", GAP));
		assert.deepEqual(packed.map((e) => e.y + e.height), [250, 250]);
	});

	it("packs left against the leftmost edge", () => {
		const a = el({ id: "a", x: 500, y: 0, width: 50, height: 50 });
		const b = el({ id: "b", x: 0, y: 0, width: 50, height: 50 });
		const [packedA, packedB] = applyMoves([a, b], planPack([a, b], "left", GAP));
		// Same row, so they stack horizontally: b already holds the leftmost edge and
		// stays put, and a comes to rest one gap to its right.
		assert.equal(packedB.x, 0, "the boundary element does not move");
		assert.equal(packedB.x + packedB.width + GAP, packedA.x);
	});

	it("leaves an already-packed selection alone (idempotent)", () => {
		const a = el({ id: "a", x: 0, y: 142, width: 100, height: 50 });
		const b = el({ id: "b", x: 0, y: 200, width: 100, height: 50 });
		assert.deepEqual(planPack([a, b], "down", GAP), []);
	});

	it("packs rotated elements by their visual box, leaving no overlap", () => {
		const a = el({ id: "a", x: 0, y: 0, width: 100, height: 20, angle: Math.PI / 2 });
		const b = el({ id: "b", x: 0, y: 300, width: 100, height: 20 });
		const packed = applyMoves([a, b], planPack([a, b], "down", GAP));
		assert.equal(overlaps(packed[0], packed[1]), false, "rotated AABB keeps the pair apart");
	});
});

describe("planOptimalPack (Ctrl+Shift+P)", () => {
	const GAP = 8;
	const spread: PackElement[] = [
		el({ id: "a", x: 0, y: 0, width: 120, height: 80 }),
		el({ id: "b", x: 900, y: 40, width: 60, height: 140 }),
		el({ id: "c", x: 200, y: 700, width: 90, height: 90 }),
		el({ id: "d", x: -400, y: 300, width: 150, height: 40 }),
		el({ id: "e", x: 640, y: -200, width: 70, height: 70 }),
	];

	it("is a no-op for fewer than two elements", () => {
		assert.deepEqual(planOptimalPack([], GAP), []);
		assert.deepEqual(planOptimalPack([el({ id: "a" })], GAP), []);
	});

	it("is deterministic", () => {
		assert.deepEqual(planOptimalPack(spread, GAP), planOptimalPack(spread, GAP));
	});

	it("produces a layout with no overlapping elements", () => {
		const packed = applyMoves(spread, planOptimalPack(spread, GAP));
		for (let i = 0; i < packed.length; i++) {
			for (let j = i + 1; j < packed.length; j++) {
				assert.equal(overlaps(packed[i], packed[j]), false, `${packed[i].id} overlaps ${packed[j].id}`);
			}
		}
	});

	it("anchors the block at the selection's existing top-left", () => {
		const packed = applyMoves(spread, planOptimalPack(spread, GAP));
		const boxes = packed.map(elementAABB);
		const originals = spread.map(elementAABB);
		assert.ok(Math.abs(Math.min(...boxes.map((b) => b.minX)) - Math.min(...originals.map((b) => b.minX))) < 1e-6);
		assert.ok(Math.abs(Math.min(...boxes.map((b) => b.minY)) - Math.min(...originals.map((b) => b.minY))) < 1e-6);
	});

	it("compacts a widely scattered selection", () => {
		const packed = applyMoves(spread, planOptimalPack(spread, GAP));
		const boxes = packed.map(elementAABB);
		const area =
			(Math.max(...boxes.map((b) => b.maxX)) - Math.min(...boxes.map((b) => b.minX))) *
			(Math.max(...boxes.map((b) => b.maxY)) - Math.min(...boxes.map((b) => b.minY)));
		const originals = spread.map(elementAABB);
		const originalArea =
			(Math.max(...originals.map((b) => b.maxX)) - Math.min(...originals.map((b) => b.minX))) *
			(Math.max(...originals.map((b) => b.maxY)) - Math.min(...originals.map((b) => b.minY)));
		assert.ok(area < originalArea / 10, `packed area ${area} should be far below ${originalArea}`);
	});

	it("settles: re-running on an already-optimal block moves nothing", () => {
		const packed = applyMoves(spread, planOptimalPack(spread, GAP));
		assert.deepEqual(planOptimalPack(packed, GAP), []);
	});
});
