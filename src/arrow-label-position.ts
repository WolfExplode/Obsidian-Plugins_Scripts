/**
 * Where an arrow's bound label actually sits -- a port of
 * `LinearElementEditor.getBoundTextElementPosition`
 * (packages/element/src/linearElementEditor.ts) and the pieces it calls
 * through (`getSegmentMidPoint`, `getPointGlobalCoordinates`,
 * `deconstructLinearOrFreeDrawElement`, `curvePointAtLength`), because none of
 * it is exposed on `window.ExcalidrawLib` -- see docs/behavior/front-of-embed-rendering.md.
 *
 * Excalidraw ignores the label's own `x`/`y` for an arrow container (unlike a
 * shape container, where `redrawTextBoundingBox` keeps them accurate) and
 * instead centres the label on the arrow's middle point or middle segment,
 * recomputed live at render time from the arrow's current `points`. Which of
 * the two depends on parity:
 *
 * - **Odd `points.length`**: the label centres on the actual middle point,
 *   rotated about the arrow's own bounds centre -- cheap, no curve math.
 * - **Even `points.length`**: the label centres on the *drawn* middle
 *   segment. For an elbow arrow that's just the segment's two endpoints
 *   averaged (elbow arrows don't rotate). For an ordinary arrow with sharp
 *   corners (`!roundness`) it's the straight segment's midpoint. For an
 *   ordinary arrow with rounded corners (Excalidraw's default) the segment is
 *   actually a rough.js-generated bezier through the neighbouring points, and
 *   the label sits at that curve's *arc-length* midpoint, not its parametric
 *   one -- both ported here using the real `roughjs` package (the same
 *   version Excalidraw itself bundles, pinned in package.json) for the curve
 *   generation, and a standard 24-point Legendre-Gauss quadrature (the same
 *   one `packages/math/src/curve.ts` uses) for the arc-length search. Neither
 *   is a guess at proprietary logic -- roughjs's `curve()` at `roughness: 0`
 *   is deterministic, and Gauss-Legendre quadrature is textbook numerical
 *   integration -- so this doesn't carry the drift risk the earlier
 *   rough.js/perfect-freehand reconstruction ports did (see "Deliberate scope
 *   cuts" in the doc).
 */

import { RoughGenerator } from "roughjs/bin/generator";
import type { Options } from "roughjs/bin/core";
import type { AbsoluteBounds, FrontOfEmbedElement } from "./front-of-embed";

type Pt = readonly [number, number];
type CubicBezier = readonly [Pt, Pt, Pt, Pt];

/** 24-point Legendre-Gauss quadrature nodes, matching packages/math/src/constants.ts. */
const LEGENDRE_T = [
	-0.06405689286260563, 0.06405689286260563,
	-0.1911188674736163, 0.1911188674736163,
	-0.3150426796961634, 0.3150426796961634,
	-0.4337935076260451, 0.4337935076260451,
	-0.5454214713888396, 0.5454214713888396,
	-0.6480936519369755, 0.6480936519369755,
	-0.7401241915785544, 0.7401241915785544,
	-0.820001985973903, 0.820001985973903,
	-0.8864155270044011, 0.8864155270044011,
	-0.9382745520027328, 0.9382745520027328,
	-0.9747285559713095, 0.9747285559713095,
	-0.9951872199970213, 0.9951872199970213,
];

/** Matching quadrature weights. */
const LEGENDRE_C = [
	0.12793819534675216, 0.12793819534675216,
	0.1258374563468283, 0.1258374563468283,
	0.12167047292780339, 0.12167047292780339,
	0.1155056680537256, 0.1155056680537256,
	0.10744427011596563, 0.10744427011596563,
	0.09761865210411388, 0.09761865210411388,
	0.08619016153195327, 0.08619016153195327,
	0.0733464814110803, 0.0733464814110803,
	0.05929858491543678, 0.05929858491543678,
	0.04427743881741981, 0.04427743881741981,
	0.028531388628933663, 0.028531388628933663,
	0.0123412297999872, 0.0123412297999872,
];

function bezierPoint(c: CubicBezier, t: number): Pt {
	const [p0, p1, p2, p3] = c;
	const mt = 1 - t;
	const mt2 = mt * mt;
	const mt3 = mt2 * mt;
	const t2 = t * t;
	const t3 = t2 * t;
	return [
		mt3 * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t3 * p3[0],
		mt3 * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t3 * p3[1],
	];
}

function bezierTangent(c: CubicBezier, t: number): Pt {
	const [p0, p1, p2, p3] = c;
	const mt = 1 - t;
	return [
		-3 * mt * mt * p0[0] + 3 * mt * mt * p1[0] - 6 * t * mt * p1[0] - 3 * t * t * p2[0] + 6 * t * mt * p2[0] + 3 * t * t * p3[0],
		-3 * mt * mt * p0[1] + 3 * mt * mt * p1[1] - 6 * t * mt * p1[1] - 3 * t * t * p2[1] + 6 * t * mt * p2[1] + 3 * t * t * p3[1],
	];
}

