import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planOverlapAwareZOrderMove, type ZOrderElement } from "../src/zorder";

/**
 * Scene array order is Excalidraw's paint order: index 0 is the back, the last
 * index is the front. Each helper builds elements on a single row so overlap is
 * controlled purely by the x range.
 */
const at = (id: string, x: number, width = 10): ZOrderElement => ({
	id,
	type: "image",
	x,
	y: 0,
	width,
	height: 10,
});

const ids = (elements: readonly ZOrderElement[] | null) => elements?.map((e) => e.id) ?? null;

describe("planOverlapAwareZOrderMove", () => {
	it("returns null with no selection", () => {
		assert.equal(planOverlapAwareZOrderMove([at("a", 0), at("b", 0)], new Set(), "forward"), null);
	});

	it("returns null when the selection matches no live element", () => {
		assert.equal(planOverlapAwareZOrderMove([at("a", 0)], new Set(["ghost"]), "forward"), null);
	});

	it("ignores deleted elements when locating the selection", () => {
		const scene = [{ ...at("a", 0), isDeleted: true }, at("b", 0)];
		assert.equal(planOverlapAwareZOrderMove(scene, new Set(["a"]), "forward"), null);
	});

	it("skips past non-overlapping neighbours and stops just past the first overlap", () => {
		// a overlaps only c; b and d sit elsewhere on the row.
		const scene = [at("a", 0), at("b", 100), at("c", 5), at("d", 200), at("e", 300)];
		assert.deepEqual(ids(planOverlapAwareZOrderMove(scene, new Set(["a"]), "forward")), ["b", "c", "a", "d", "e"]);
	});

	it("goes to the very front when nothing ahead overlaps", () => {
		const scene = [at("a", 0), at("b", 100), at("c", 200), at("d", 300)];
		assert.deepEqual(ids(planOverlapAwareZOrderMove(scene, new Set(["a"]), "forward")), ["b", "c", "d", "a"]);
	});

	it("moves backward past non-overlapping neighbours", () => {
		// e overlaps only c.
		const scene = [at("a", 100), at("b", 200), at("c", 0), at("d", 300), at("e", 5)];
		assert.deepEqual(ids(planOverlapAwareZOrderMove(scene, new Set(["e"]), "backward")), ["a", "b", "c", "e", "d"]);
	});

	it("goes to the very back when nothing behind overlaps", () => {
		const scene = [at("a", 100), at("b", 200), at("c", 300), at("d", 0)];
		assert.deepEqual(ids(planOverlapAwareZOrderMove(scene, new Set(["d"]), "backward")), ["d", "a", "b", "c"]);
	});

	it("returns null when the selection is already at the front", () => {
		const scene = [at("a", 0), at("b", 100), at("c", 200)];
		assert.equal(planOverlapAwareZOrderMove(scene, new Set(["c"]), "forward"), null);
	});

	it("returns null when the selection is already at the back", () => {
		const scene = [at("a", 0), at("b", 100), at("c", 200)];
		assert.equal(planOverlapAwareZOrderMove(scene, new Set(["a"]), "backward"), null);
	});

	it("keeps a contiguous multi-element selection together, landing just past the blocker", () => {
		const scene = [at("a", 0), at("b", 2), at("c", 100), at("d", 5)];
		// a+b are adjacent in the array and overlap d but not c. The run clears c
		// (no overlap) and then d itself -- "just past the first one it intersects"
		// means in front of that blocker, not behind it.
		const moved = ids(planOverlapAwareZOrderMove(scene, new Set(["a", "b"]), "forward"));
		assert.deepEqual(moved, ["c", "d", "a", "b"]);
	});

	it("advances disjoint runs independently without corrupting the array", () => {
		// Two separate runs (a) and (c), neither overlapping anything ahead.
		const scene = [at("a", 0), at("b", 100), at("c", 200), at("d", 300)];
		const moved = planOverlapAwareZOrderMove(scene, new Set(["a", "c"]), "forward");
		assert.notEqual(moved, null);
		const order = ids(moved)!;
		assert.equal(order.length, 4, "no element is dropped or duplicated");
		assert.deepEqual([...order].sort(), ["a", "b", "c", "d"]);
		assert.ok(order.indexOf("a") > order.indexOf("b"), "a advanced past b");
	});

	it("never drops or duplicates elements", () => {
		const scene = [at("a", 0), at("b", 5), at("c", 100), at("d", 3), at("e", 200)];
		for (const direction of ["forward", "backward"] as const) {
			for (const selection of [["a"], ["b"], ["a", "b"], ["d"], ["c", "e"]]) {
				const moved = planOverlapAwareZOrderMove(scene, new Set(selection), direction);
				if (!moved) continue;
				assert.deepEqual([...ids(moved)!].sort(), ["a", "b", "c", "d", "e"], `${direction} ${selection}`);
			}
		}
	});

	describe("group and frame bailout (callers fall back to Excalidraw's own handler)", () => {
		it("returns null when a selected element belongs to a group", () => {
			const scene = [{ ...at("a", 0), groupIds: ["g1"] }, at("b", 100), at("c", 5)];
			assert.equal(planOverlapAwareZOrderMove(scene, new Set(["a"]), "forward"), null);
		});

		it("returns null when a selected element belongs to a frame", () => {
			const scene = [{ ...at("a", 0), frameId: "f1" }, at("b", 100), at("c", 5)];
			assert.equal(planOverlapAwareZOrderMove(scene, new Set(["a"]), "forward"), null);
		});

		it("proceeds when groupIds is present but empty", () => {
			const scene = [{ ...at("a", 0), groupIds: [] }, at("b", 100)];
			assert.notEqual(planOverlapAwareZOrderMove(scene, new Set(["a"]), "forward"), null);
		});
	});

	it("requires overlap on BOTH axes: a neighbour in the same column but a different row never blocks", () => {
		// b shares a's x range exactly but sits far below it; c shares both. Only c
		// may stop the move.
		const below: ZOrderElement = { id: "b", type: "image", x: 0, y: 500, width: 10, height: 10 };
		const scene = [at("a", 0), below, at("c", 0)];
		assert.deepEqual(ids(planOverlapAwareZOrderMove(scene, new Set(["a"]), "forward")), ["b", "c", "a"]);
	});

	it("treats edge-touching elements as non-overlapping", () => {
		// b starts exactly where a ends: adjacent, not overlapping, so a passes it.
		const scene = [at("a", 0, 10), at("b", 10, 10), at("c", 5, 10)];
		assert.deepEqual(ids(planOverlapAwareZOrderMove(scene, new Set(["a"]), "forward")), ["b", "c", "a"]);
	});

	it("uses the rotation-aware box, so a rotated neighbour can block", () => {
		// a occupies x 0..10, y 0..10. The tall thin b is stored as x 40..50,
		// y -45..55 -- no x overlap with a, so unrotated it does not block. Rotated
		// 90 degrees about its own centre (45, 5) its visual box becomes
		// x -5..95, y 0..10, which overlaps a on BOTH axes.
		const tall = { id: "b", type: "image", x: 40, y: -45, width: 10, height: 100 };
		const scene = [at("a", 0, 10), { ...tall, angle: Math.PI / 2 }, at("c", 500)];
		assert.deepEqual(
			ids(planOverlapAwareZOrderMove(scene, new Set(["a"]), "forward")),
			["b", "a", "c"],
			"the rotated box blocks, so a stops right after b",
		);

		// Same scene with b upright: nothing overlaps a, so it travels to the front.
		const upright = [at("a", 0, 10), tall as ZOrderElement, at("c", 500)];
		assert.deepEqual(
			ids(planOverlapAwareZOrderMove(upright, new Set(["a"]), "forward")),
			["b", "c", "a"],
			"without rotation nothing blocks",
		);
	});
});
