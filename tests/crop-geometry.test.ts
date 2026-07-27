import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyAffine,
	elementLocalToScene,
	filePixelsToCurrentLocal,
	intersectConvexPolygons,
	invertAffine,
	localPolygonForSceneRect,
	multiplyAffine,
	planImageCrop,
	pointInsideConvexPolygon,
	polygonBounds,
	rotateVector,
	viewportCropToCurrentLocal,
	type AffineTransform,
	type CropImageElement,
	type CropPoint,
} from "../src/crop-geometry";

const IDENTITY: AffineTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function assertClose(actual: number, expected: number, message?: string, epsilon = 1e-9) {
	assert.ok(Math.abs(actual - expected) < epsilon, `${message ?? ""} expected ${expected}, got ${actual}`);
}

function assertPointClose(actual: CropPoint, expected: CropPoint, message?: string) {
	assertClose(actual.x, expected.x, `${message ?? ""} x:`);
	assertClose(actual.y, expected.y, `${message ?? ""} y:`);
}

function assertAffineClose(actual: AffineTransform, expected: AffineTransform) {
	for (const k of ["a", "b", "c", "d", "e", "f"] as const) {
		assertClose(actual[k], expected[k], `component ${k}:`, 1e-9);
	}
}

describe("affine primitives", () => {
	const sample: AffineTransform = { a: 0.5, b: 0.25, c: -0.75, d: 2, e: 13, f: -7 };

	it("multiplying by the identity changes nothing", () => {
		assertAffineClose(multiplyAffine(sample, IDENTITY), sample);
		assertAffineClose(multiplyAffine(IDENTITY, sample), sample);
	});

	it("composes in apply order: multiply(outer, inner) applies inner first", () => {
		const inner: AffineTransform = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 }; // translate x+10
		const outer: AffineTransform = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }; // scale 2x
		const composed = multiplyAffine(outer, inner);
		const point = { x: 1, y: 1 };
		assertPointClose(applyAffine(composed, point), applyAffine(outer, applyAffine(inner, point)));
		assertPointClose(applyAffine(composed, point), { x: 22, y: 2 });
	});

	it("inverts to the identity", () => {
		const inverse = invertAffine(sample);
		assert.notEqual(inverse, null);
		assertAffineClose(multiplyAffine(sample, inverse!), IDENTITY);
		assertAffineClose(multiplyAffine(inverse!, sample), IDENTITY);
	});

	it("round-trips a point through inverse", () => {
		const inverse = invertAffine(sample)!;
		const point = { x: 3.5, y: -12 };
		assertPointClose(applyAffine(inverse, applyAffine(sample, point)), point);
	});

	it("returns null for a singular (degenerate) transform", () => {
		assert.equal(invertAffine({ a: 0, b: 0, c: 0, d: 0, e: 5, f: 5 }), null);
		assert.equal(invertAffine({ a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 }), null, "collinear rows");
	});

	it("rotateVector drops translation, applyAffine keeps it", () => {
		const translate: AffineTransform = { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 };
		assertPointClose(rotateVector(translate, { x: 1, y: 2 }), { x: 1, y: 2 });
		assertPointClose(applyAffine(translate, { x: 1, y: 2 }), { x: 101, y: 52 });
	});
});

