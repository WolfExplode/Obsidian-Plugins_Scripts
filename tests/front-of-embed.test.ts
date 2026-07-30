import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FREEDRAW_SIZE_FACTOR,
	MASK_ANTIALIAS_ALLOWANCE_PX,
	MASK_JITTER_ALLOWANCE,
	curveControlPoints,
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
		const outlined = maskShapeFor(el({ id: "r", type: "ellipse", backgroundColor: "transparent", strokeWidth: 2 }));
		assert.equal(outlined.kind === "ellipse" && outlined.fill, false);

		const box = maskShapeFor(el({ id: "r", type: "rectangle", backgroundColor: "transparent" }));
		assert.equal(box.kind === "roundrect" && box.fill, false);
	});

	it("treats a missing backgroundColor as unfilled", () => {
		const shape = maskShapeFor(el({ id: "r", type: "rectangle", roundness: { type: 3 } }));
		assert.equal(shape.kind, "roundrect");
		assert.equal(shape.kind === "roundrect" && shape.fill, false);

		// A sharp rectangle goes through the rough.js path, where an unfilled interior
		// is expressed as having no fill polygon at all.
		const sharp = maskShapeFor(el({ id: "s", type: "rectangle" }));
		assert.equal(sharp.kind, "rough");
		assert.equal(sharp.kind === "rough" && sharp.fillPoints, null);
	});

	it("masks a filled shape's interior too", () => {
		const filled = maskShapeFor(el({ id: "r", type: "rectangle", backgroundColor: "#ffc9c9", roundness: { type: 3 } }));
		assert.equal(filled.kind === "roundrect" && filled.fill, true);

		const sharp = maskShapeFor(el({ id: "s", type: "rectangle", width: 40, height: 20, backgroundColor: "#ffc9c9" }));
		assert.deepEqual(sharp.kind === "rough" ? sharp.fillPoints : null, [
			[0, 0],
			[40, 0],
			[40, 20],
			[0, 20],
		]);
	});

	it("masks a rectangle with the corner radius Excalidraw actually draws it with", () => {
		// Square corners left four triangles of scene background outside the drawn
		// arcs, which read as notched corners over the embeddable.
		// Adaptive radius: a quarter of the shorter side until that exceeds the fixed
		// 32, and 32 thereafter.
		const big = maskShapeFor(el({ id: "r", type: "rectangle", width: 280, height: 200, roundness: { type: 3 } }));
		assert.equal(big.kind === "roundrect" && big.radius, 32);
		const small = maskShapeFor(el({ id: "r", type: "rectangle", width: 280, height: 80, roundness: { type: 3 } }));
		assert.equal(small.kind === "roundrect" && small.radius, 20);
		const custom = maskShapeFor(
			el({ id: "r", type: "rectangle", width: 280, height: 200, roundness: { type: 3, value: 8 } }),
		);
		assert.equal(custom.kind === "roundrect" && custom.radius, 8);

		// Proportional radius is a flat quarter of the shorter side at any size.
		const proportional = maskShapeFor(
			el({ id: "r", type: "rectangle", width: 280, height: 200, roundness: { type: 2 } }),
		);
		assert.equal(proportional.kind === "roundrect" && proportional.radius, 50);
	});

	it("masks an ellipse as an ellipse", () => {
		const shape = maskShapeFor(el({ id: "e", type: "ellipse", strokeWidth: 4, roughness: 1 }));
		assert.deepEqual(shape, { kind: "ellipse", fill: false, strokeWidth: 4, roughness: 1, dash: null });
	});

	it("masks a dashed or dotted stroke with Excalidraw's own dash pattern and width", () => {
		// A solid mask over a dashed stroke paints scene background into every gap.
		const solid = maskShapeFor(el({ id: "s", type: "ellipse", strokeWidth: 2, strokeStyle: "solid" }));
		assert.equal(solid.kind === "ellipse" && solid.dash, null);
		assert.equal(solid.kind === "ellipse" && solid.strokeWidth, 2);

		// Verified against exportToSvg: stroke-dasharray "8 10", stroke-width 2.5.
		const dashed = maskShapeFor(el({ id: "d", type: "ellipse", strokeWidth: 2, strokeStyle: "dashed" }));
		assert.deepEqual(dashed.kind === "ellipse" ? dashed.dash : null, [8, 10]);
		assert.equal(dashed.kind === "ellipse" && dashed.strokeWidth, 2.5);

		// ...and "1.5 8" when dotted.
		const dotted = maskShapeFor(el({ id: "o", type: "ellipse", strokeWidth: 2, strokeStyle: "dotted" }));
		assert.deepEqual(dotted.kind === "ellipse" ? dotted.dash : null, [1.5, 8]);
		assert.equal(dotted.kind === "ellipse" && dotted.strokeWidth, 2.5);

		// The pattern reaches every stroked shape, not just ellipses.
		const rect = maskShapeFor(
			el({ id: "r", type: "rectangle", strokeWidth: 1, strokeStyle: "dashed", roundness: { type: 3 } }),
		);
		assert.deepEqual(rect.kind === "roundrect" ? rect.dash : null, [8, 9]);
		const line = maskShapeFor(
			el({ id: "l", type: "line", strokeWidth: 1, strokeStyle: "dotted", points: [[0, 0], [10, 10]] }),
		);
		assert.deepEqual(line.kind === "rough" ? line.dash : null, [1.5, 7]);
	});

	it("masks a freedraw with the stroke outline, not a stroked centerline", () => {
		// Excalidraw fills the polygon perfect-freehand builds around the stroke. The
		// recorded points are streamlined before they are drawn, so they are not where
		// the stroke is, and its width varies with pressure along its length.
		const points = [
			[0, 0],
			[20, 8],
			[40, 0],
			[60, 12],
		];
		const stroke = maskShapeFor(el({ id: "f", type: "freedraw", points, strokeWidth: 2 }));
		assert.equal(stroke.kind, "outline");
		assert.ok(stroke.kind === "outline" && stroke.points.length > points.length);

		// A line goes through rough.js and is masked along the path it actually drew.
		const line = maskShapeFor(el({ id: "l", type: "line", points, strokeWidth: 2 }));
		assert.equal(line.kind, "rough");
		assert.equal(line.kind === "rough" && line.strokeWidth, 2);
	});

	it("scales the freedraw outline with strokeWidth", () => {
		const points = [
			[0, 0],
			[20, 8],
			[40, 0],
			[60, 12],
		];
		const spanOf = (strokeWidth: number): number => {
			const shape = maskShapeFor(el({ id: "f", type: "freedraw", points, strokeWidth }));
			assert.ok(shape.kind === "outline");
			const ys = shape.kind === "outline" ? shape.points.map((point) => point[1] ?? 0) : [];
			return Math.max(...ys) - Math.min(...ys);
		};
		assert.ok(spanOf(4) > spanOf(1), "a wider stroke should produce a wider outline");
	});

	it("carries roughness through to the dilation for the shapes still using an allowance", () => {
		// Rounded rectangles and ellipses aren't reproduced from the seed yet, so they
		// still widen by an allowance -- which is zero at architect roughness.
		const artist = maskShapeFor(el({ id: "e", type: "ellipse", roughness: 2 }));
		assert.equal(artist.kind === "ellipse" && artist.roughness, 2);
		const architect = maskShapeFor(el({ id: "a", type: "rectangle", roughness: 0, roundness: { type: 3 } }));
		assert.equal(architect.kind === "roundrect" && architect.roughness, 0);
	});

	it("masks a diamond along Excalidraw's own vertices, which are not the midpoints", () => {
		// getDiamondPoints puts the top and right at floor(side / 2) + 1. Verified
		// live: a 280x200 diamond is drawn through x=141, y=101.
		const shape = maskShapeFor(el({ id: "d", type: "diamond", width: 280, height: 200, backgroundColor: "#ffc9c9" }));
		assert.equal(shape.kind, "rough");
		assert.deepEqual(shape.kind === "rough" ? shape.fillPoints : null, [
			[141, 0],
			[280, 101],
			[141, 200],
			[0, 101],
		]);
	});

	it("masks a linear element along the path rough.js actually drew", () => {
		const points = [
			[0, 0],
			[50, 20],
			[100, 0],
		];
		for (const type of ["arrow", "line"]) {
			const shape = maskShapeFor(el({ id: "x", type, points, seed: 12345 }));
			assert.equal(shape.kind, "rough", `${type} should mask along its drawn path`);
			assert.ok(shape.kind === "rough" && shape.ops.length > 0, `${type} should produce drawing ops`);
			// Two passes for a solid stroke, so more ops than there are segments.
			assert.ok(shape.kind === "rough" && shape.ops.length >= 4);
		}

		// A non-solid stroke is drawn as a single pass, so it produces half as many.
		const solid = maskShapeFor(el({ id: "s", type: "line", points, seed: 12345 }));
		const dotted = maskShapeFor(el({ id: "d", type: "line", points, seed: 12345, strokeStyle: "dotted" }));
		assert.ok(
			solid.kind === "rough" && dotted.kind === "rough" && solid.ops.length === dotted.ops.length * 2,
			"a solid stroke is drawn twice, a dotted one once",
		);
	});

	it("reproduces a different hand-drawn path per seed, and the same one for the same seed", () => {
		const points = [
			[0, 0],
			[50, 20],
			[100, 0],
		];
		const opsFor = (seed: number, roundness: { type: number } | null = null) => {
			const shape = maskShapeFor(el({ id: "a", type: "arrow", points, seed, roundness }));
			return shape.kind === "rough" ? JSON.stringify(shape.ops) : "";
		};
		assert.equal(opsFor(999), opsFor(999), "the same seed must redraw identically");
		assert.notEqual(opsFor(999), opsFor(1000), "a different seed must wander differently");
		// A curved element goes through rough's curve routine, not its line routine.
		assert.notEqual(opsFor(999), opsFor(999, { type: 2 }));
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

	it("masks a diamond without smoothing, so its corners stay sharp", () => {
		const shape = maskShapeFor(el({ id: "s", type: "diamond", roundness: { type: 3 } }));
		assert.equal(shape.kind === "path" && shape.smooth, false);
	});

	it("fills a linear element only when its path loops, as Excalidraw itself does", () => {
		// An open stroke is drawn as a bare stroke whatever background is set on it, so
		// filling its raw polyline masks the path's whole convex sweep -- a band of
		// scene background clear across the embeddable.
		const open = [
			[0, 0],
			[50, 20],
			[100, 0],
		];
		const loop = [
			[0, 0],
			[50, 20],
			[100, 0],
			[2, 3],
		];
		for (const type of ["line", "arrow"]) {
			const openShape = maskShapeFor(el({ id: "o", type, points: open, backgroundColor: "#1e1e1e" }));
			assert.equal(openShape.kind === "rough" && openShape.fillPoints, null, `open ${type} should not be filled`);

			const loopShape = maskShapeFor(el({ id: "c", type, points: loop, backgroundColor: "#1e1e1e" }));
			assert.deepEqual(loopShape.kind === "rough" ? loopShape.fillPoints : null, loop, `looping ${type} fills`);
		}

		// A freedraw's outline always covers its stroke; the loop test only decides
		// whether the interior gets masked too.
		const openStroke = maskShapeFor(el({ id: "of", type: "freedraw", points: open, backgroundColor: "#1e1e1e" }));
		assert.equal(openStroke.kind === "outline" && openStroke.interior, null);
		const loopStroke = maskShapeFor(el({ id: "cf", type: "freedraw", points: loop, backgroundColor: "#1e1e1e" }));
		assert.deepEqual(loopStroke.kind === "outline" ? loopStroke.interior : null, loop);

		// A loop whose background is transparent still isn't filled -- the background
		// colour remains what decides, the loop test only gates it.
		const unfilled = maskShapeFor(el({ id: "t", type: "line", points: loop, backgroundColor: "transparent" }));
		assert.equal(unfilled.kind === "rough" && unfilled.fillPoints, null);

		// Too few points to close, and a gap wider than Excalidraw's threshold.
		const twoPoint = maskShapeFor(el({ id: "2", type: "line", points: [[0, 0], [0, 0]], backgroundColor: "#1e1e1e" }));
		assert.equal(twoPoint.kind === "rough" && twoPoint.fillPoints, null);
		const nearMiss = maskShapeFor(
			el({ id: "n", type: "line", points: [[0, 0], [50, 20], [100, 0], [11, 0]], backgroundColor: "#1e1e1e" }),
		);
		assert.equal(nearMiss.kind === "rough" && nearMiss.fillPoints, null);
	});

	it("offsets text horizontally to match Excalidraw's own alignment handling", () => {
		const centered = maskShapeFor(el({ id: "t", type: "text", text: "x", width: 80, textAlign: "center" }));
		assert.equal(centered.kind === "text" && centered.horizontalOffset, 40);

		const right = maskShapeFor(el({ id: "t", type: "text", text: "x", width: 80, textAlign: "right" }));
		assert.equal(right.kind === "text" && right.horizontalOffset, 80);
	});
});

