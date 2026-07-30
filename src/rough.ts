/**
 * The hand-drawn path rough.js actually draws an Excalidraw shape along.
 *
 * Ported from rough.js (MIT, Preet Shihn -- https://github.com/rough-stuff/rough),
 * which Excalidraw calls to render every non-freedraw shape. Vendored for the
 * same reason as freehand.ts: front-of-embed masking copies Excalidraw's own
 * pixels, so the mask has to sit exactly where the stroke is. Before this, the
 * jitter was covered by widening the mask by a fixed allowance per unit of
 * roughness, and that allowance is scene background everywhere the stroke did
 * not happen to wander.
 *
 * The delicate part is not the formulas but the *order* of the random draws.
 * rough.js seeds a single LCG per shape and every offset consumes the next value
 * from it, so a port that computes the right numbers in the wrong sequence
 * produces a completely different -- and visibly wrong -- hand-drawn path. Each
 * routine here has been checked against Excalidraw's own output rather than
 * against the upstream source, by exporting a live element through
 * `ExcalidrawLib.exportToSvg` and comparing control points (2026-07-30):
 *
 * - `line`: a 2-point arrow, seed 1306010265, reproduced its shaft exactly --
 *   `C214.28 152.34, 428.47 306.99, 754.89 544.38`
 * - `curve`: a 13-point curved line, seed 599141599, reproduced both passes
 *   exactly, including the second pass running on a fresh `seed + 1` generator
 *
 * Deliberately dependency-free and pure, like freehand.ts and pack-elements.ts.
 */

/** One drawing operation, in element-local coordinates. */
export type RoughOp =
	| { op: "move"; data: readonly [number, number] }
	| { op: "bcurveTo"; data: readonly [number, number, number, number, number, number] };

export interface RoughOptions {
	seed: number;
	roughness: number;
	/** rough.js's `maxRandomnessOffset` default. */
	maxRandomnessOffset: number;
	bowing: number;
	curveTightness: number;
	/** True for a non-solid stroke, which Excalidraw draws as one pass rather than two. */
	disableMultiStroke: boolean;
	/** Pins a path's endpoints, which Excalidraw sets for continuous paths such as arrow shafts. */
	preserveVertices: boolean;
}

/** rough.js's own defaults for everything Excalidraw does not override. */
export const ROUGH_DEFAULTS = {
	maxRandomnessOffset: 2,
	bowing: 1,
	curveTightness: 0,
} as const;

/**
 * rough.js's seeded generator: a Lehmer LCG. Deterministic given the element's
 * `seed`, which is what makes the drawn jitter reproducible at all -- and
 * stateful, which is why call order matters.
 */
function makeRandom(seed: number): () => number {
	let state = seed;
	return () => {
		if (!state) return 0;
		state = Math.imul(48271, state);
		return ((2 ** 31 - 1) & state) / 2 ** 31;
	};
}

interface Sampler {
	next(): number;
	/** rough.js's `_offsetOpt`: a symmetric random offset, scaled by roughness. */
	offset(magnitude: number, roughnessGain?: number): number;
}

function makeSampler(options: RoughOptions, seed: number): Sampler {
	const next = makeRandom(seed);
	return {
		next,
		offset(magnitude, roughnessGain = 1) {
			return options.roughness * roughnessGain * (next() * 2 * magnitude - magnitude);
		},
	};
}

/**
 * rough.js tapers its jitter on longer lines, so a long stroke doesn't wander
 * proportionally as far as a short one.
 */
function roughnessGainFor(length: number): number {
	if (length < 200) return 1;
	if (length > 500) return 0.4;
	return -0.0016668 * length + 1.233334;
}

/**
 * One pass of a hand-drawn line, as a single cubic. `overlay` is rough's second
 * pass, which uses half the offset so the two strokes read as one slightly
 * furry line rather than two separate ones.
 */
function linePass(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	options: RoughOptions,
	sampler: Sampler,
	move: boolean,
	overlay: boolean,
): RoughOp[] {
	const lengthSq = (x1 - x2) ** 2 + (y1 - y2) ** 2;
	const length = Math.sqrt(lengthSq);
	const gain = roughnessGainFor(length);

	let offset = options.maxRandomnessOffset;
	// A short line would be swamped by the full offset, so it's capped.
	if (offset * offset * 100 > lengthSq) offset = length / 10;
	const halfOffset = offset / 2;

	// Consumed before the displacements: the order of these three draws is part
	// of the algorithm, not an implementation detail.
	const divergePoint = 0.2 + sampler.next() * 0.2;
	const midDispX = sampler.offset((options.bowing * options.maxRandomnessOffset * (y2 - y1)) / 200, gain);
	const midDispY = sampler.offset((options.bowing * options.maxRandomnessOffset * (x1 - x2)) / 200, gain);

	const jitter = () => sampler.offset(overlay ? halfOffset : offset, gain);
	const pinned = options.preserveVertices;
	const ops: RoughOp[] = [];

	if (move) {
		const start = overlay ? halfOffset : offset;
		ops.push({
			op: "move",
			data: [
				x1 + (pinned ? 0 : sampler.offset(start, gain)),
				y1 + (pinned ? 0 : sampler.offset(start, gain)),
			],
		});
	}
	ops.push({
		op: "bcurveTo",
		data: [
			midDispX + x1 + (x2 - x1) * divergePoint + jitter(),
			midDispY + y1 + (y2 - y1) * divergePoint + jitter(),
			midDispX + x1 + 2 * (x2 - x1) * divergePoint + jitter(),
			midDispY + y1 + 2 * (y2 - y1) * divergePoint + jitter(),
			x2 + (pinned ? 0 : jitter()),
			y2 + (pinned ? 0 : jitter()),
		],
	});
	return ops;
}