/** Arc length of `c` from parameter `a` to `b`, via 24-point Gauss-Legendre quadrature. */
function arcLength(c: CubicBezier, a: number, b: number): number {
	const z = (b - a) / 2;
	const m = (a + b) / 2;
	let sum = 0;
	for (let i = 0; i < 24; i++) {
		const t = z * LEGENDRE_T[i] + m;
		const [dx, dy] = bezierTangent(c, t);
		sum += LEGENDRE_C[i] * Math.sqrt(dx * dx + dy * dy);
	}
	return z * sum;
}

/** The point at 50% of `c`'s total arc length -- ports `curvePointAtLength(c, 0.5)`. */
function curveMidpoint(c: CubicBezier): Pt {
	const totalLength = arcLength(c, 0, 1);
	if (totalLength === 0) return bezierPoint(c, 0.5);
	const target = totalLength / 2;
	const tolerance = totalLength * 0.0001;
	let tMin = 0;
	let tMax = 1;
	let t = 0.5;
	for (let i = 0; i < 20; i++) {
		const length = arcLength(c, 0, t);
		if (Math.abs(length - target) < tolerance) break;
		if (length < target) tMin = t;
		else tMax = t;
		t = (tMin + tMax) / 2;
	}
	return bezierPoint(c, t);
}

function rotateAboutCenter(x: number, y: number, cx: number, cy: number, angle: number): Pt {
	if (!angle) return [x, y];
	const dx = x - cx;
	const dy = y - cy;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/** Options matching `generateLinearCollisionShape` exactly: deterministic, vertex-preserving. */
function collisionCurveOptions(seed: number | undefined): Options {
	return { seed, disableMultiStroke: true, disableMultiStrokeFill: true, roughness: 0, preserveVertices: true };
}

interface RoughOp {
	op: string;
	data: number[];
}

/**
 * The `[start, cp1, cp2, end]` control points of the bezier segment at ops
 * index `opIndex` (1-based, i.e. the first real segment after the leading
 * `move`), converted from the curve generator's local, unrotated output into
 * absolute scene coordinates.
 */
function curveSegmentAt(ops: readonly RoughOp[], opIndex: number, toGlobal: (x: number, y: number) => Pt): CubicBezier | null {
	const op = ops[opIndex];
	const prevOp = ops[opIndex - 1];
	if (!op || op.op !== "bcurveTo" || !prevOp) return null;
	const prevData = prevOp.data;
	const start = toGlobal(prevData[prevData.length - 2], prevData[prevData.length - 1]);
	return [start, toGlobal(op.data[0], op.data[1]), toGlobal(op.data[2], op.data[3]), toGlobal(op.data[4], op.data[5])];
}

/**
 * The absolute scene midpoint of an arrow's middle point or middle segment --
 * `LinearElementEditor.getBoundTextElementPosition` minus the final
 * width/height centring, which the caller applies. `null` when there isn't
 * enough geometry to place it (fewer than 2 points).
 */
function arrowMidpoint(arrow: FrontOfEmbedElement, bounds: AbsoluteBounds): Pt | null {
	const points = arrow.points;
	if (!points || points.length < 2) return null;

	const cx = (bounds.minX + bounds.maxX) / 2;
	const cy = (bounds.minY + bounds.maxY) / 2;
	const angle = arrow.angle ?? 0;
	const toGlobal = (x: number, y: number): Pt => rotateAboutCenter(arrow.x + x, arrow.y + y, cx, cy, angle);

	if (points.length % 2 === 1) {
		const p = points[Math.floor(points.length / 2)];
		return toGlobal(p[0], p[1]);
	}

	const opIndex = points.length / 2;

	if (arrow.elbowed) {
		const a = points[opIndex - 1];
		const b = points[opIndex];
		// Elbow arrows don't rotate, so this deliberately skips toGlobal's rotation,
		// matching `getSegmentMidPoint`'s own elbow branch.
		return [arrow.x + (a[0] + b[0]) / 2, arrow.y + (a[1] + b[1]) / 2];
	}

	if (!arrow.roundness) {
		const a = toGlobal(points[opIndex - 1][0], points[opIndex - 1][1]);
		const b = toGlobal(points[opIndex][0], points[opIndex][1]);
		return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
	}

	// Rounded corners: the drawn segment is a rough.js curve through the LOCAL
	// (unrotated) points -- rotation is applied to the generated control points
	// afterward, exactly matching `generateLinearCollisionShape`'s own order.
	const generator = new RoughGenerator();
	const localPoints = points.map((p) => [p[0], p[1]] as [number, number]);
	const drawable = generator.curve(localPoints, collisionCurveOptions(arrow.seed));
	const ops = drawable.sets[0].ops.slice(0, points.length) as RoughOp[];
	const segment = curveSegmentAt(ops, opIndex, toGlobal);
	if (!segment) return null;
	return curveMidpoint(segment);
}

/**
 * Where an arrow-bound label's top-left corner belongs, in absolute scene
 * coordinates -- `null` when the arrow doesn't have enough geometry to place
 * it (the caller should skip painting the label for that frame rather than
 * fall back to its stale stored `x`/`y`).
 */
export function computeArrowLabelPosition(
	arrow: FrontOfEmbedElement,
	bounds: AbsoluteBounds,
	label: { width: number; height: number },
): { x: number; y: number } | null {
	const mid = arrowMidpoint(arrow, bounds);
	if (!mid) return null;
	return { x: mid[0] - label.width / 2, y: mid[1] - label.height / 2 };
}