describe("maskDilation", () => {
	it("scales the jitter allowance by roughness, as rough.js scales its own offsets", () => {
		// Architect style is drawn exactly on the path, so it needs no allowance at
		// all; a flat one was two scene units of pure background around every edge.
		assert.equal(maskDilation(1, 0), MASK_ANTIALIAS_ALLOWANCE_PX);
		assert.equal(maskDilation(1, 1) - maskDilation(1, 0), MASK_JITTER_ALLOWANCE);
		assert.equal(maskDilation(1, 2) - maskDilation(1, 0), MASK_JITTER_ALLOWANCE * 2);
	});

	it("shrinks the antialias allowance in scene units as zoom rises, so it stays ~constant on screen", () => {
		// A fixed scene-space rim would grow on screen when zoomed in, haloing text
		// in scene background; expressing it in screen pixels keeps it a hairline.
		assert.equal(maskDilation(1, 0), MASK_ANTIALIAS_ALLOWANCE_PX);
		assert.equal(maskDilation(4, 0), MASK_ANTIALIAS_ALLOWANCE_PX / 4);
		assert.equal(maskDilation(0.25, 0), MASK_ANTIALIAS_ALLOWANCE_PX * 4);
	});

	it("stays finite at absurd zoom levels, and never shrinks below the antialias allowance", () => {
		assert.ok(Number.isFinite(maskDilation(0, 1)));
		assert.equal(maskDilation(1, -5), MASK_ANTIALIAS_ALLOWANCE_PX);
	});
});

