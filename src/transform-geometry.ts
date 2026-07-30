export interface TransformBoundsElement {
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	angle: number;
	points?: readonly (readonly [number, number])[];
}

export type TransformBounds = [x1: number, y1: number, x2: number, y2: number];

interface Point {
	x: number;
	y: number;
}

function rotate(point: Point, pivot: Point, radians: number): Point {
	const dx = point.x - pivot.x;
	const dy = point.y - pivot.y;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

function boundsOf(points: readonly Point[]): TransformBounds {
	return [
		Math.min(...points.map((point) => point.x)),
		Math.min(...points.map((point) => point.y)),
		Math.max(...points.map((point) => point.x)),
		Math.max(...points.map((point) => point.y)),
	];
}

/** Rotation-aware visual bounds used by the transient native-transform proxy. */
export function transformElementBounds(element: TransformBoundsElement): TransformBounds {
	if (
		element.points?.length &&
		(element.type === "line" || element.type === "arrow" || element.type === "freedraw")
	) {
		// Linear/free-draw x/y is the local point origin, not necessarily the
		// visual top-left. Reversed arrows and drawn paths commonly contain
		// negative local points, so x + width/y + height produces a mirrored box.
		const scenePoints = element.points.map(([x, y]) => ({ x: element.x + x, y: element.y + y }));
		const [x1, y1, x2, y2] = boundsOf(scenePoints);
		const center = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
		return boundsOf(scenePoints.map((point) => rotate(point, center, element.angle)));
	}

	const cx = element.x + element.width / 2;
	const cy = element.y + element.height / 2;
	if (element.type === "ellipse") {
		const halfW = element.width / 2;
		const halfH = element.height / 2;
		const extentX = Math.hypot(halfW * Math.cos(element.angle), halfH * Math.sin(element.angle));
		const extentY = Math.hypot(halfH * Math.cos(element.angle), halfW * Math.sin(element.angle));
		return [cx - extentX, cy - extentY, cx + extentX, cy + extentY];
	}
	const points: Point[] = element.type === "diamond"
		? [{ x: cx, y: element.y }, { x: element.x + element.width, y: cy }, { x: cx, y: element.y + element.height }, { x: element.x, y: cy }]
		: [{ x: element.x, y: element.y }, { x: element.x + element.width, y: element.y }, { x: element.x + element.width, y: element.y + element.height }, { x: element.x, y: element.y + element.height }];
	return boundsOf(points.map((point) => rotate(point, { x: cx, y: cy }, element.angle)));
}

export function commonTransformBounds(elements: readonly TransformBoundsElement[]): TransformBounds {
	const bounds = elements.map(transformElementBounds);
	return [
		Math.min(...bounds.map((box) => box[0])),
		Math.min(...bounds.map((box) => box[1])),
		Math.max(...bounds.map((box) => box[2])),
		Math.max(...bounds.map((box) => box[3])),
	];
}