describe("elementLocalToScene", () => {
	it("is a plain translation for an upright element", () => {
		const el: CropImageElement = { x: 10, y: 20, width: 100, height: 50 };
		const t = elementLocalToScene(el);
		assertPointClose(applyAffine(t, { x: 0, y: 0 }), { x: 10, y: 20 }, "top-left");
		assertPointClose(applyAffine(t, { x: 100, y: 50 }), { x: 110, y: 70 }, "bottom-right");
	});

	it("rotates about the element's own centre", () => {
		const el: CropImageElement = { x: 10, y: 20, width: 100, height: 50, angle: Math.PI / 2 };
		const t = elementLocalToScene(el);
		const centre = { x: 60, y: 45 };
		assertPointClose(applyAffine(t, { x: 50, y: 25 }), centre, "local centre maps to box centre");

		// Opposite corners must still straddle the centre.
		const topLeft = applyAffine(t, { x: 0, y: 0 });
		const bottomRight = applyAffine(t, { x: 100, y: 50 });
		assertPointClose({ x: (topLeft.x + bottomRight.x) / 2, y: (topLeft.y + bottomRight.y) / 2 }, centre);
	});

	it("localPolygonForSceneRect is the inverse of elementLocalToScene", () => {
		const el: CropImageElement = { x: 10, y: 20, width: 100, height: 50, angle: 0.7 };
		const rect = { x: 30, y: 25, width: 40, height: 20 };
		const local = localPolygonForSceneRect(el, rect);
		assert.notEqual(local, null);
		const backToScene = local!.map((p) => applyAffine(elementLocalToScene(el), p));
		const bounds = polygonBounds(backToScene)!;
		assertClose(bounds.x, rect.x, "x:", 1e-6);
		assertClose(bounds.y, rect.y, "y:", 1e-6);
		assertClose(bounds.width, rect.width, "width:", 1e-6);
		assertClose(bounds.height, rect.height, "height:", 1e-6);
	});
});

describe("convex polygon clipping", () => {
	const square = (x: number, y: number, size: number): CropPoint[] => [
		{ x, y },
		{ x: x + size, y },
		{ x: x + size, y: y + size },
		{ x, y: y + size },
	];

	it("intersects two overlapping squares", () => {
		const bounds = polygonBounds(intersectConvexPolygons(square(0, 0, 10), square(5, 5, 10)));
		assert.deepEqual(bounds, { x: 5, y: 5, width: 5, height: 5 });
	});

	it("returns a degenerate result for disjoint polygons", () => {
		assert.ok(intersectConvexPolygons(square(0, 0, 10), square(100, 100, 10)).length < 3);
	});

	it("returns the inner polygon when one contains the other", () => {
		const bounds = polygonBounds(intersectConvexPolygons(square(0, 0, 100), square(20, 20, 10)));
		assert.deepEqual(bounds, { x: 20, y: 20, width: 10, height: 10 });
	});

	it("is orientation-independent (clockwise or counter-clockwise clip)", () => {
		const clockwise = square(5, 5, 10);
		const counterClockwise = [...clockwise].reverse();
		assert.deepEqual(
			polygonBounds(intersectConvexPolygons(square(0, 0, 10), clockwise)),
			polygonBounds(intersectConvexPolygons(square(0, 0, 10), counterClockwise)),
		);
	});

	it("rejects degenerate inputs", () => {
		assert.deepEqual(intersectConvexPolygons([{ x: 0, y: 0 }], square(0, 0, 10)), []);
		assert.equal(polygonBounds([{ x: 0, y: 0 }, { x: 1, y: 1 }]), null);
	});

	it("pointInsideConvexPolygon accepts interior and boundary, rejects exterior", () => {
		const box = square(0, 0, 10);
		assert.equal(pointInsideConvexPolygon({ x: 5, y: 5 }, box), true, "interior");
		assert.equal(pointInsideConvexPolygon({ x: 0, y: 0 }, box), true, "corner counts as inside");
		assert.equal(pointInsideConvexPolygon({ x: -1, y: 5 }, box), false, "exterior");
		assert.equal(pointInsideConvexPolygon({ x: 5, y: 5 }, [{ x: 0, y: 0 }]), false, "degenerate polygon");
	});
});

