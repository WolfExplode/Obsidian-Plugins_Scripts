/**
 * The stroke outline Excalidraw draws a freedraw element as.
 *
 * Ported from perfect-freehand (MIT, Steve Ruiz --
 * https://github.com/steveruizok/perfect-freehand), which is what Excalidraw
 * itself calls. Vendored rather than depended on because this plugin has to
 * reproduce the geometry exactly, not approximately: front-of-embed rendering
 * masks Excalidraw's own rendered pixels, and a mask built from anything other
 * than the real outline both clips the stroke and paints scene background over
 * the embeddable where the stroke isn't.
 *
 * Why an outline at all: a freedraw is not a stroked polyline. Excalidraw hands
 * the raw points to `getStroke`, which streamlines them and returns a closed
 * polygon *around* the stroke whose width varies with pressure, then fills that
 * polygon as chained quadratic curves. Verified live (2026-07-30) by exporting a
 * freedraw through `ExcalidrawLib.exportToSvg`: a single `<path>` with
 * `fill="#f08c00"`, no stroke at all.
 *
 * Deliberately dependency-free and pure, like front-of-embed.ts and
 * pack-elements.ts, so it can be unit-tested on its own.
 */

type Point = readonly [number, number];

/** An input point: x, y, and optionally pressure. */
export type FreehandInputPoint = readonly number[];

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Point, scalar: number): Point => [a[0] * scalar, a[1] * scalar];
/** Perpendicular. */
const per = (a: Point): Point => [a[1], -a[0]];
const dpr = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1];
const dist = (a: Point, b: Point): number => Math.hypot(a[1] - b[1], a[0] - b[0]);
const dist2 = (a: Point, b: Point): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const len = (a: Point): number => Math.hypot(a[0], a[1]);
const uni = (a: Point): Point => {
	const length = len(a);
	return length === 0 ? [0, 0] : [a[0] / length, a[1] / length];
};
const lrp = (a: Point, b: Point, t: number): Point => add(a, mul(sub(b, a), t));
const prj = (a: Point, b: Point, c: number): Point => add(a, mul(b, c));
const rotAround = (a: Point, centre: Point, radians: number): Point => {
	const s = Math.sin(radians);
	const c = Math.cos(radians);
	const px = a[0] - centre[0];
	const py = a[1] - centre[1];
	return [px * c - py * s + centre[0], px * s + py * c + centre[1]];
};

/** How fast simulated pressure ramps up. perfect-freehand's `RATE_OF_PRESSURE_CHANGE`. */
const RATE_OF_PRESSURE_CHANGE = 0.275;

/** Nudged past PI so a half-turn's start and end points never land on each other. */
const FIXED_PI = Math.PI + 0.0001;

export interface FreehandOptions {
	/** Stroke diameter at full pressure. Excalidraw passes `strokeWidth * 4.25`. */
	size: number;
	/** How much pressure narrows the stroke. */
	thinning: number;
	/** How far apart outline points may be before one is dropped. */
	smoothing: number;
	/** How hard the input points are filtered toward each other. */
	streamline: number;
	/** Maps pressure to radius. */
	easing: (t: number) => number;
	/** Whether the stroke is finished, which pins the final point exactly. */
	last: boolean;
	/** Whether to derive pressure from speed rather than read it from the input. */
	simulatePressure: boolean;
}

/**
 * Excalidraw's own freedraw options (packages/element/src/renderElement.ts).
 * `size` is filled in per element from its `strokeWidth`.
 */
export const EXCALIDRAW_FREEHAND_OPTIONS: Omit<FreehandOptions, "size" | "last" | "simulatePressure"> = {
	thinning: 0.6,
	smoothing: 0.5,
	streamline: 0.5,
	easing: (t) => Math.sin((t * Math.PI) / 2),
};

/** Excalidraw's multiplier from an element's nominal `strokeWidth` to perfect-freehand's `size`. */
export const FREEHAND_SIZE_FACTOR = 4.25;

interface StrokePoint {
	point: Point;
	pressure: number;
	vector: Point;
	distance: number;
	runningLength: number;
}