/** A hand-drawn line: two passes unless the stroke style disabled the second. */
function doubleLine(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	options: RoughOptions,
	sampler: Sampler,
): RoughOp[] {
	const first = linePass(x1, y1, x2, y2, options, sampler, true, false);
	if (options.disableMultiStroke) return first;
	// Note the second pass continues the *same* generator -- unlike `curve`,
	// which restarts on a fresh seed.
	return first.concat(linePass(x1, y1, x2, y2, options, sampler, true, true));
}

/** rough.js's `_curve`: a Catmull-Rom spline through the (already jittered) points. */
function curvePass(points: readonly (readonly [number, number])[], options: RoughOptions): RoughOp[] {
	const ops: RoughOp[] = [];
	if (points.length <= 3) return ops;
	const s = 1 - options.curveTightness;
	const first = points[1];
	if (!first) return ops;
	ops.push({ op: "move", data: [first[0], first[1]] });
	for (let i = 1; i + 2 < points.length; i++) {
		const previous = points[i - 1];
		const from = points[i];
		const to = points[i + 1];
		const next = points[i + 2];
		if (!previous || !from || !to || !next) continue;
		ops.push({
			op: "bcurveTo",
			data: [
				from[0] + (s * to[0] - s * previous[0]) / 6,
				from[1] + (s * to[1] - s * previous[1]) / 6,
				to[0] + (s * from[0] - s * next[0]) / 6,
				to[1] + (s * from[1] - s * next[1]) / 6,
				to[0],
				to[1],
			],
		});
	}
	return ops;
}

/** Jitters every point, duplicating the first and last so the spline reaches them. */
function curveWithOffset(
	points: readonly (readonly number[])[],
	magnitude: number,
	sampler: Sampler,
	options: RoughOptions,
): RoughOp[] {
	const first = points[0];
	if (!first) return [];
	const jittered: [number, number][] = [];
	const push = (point: readonly number[]) =>
		jittered.push([(point[0] ?? 0) + sampler.offset(magnitude), (point[1] ?? 0) + sampler.offset(magnitude)]);
	push(first);
	push(first);
	for (let i = 1; i < points.length; i++) {
		const point = points[i];
		if (!point) continue;
		push(point);
		if (i === points.length - 1) push(point);
	}
	return curvePass(jittered, options);
}

/** A hand-drawn curve through the given points -- Excalidraw's curved lines and arrows. */
export function roughCurve(points: readonly (readonly number[])[], options: RoughOptions): RoughOp[] {
	const sampler = makeSampler(options, options.seed);
	const ops = curveWithOffset(points, 1 * (1 + options.roughness * 0.2), sampler, options);
	if (options.disableMultiStroke) return ops;
	// rough.js's `cloneOptionsAlterSeed`: the second pass runs on a fresh
	// generator seeded one higher, not on the continuation of the first.
	const second = makeSampler(options, options.seed + 1);
	return ops.concat(curveWithOffset(points, 1.5 * (1 + options.roughness * 0.22), second, options));
}

/** A hand-drawn polyline, optionally closed -- Excalidraw's straight lines, arrows, and diamonds. */
export function roughLinearPath(
	points: readonly (readonly number[])[],
	close: boolean,
	options: RoughOptions,
): RoughOp[] {
	const sampler = makeSampler(options, options.seed);
	return linearPathWith(points, close, options, sampler);
}

function linearPathWith(
	points: readonly (readonly number[])[],
	close: boolean,
	options: RoughOptions,
	sampler: Sampler,
): RoughOp[] {
	if (points.length < 2) return [];
	let ops: RoughOp[] = [];
	if (points.length === 2) {
		const [a, b] = points;
		if (!a || !b) return [];
		return doubleLine(a[0] ?? 0, a[1] ?? 0, b[0] ?? 0, b[1] ?? 0, options, sampler);
	}
	for (let i = 0; i < points.length - 1; i++) {
		const from = points[i];
		const to = points[i + 1];
		if (!from || !to) continue;
		ops = ops.concat(doubleLine(from[0] ?? 0, from[1] ?? 0, to[0] ?? 0, to[1] ?? 0, options, sampler));
	}
	if (close) {
		const last = points[points.length - 1];
		const first = points[0];
		if (last && first) {
			ops = ops.concat(doubleLine(last[0] ?? 0, last[1] ?? 0, first[0] ?? 0, first[1] ?? 0, options, sampler));
		}
	}
	return ops;
}

/** A hand-drawn rectangle -- rough.js draws one as a closed four-point polygon. */
export function roughRectangle(width: number, height: number, options: RoughOptions): RoughOp[] {
	return roughLinearPath(
		[
			[0, 0],
			[width, 0],
			[width, height],
			[0, height],
		],
		true,
		options,
	);
}

/** Builds the options Excalidraw hands rough.js for a given element. */
export function roughOptionsFor(element: {
	seed?: number;
	roughness?: number;
	strokeStyle?: string;
}, preserveVertices = false): RoughOptions {
	return {
		...ROUGH_DEFAULTS,
		seed: element.seed ?? 1,
		roughness: element.roughness ?? 1,
		disableMultiStroke: !!element.strokeStyle && element.strokeStyle !== "solid",
		preserveVertices,
	};
}