describe("filePixelsToCurrentLocal", () => {
	const el: CropImageElement = { x: 0, y: 0, width: 100, height: 100 };
	const natural = { w: 200, h: 200 };

	it("scales source pixels down into the element box", () => {
		const t = filePixelsToCurrentLocal(el, natural);
		assertPointClose(applyAffine(t, { x: 0, y: 0 }), { x: 0, y: 0 });
		assertPointClose(applyAffine(t, { x: 200, y: 200 }), { x: 100, y: 100 });
	});

	it("mirrors horizontally for scale [-1, 1]", () => {
		const t = filePixelsToCurrentLocal({ ...el, scale: [-1, 1] }, natural);
		assertPointClose(applyAffine(t, { x: 0, y: 0 }), { x: 100, y: 0 }, "source left edge lands on the right");
		assertPointClose(applyAffine(t, { x: 200, y: 0 }), { x: 0, y: 0 }, "source right edge lands on the left");
	});

	it("mirrors vertically for scale [1, -1]", () => {
		const t = filePixelsToCurrentLocal({ ...el, scale: [1, -1] }, natural);
		assertPointClose(applyAffine(t, { x: 0, y: 0 }), { x: 0, y: 100 });
		assertPointClose(applyAffine(t, { x: 0, y: 200 }), { x: 0, y: 0 });
	});

	it("accounts for an existing crop, mapping the visible sub-rect onto the box", () => {
		// Element shows the source's right half.
		const cropped: CropImageElement = {
			x: 0,
			y: 0,
			width: 100,
			height: 200,
			crop: { x: 100, y: 0, width: 100, height: 200, naturalWidth: 200, naturalHeight: 200 },
		};
		const t = filePixelsToCurrentLocal(cropped, natural);
		assertPointClose(applyAffine(t, { x: 100, y: 0 }), { x: 0, y: 0 }, "crop origin maps to the box origin");
		assertPointClose(applyAffine(t, { x: 200, y: 200 }), { x: 100, y: 200 }, "crop far corner maps to the box corner");
	});
});

describe("viewportCropToCurrentLocal", () => {
	it("returns null when the saved polygon is degenerate", () => {
		const el: CropImageElement = { x: 0, y: 0, width: 10, height: 10 };
		assert.equal(viewportCropToCurrentLocal(el, { polygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, { w: 10, h: 10 }), null);
		assert.equal(
			viewportCropToCurrentLocal(el, { polygon: [{ x: 5, y: 0 }, { x: 5, y: 10 }, { x: 5, y: 20 }] }, { w: 10, h: 10 }),
			null,
			"zero-width polygon",
		);
	});

	it("maps the saved polygon's bounding box onto the element box", () => {
		const el: CropImageElement = { x: 0, y: 0, width: 50, height: 50 };
		// Polygon occupied local (10,10)-(30,30) when the PNG was generated.
		const polygon = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }];
		const t = viewportCropToCurrentLocal(el, { polygon }, { w: 100, h: 100 })!;
		assert.notEqual(t, null);
		assertPointClose(applyAffine(t, { x: 10, y: 10 }), { x: 0, y: 0 }, "polygon top-left → element origin");
		assertPointClose(applyAffine(t, { x: 30, y: 30 }), { x: 50, y: 50 }, "polygon bottom-right → element corner");
	});
});

