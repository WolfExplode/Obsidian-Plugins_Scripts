import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commonTransformBounds, transformElementBounds, type TransformBoundsElement } from "../src/transform-geometry";

const element = (over: Partial<TransformBoundsElement>): TransformBoundsElement => ({
	type: "rectangle",
	x: 0,
	y: 0,
	width: 100,
	height: 50,
	angle: 0,
	...over,
});

describe("transform proxy bounds", () => {
	it("uses negative local points for a reversed arrow", () => {
		assert.deepEqual(transformElementBounds(element({
			type: "arrow", x: 100, y: 200, width: 80, height: 40,
			points: [[0, 0], [-80, 40]],
		})), [20, 200, 100, 240]);
	});

	it("uses the complete local point range for free-draw elements", () => {
		assert.deepEqual(transformElementBounds(element({
			type: "freedraw", x: 200, y: 300, width: 130, height: 70,
			points: [[0, 0], [100, -20], [-30, 50]],
		})), [170, 280, 300, 350]);
	});

	it("rotates line points about their point-derived centre", () => {
		const bounds = transformElementBounds(element({
			type: "line", x: 100, y: 200, width: 80, height: 40, angle: Math.PI / 2,
			points: [[0, 0], [-80, 40]],
		}));
		assert.ok(bounds.every((value, index) => Math.abs(value - [40, 180, 80, 260][index]!) < 1e-9));
	});

	it("combines point-derived and ordinary element bounds", () => {
		assert.deepEqual(commonTransformBounds([
			element({ type: "arrow", x: 100, y: 200, width: 80, height: 40, points: [[0, 0], [-80, 40]] }),
			element({ x: 150, y: 180, width: 20, height: 10 }),
		]), [20, 180, 170, 240]);
	});
});