/**
 * Streamlines the raw input points -- each one is pulled a fraction of the way
 * toward the next rather than used as-is, which is what removes pointer noise
 * and rounds off corners. This is the step that makes the drawn centerline
 * differ from the recorded points, and masking the recorded points instead was
 * what put the mask beside the stroke rather than on it.
 */
export function getStrokePoints(rawPoints: readonly FreehandInputPoint[], options: FreehandOptions): StrokePoint[] {
	const { streamline, size, last: isComplete } = options;
	if (rawPoints.length === 0) return [];

	const t = 0.15 + (1 - streamline) * 0.85;
	let points: FreehandInputPoint[] = rawPoints.map((point) => [point[0] ?? 0, point[1] ?? 0, point[2] ?? -1]);

	// Two points get padded out, so a tapered stroke doesn't render as a dash.
	if (points.length === 2) {
		const last = points[1] as FreehandInputPoint;
		const first = points[0] as FreehandInputPoint;
		points = [first];
		for (let i = 1; i < 5; i++) {
			points.push([...lrp([first[0] ?? 0, first[1] ?? 0], [last[0] ?? 0, last[1] ?? 0], i / 4), last[2] ?? -1]);
		}
	}
	if (points.length === 1) {
		const only = points[0] as FreehandInputPoint;
		points = [only, [(only[0] ?? 0) + 1, (only[1] ?? 0) + 1, only[2] ?? -1]];
	}

	const first = points[0] as FreehandInputPoint;
	const strokePoints: StrokePoint[] = [
		{
			point: [first[0] ?? 0, first[1] ?? 0],
			pressure: (first[2] ?? -1) >= 0 ? (first[2] as number) : 0.25,
			vector: [1, 1],
			distance: 0,
			runningLength: 0,
		},
	];

	let hasReachedMinimumLength = false;
	let runningLength = 0;
	let prev = strokePoints[0] as StrokePoint;
	const max = points.length - 1;

	for (let i = 1; i < points.length; i++) {
		const raw = points[i] as FreehandInputPoint;
		const target: Point = [raw[0] ?? 0, raw[1] ?? 0];
		// The final point of a finished stroke is pinned, so the stroke ends where
		// the pen actually lifted rather than short of it.
		const point = isComplete && i === max ? target : lrp(prev.point, target, t);
		if (prev.point[0] === point[0] && prev.point[1] === point[1]) continue;

		const distance = dist(point, prev.point);
		runningLength += distance;

		// The very start of a stroke is noisy, so it's ignored until the pen has
		// travelled at least one stroke width.
		if (i < max && !hasReachedMinimumLength) {
			if (runningLength < size) continue;
			hasReachedMinimumLength = true;
		}

		prev = {
			point,
			pressure: (raw[2] ?? -1) >= 0 ? (raw[2] as number) : 0.5,
			vector: uni(sub(prev.point, point)),
			distance,
			runningLength,
		};
		strokePoints.push(prev);
	}

	const second = strokePoints[1];
	if (strokePoints[0]) strokePoints[0].vector = second ? second.vector : [0, 0];
	return strokePoints;
}

function strokeRadius(size: number, thinning: number, pressure: number, easing: (t: number) => number): number {
	return size * easing(0.5 - thinning * (0.5 - pressure));
}

/**
 * Walks the streamlined points and returns the closed polygon around the stroke:
 * down the left side, around the end cap, back up the right side, and around the
 * start cap. The radius at each step comes from pressure, so the polygon is
 * narrower where the stroke tapers -- which a constant-width mask cannot follow.
 */