describe("curveControlPoints", () => {
	it("passes through every point, first and last included", () => {
		const points = [
			[0, 0],
			[651.6, 95.2],
			[754.9, 544.4],
		];
		const segments = curveControlPoints(points);
		assert.equal(segments.length, points.length - 1);
		assert.deepEqual(
			segments.map((segment) => [...segment.to]),
			[points[1], points[2]],
		);
	});

	it("builds the same control points rough.js does, so the mask tracks the drawn curve", () => {
		// rough.js duplicates the first and last point and runs a Catmull-Rom spline at
		// curveTightness 0, giving cp1 = p1 + (p2 - p0)/6 and cp2 = p2 + (p1 - p3)/6.
		const points = [
			[0, 0],
			[60, 0],
			[60, 60],
		];
		const [first, second] = curveControlPoints(points);
		assert.ok(first && second);
		// First segment: previous point is the duplicated p0, next is p2.
		assert.deepEqual([...first.cp1], [10, 0]);
		assert.deepEqual([...first.cp2], [60 + (0 - 60) / 6, 0 + (0 - 60) / 6]);
		// Last segment: next point is the duplicated final point.
		assert.deepEqual([...second.cp1], [60 + (60 - 0) / 6, 0 + (60 - 0) / 6]);
		assert.deepEqual([...second.cp2], [60, 50]);
	});

	it("evaluates far from the quadratic-through-midpoints curve it replaces", () => {
		// The old smoothing put the midpoint of this arrow 210 scene units away from
		// where rough.js draws, which is why the mask tracked nothing.
		const points = [
			[0, 0],
			[651.6, 95.2],
			[754.9, 544.4],
		];
		const segment = curveControlPoints(points)[0];
		assert.ok(segment);
		const midpoint = (a: number, b: number, c: number, d: number) => (a + 3 * b + 3 * c + d) / 8;
		const x = midpoint(0, segment.cp1[0], segment.cp2[0], segment.to[0]);
		const y = midpoint(0, segment.cp1[1], segment.cp2[1], segment.to[1]);
		assert.ok(Math.hypot(x - 501.6, y - 127.55) > 150, `expected a large divergence, got (${x}, ${y})`);
	});

	it("handles a two-point path as a single segment", () => {
		const segments = curveControlPoints([
			[0, 0],
			[30, 0],
		]);
		assert.equal(segments.length, 1);
		assert.deepEqual([...(segments[0]?.to ?? [])], [30, 0]);
	});
});