describe("planImageCrop", () => {
	const natural = { w: 200, h: 200 };
	const upright: CropImageElement = { x: 0, y: 0, width: 100, height: 100 };

	it("defers rotated images to the polygon path", () => {
		assert.equal(planImageCrop({ ...upright, angle: 0.5 }, { x: 0, y: 0, width: 50, height: 50 }, natural), null);
	});

	it("treats a rect covering an uncropped image as a no-op, not a redundant full crop", () => {
		const plan = planImageCrop(upright, { x: 0, y: 0, width: 100, height: 100 }, natural);
		assert.notEqual(plan, null);
		assert.equal(plan!.crop, null, "stays uncropped");
		assert.deepEqual({ x: plan!.x, y: plan!.y, width: plan!.width, height: plan!.height }, { x: 0, y: 0, width: 100, height: 100 });
	});

	it("crops the right half into source-pixel coordinates", () => {
		const plan = planImageCrop(upright, { x: 50, y: 0, width: 50, height: 100 }, natural)!;
		assert.deepEqual({ x: plan.x, y: plan.y, width: plan.width, height: plan.height }, { x: 50, y: 0, width: 50, height: 100 });
		assert.deepEqual(plan.crop, { x: 100, y: 0, width: 100, height: 200, naturalWidth: 200, naturalHeight: 200 });
	});

	it("stores a flipped image's crop from the opposite edge", () => {
		// Cropping the displayed right half of a mirrored image keeps the source's
		// LEFT half, which Excalidraw stores as x = 0.
		const plan = planImageCrop({ ...upright, scale: [-1, 1] }, { x: 50, y: 0, width: 50, height: 100 }, natural)!;
		assert.equal(plan.crop!.x, 0);
		assert.equal(plan.crop!.width, 100);
	});

	it("stores a vertically flipped image's crop from the bottom edge", () => {
		const plan = planImageCrop({ ...upright, scale: [1, -1] }, { x: 0, y: 50, width: 100, height: 50 }, natural)!;
		assert.equal(plan.crop!.y, 0);
		assert.equal(plan.crop!.height, 100);
	});

	it("composes with an existing crop rather than restarting from the full image", () => {
		// Element already shows the source's right half; crop its right half again.
		const cropped: CropImageElement = {
			x: 0,
			y: 0,
			width: 50,
			height: 100,
			crop: { x: 100, y: 0, width: 100, height: 200, naturalWidth: 200, naturalHeight: 200 },
		};
		const plan = planImageCrop(cropped, { x: 25, y: 0, width: 25, height: 100 }, natural)!;
		// Right half of the right half = the source's final quarter, x 150..200.
		assert.equal(plan.crop!.x, 150);
		assert.equal(plan.crop!.width, 50);
	});

	it("never re-adds pixels an earlier crop removed", () => {
		const cropped: CropImageElement = {
			x: 0,
			y: 0,
			width: 50,
			height: 100,
			crop: { x: 100, y: 0, width: 100, height: 200, naturalWidth: 200, naturalHeight: 200 },
		};
		// A rect far larger than the element must not restore the hidden left half.
		const plan = planImageCrop(cropped, { x: -1000, y: -1000, width: 5000, height: 5000 }, natural)!;
		assert.deepEqual(plan.crop, cropped.crop, "crop is unchanged, not widened");
		assert.equal(plan.width, 50, "element box is unchanged");
	});

	it("returns null for a degenerate sliver", () => {
		assert.equal(planImageCrop(upright, { x: 0, y: 0, width: 0.5, height: 100 }, natural), null, "too thin");
		assert.equal(planImageCrop(upright, { x: 0, y: 0, width: 100, height: 0.5 }, natural), null, "too short");
	});

	it("returns null when the rect misses the element entirely", () => {
		assert.equal(planImageCrop(upright, { x: 500, y: 500, width: 50, height: 50 }, natural), null);
	});

	it("returns null for a degenerate element box", () => {
		assert.equal(planImageCrop({ x: 0, y: 0, width: 0, height: 100 }, { x: 0, y: 0, width: 10, height: 10 }, natural), null);
	});

	it("keeps the visible aspect ratio consistent between box and crop", () => {
		const plan = planImageCrop(upright, { x: 10, y: 20, width: 60, height: 40 }, natural)!;
		const boxRatio = plan.width / plan.height;
		const cropRatio = plan.crop!.width / plan.crop!.height;
		assertClose(boxRatio, cropRatio, "box and crop describe the same region:", 1e-9);
	});

	it("clamps the rect to the element, so a partly-overlapping rect crops only the shared part", () => {
		const plan = planImageCrop(upright, { x: -50, y: -50, width: 100, height: 100 }, natural)!;
		assert.deepEqual({ x: plan.x, y: plan.y, width: plan.width, height: plan.height }, { x: 0, y: 0, width: 50, height: 50 });
		assert.deepEqual(plan.crop, { x: 0, y: 0, width: 100, height: 100, naturalWidth: 200, naturalHeight: 200 });
	});
});