export function getStrokeOutlinePoints(points: readonly StrokePoint[], options: FreehandOptions): Point[] {
	const { size, smoothing, thinning, simulatePressure, easing, last: isComplete } = options;
	if (points.length === 0 || size <= 0) return [];

	const lastStrokePoint = points[points.length - 1] as StrokePoint;
	const totalLength = lastStrokePoint.runningLength;
	const minDistance = (size * smoothing) ** 2;

	const leftPts: Point[] = [];
	const rightPts: Point[] = [];

	// Seeded from the first several points rather than the first alone: strokes
	// almost always start slow, and a cold start renders as a fat blob.
	let prevPressure = points.slice(0, 10).reduce((acc, curr) => {
		let pressure = curr.pressure;
		if (simulatePressure) {
			const speed = Math.min(1, curr.distance / size);
			const rate = Math.min(1, 1 - speed);
			pressure = Math.min(1, acc + (rate - acc) * (speed * RATE_OF_PRESSURE_CHANGE));
		}
		return (acc + pressure) / 2;
	}, (points[0] as StrokePoint).pressure);

	let radius = strokeRadius(size, thinning, lastStrokePoint.pressure, easing);
	let firstRadius: number | undefined;
	let prevVector = (points[0] as StrokePoint).vector;
	let pl = (points[0] as StrokePoint).point;
	let pr = pl;
	let tl = pl;
	let tr = pr;
	let isPrevPointSharpCorner = false;

	for (let i = 0; i < points.length; i++) {
		const current = points[i] as StrokePoint;
		let { pressure } = current;
		const { point, vector, distance, runningLength } = current;

		// Trailing noise as the pen lifts.
		if (i < points.length - 1 && totalLength - runningLength < 3) continue;

		if (thinning) {
			if (simulatePressure) {
				const speed = Math.min(1, distance / size);
				const rate = Math.min(1, 1 - speed);
				pressure = Math.min(1, prevPressure + (rate - prevPressure) * (speed * RATE_OF_PRESSURE_CHANGE));
			}
			radius = strokeRadius(size, thinning, pressure, easing);
		} else {
			radius = size / 2;
		}
		if (firstRadius === undefined) firstRadius = radius;

		radius = Math.max(0.01, radius);

		const nextVector = (i < points.length - 1 ? (points[i + 1] as StrokePoint) : current).vector;
		const nextDpr = i < points.length - 1 ? dpr(vector, nextVector) : 1;
		const prevDpr = dpr(vector, prevVector);
		const isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
		const isNextPointSharpCorner = nextDpr < 0;

		if (isPointSharpCorner || isNextPointSharpCorner) {
			// A reversal sharp enough that offsetting would self-intersect: cap it
			// with a half turn on each side instead.
			const offset = mul(per(prevVector), radius);
			for (let step = 1 / 13, t = 0; t <= 1; t += step) {
				tl = rotAround(sub(point, offset), point, FIXED_PI * t);
				leftPts.push(tl);
				tr = rotAround(add(point, offset), point, FIXED_PI * -t);
				rightPts.push(tr);
			}
			pl = tl;
			pr = tr;
			if (isNextPointSharpCorner) isPrevPointSharpCorner = true;
			continue;
		}

		isPrevPointSharpCorner = false;

		if (i === points.length - 1) {
			const offset = mul(per(vector), radius);
			leftPts.push(sub(point, offset));
			rightPts.push(add(point, offset));
			continue;
		}

		const offset = mul(per(lrp(nextVector, vector, nextDpr)), radius);

		tl = sub(point, offset);
		if (i <= 1 || dist2(pl, tl) > minDistance) {
			leftPts.push(tl);
			pl = tl;
		}

		tr = add(point, offset);
		if (i <= 1 || dist2(pr, tr) > minDistance) {
			rightPts.push(tr);
			pr = tr;
		}

		prevPressure = pressure;
		prevVector = vector;
	}

	const firstPoint = (points[0] as StrokePoint).point;
	const lastPoint = points.length > 1 ? lastStrokePoint.point : add(firstPoint, [1, 1]);
	const startCap: Point[] = [];
	const endCap: Point[] = [];

	if (points.length === 1) {
		// A single point is a dot: a full turn around the first point.
		const start = prj(firstPoint, uni(per(sub(firstPoint, lastPoint))), -(firstRadius ?? radius));
		const dotPts: Point[] = [];
		for (let step = 1 / 13, t = step; t <= 1; t += step) {
			dotPts.push(rotAround(start, firstPoint, FIXED_PI * 2 * t));
		}
		return dotPts;
	}

	const firstRight = rightPts[0];
	if (firstRight) {
		for (let step = 1 / 13, t = step; t <= 1; t += step) {
			startCap.push(rotAround(firstRight, firstPoint, FIXED_PI * t));
		}
	}

	const direction = per(mul(lastStrokePoint.vector, -1));
	const start = prj(lastPoint, direction, radius);
	for (let step = 1 / 29, t = step; t < 1; t += step) {
		endCap.push(rotAround(start, lastPoint, FIXED_PI * 3 * t));
	}

	// Left side, around the end, back up the right side, around the start.
	return leftPts.concat(endCap, rightPts.reverse(), startCap);
}

/** The closed outline polygon Excalidraw fills for a freedraw stroke. */
export function getStroke(points: readonly FreehandInputPoint[], options: FreehandOptions): Point[] {
	return getStrokeOutlinePoints(getStrokePoints(points, options), options);
}

/**
 * The per-element pen settings Excalidraw stores on a freedraw. These are the
 * element's own record of how it was drawn, and reading them is what makes the
 * mask match: a stroke drawn with constant pressure is a constant width, and
 * modelling it as pressure-variable puts the mask beside the stroke rather than
 * on it.
 */
export interface FreehandStrokeOptions {
	/** `"constant"` pins the pressure; `"variable"` (or absent) varies it along the stroke. */
	variability?: string;
	/** How hard the input points are filtered toward each other, overriding the default. */
	streamline?: number;
}

interface FreehandElement {
	strokeWidth?: number;
	simulatePressure?: boolean;
	lastCommittedPoint?: unknown;
	points?: readonly (readonly number[])[];
	pressures?: readonly number[];
	strokeOptions?: FreehandStrokeOptions | null;
}

/**
 * The pressure a constant-variability stroke is drawn at.
 *
 * Empirical, not read from Excalidraw's source: perfect-freehand is not in the
 * Obsidian Excalidraw plugin's bundle, so this was fitted against
 * `exportToSvg`'s own output for a live constant-variability stroke
 * (2026-07-30). Pinning pressure here reproduces it to a mean of 0.43 scene
 * units, against 0.012 for the variable case, which the port matches exactly.
 * See the known limitation in docs/behavior/front-of-embed-rendering.md.
 */
export const CONSTANT_VARIABILITY_PRESSURE = 0;

function isConstantVariability(element: FreehandElement): boolean {
	return element.strokeOptions?.variability === "constant";
}

/**
 * The options Excalidraw draws a given freedraw element with, taken from the
 * element's own `strokeOptions` rather than assumed. `last` pins the final point
 * once the stroke has been committed.
 */
export function freehandOptionsFor(element: FreehandElement): FreehandOptions {
	const constant = isConstantVariability(element);
	return {
		...EXCALIDRAW_FREEHAND_OPTIONS,
		streamline: element.strokeOptions?.streamline ?? EXCALIDRAW_FREEHAND_OPTIONS.streamline,
		size: (element.strokeWidth ?? 1) * FREEHAND_SIZE_FACTOR,
		// A pinned pressure must not then be re-derived from pen speed.
		simulatePressure: constant ? false : element.simulatePressure !== false,
		last: !!element.lastCommittedPoint,
	};
}

/** Interleaves an element's pressures into its points, the way Excalidraw feeds them in. */
export function freehandInputPoints(element: FreehandElement): FreehandInputPoint[] {
	const points = element.points ?? [];
	if (isConstantVariability(element)) {
		return points.map((point) => [point[0] ?? 0, point[1] ?? 0, CONSTANT_VARIABILITY_PRESSURE]);
	}
	const pressures = element.pressures;
	if (element.simulatePressure !== false || !pressures?.length) {
		return points.map((point) => [point[0] ?? 0, point[1] ?? 0]);
	}
	return points.map((point, index) => [point[0] ?? 0, point[1] ?? 0, pressures[index] ?? 0.5]);
}
