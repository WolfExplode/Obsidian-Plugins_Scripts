/**
 * Pure geometry for the image-crop features: affine transforms, convex-polygon
 * clipping, and the native-crop planner.
 *
 * Deliberately free of Obsidian/Excalidraw imports — like pack-elements.ts and
 * zorder.ts — so the math can be reasoned about and unit-tested in isolation.
 * excalidraw-view.ts does the API glue (reading the scene, decoding images,
 * generating PNGs, writing back through updateScene).
 *
 * Coordinate spaces used throughout:
 *   - *source/natural pixels*: the decoded bitmap's own pixel grid.
 *   - *element-local*: the element's unrotated box, origin at its top-left.
 *   - *scene*: Excalidraw's world coordinates.
 */

/**
 * Excalidraw's native image crop, stored in the *source image's* natural-pixel
 * space (pre-rotation, pre-flip). The renderer draws the sub-rect
 * `[x, y, width, height]` of the decoded bitmap — whose true size is
 * `naturalWidth × naturalHeight` — onto the element's on-canvas box, so these
 * values MUST be real decoded pixels (renderElement.ts drawImage). The element
 * keeps the full file; double-clicking re-exposes the whole thing.
 */
export interface ImageCrop {
	x: number;
	y: number;
	width: number;
	height: number;
	naturalWidth: number;
	naturalHeight: number;
}

/** An axis-aligned rectangle in scene coordinates. */
export interface SceneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CropPoint {
	x: number;
	y: number;
}

export interface AffineTransform {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
}

/**
 * The structural slice of an Excalidraw image element this module reads. Kept
 * minimal so callers can pass a full scene element (TypeScript is structural)
 * and tests can construct a bare object.
 */
export interface CropImageElement {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Rotation in radians, about the element's centre. */
	angle?: number;
	/** Excalidraw's flip encoding: -1 on an axis mirrors the image on it. */
	scale?: readonly [number, number];
	crop?: ImageCrop | null;
}

/** A crop small enough to be treated as no crop (element back to full image). */
export const CROP_RESET_EPSILON = 1;
/** Ignore a visible sliver thinner than this (scene units) — nothing to show. */
export const MIN_CROP_SCENE = 1;

export function multiplyAffine(left: AffineTransform, right: AffineTransform): AffineTransform {
	return {
		a: left.a * right.a + left.c * right.b,
		b: left.b * right.a + left.d * right.b,
		c: left.a * right.c + left.c * right.d,
		d: left.b * right.c + left.d * right.d,
		e: left.a * right.e + left.c * right.f + left.e,
		f: left.b * right.e + left.d * right.f + left.f,
	};
}

export function applyAffine(transform: AffineTransform, point: CropPoint): CropPoint {
	return {
		x: transform.a * point.x + transform.c * point.y + transform.e,
		y: transform.b * point.x + transform.d * point.y + transform.f,
	};
}

/** Rotates/scales a vector by `transform`'s linear part only — no translation. */
export function rotateVector(transform: AffineTransform, vector: CropPoint): CropPoint {
	return {
		x: transform.a * vector.x + transform.c * vector.y,
		y: transform.b * vector.x + transform.d * vector.y,
	};
}

export function invertAffine(transform: AffineTransform): AffineTransform | null {
	const det = transform.a * transform.d - transform.b * transform.c;
	if (Math.abs(det) < 1e-9) return null;
	const a = transform.d / det;
	const b = -transform.b / det;
	const c = -transform.c / det;
	const d = transform.a / det;
	return {
		a,
		b,
		c,
		d,
		e: -(a * transform.e + c * transform.f),
		f: -(b * transform.e + d * transform.f),
	};
}

/** Maps the image element's local pixels to scene coordinates. */
export function elementLocalToScene(el: CropImageElement): AffineTransform {
	const angle = el.angle ?? 0;
	const center = { x: el.x + el.width / 2, y: el.y + el.height / 2 };
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return {
		a: cos,
		b: sin,
		c: -sin,
		d: cos,
		e: center.x - cos * el.width / 2 + sin * el.height / 2,
		f: center.y - sin * el.width / 2 - cos * el.height / 2,
	};
}

export function sceneRectPolygon(rect: SceneRect): CropPoint[] {
	return [
		{ x: rect.x, y: rect.y },
		{ x: rect.x + rect.width, y: rect.y },
		{ x: rect.x + rect.width, y: rect.y + rect.height },
		{ x: rect.x, y: rect.y + rect.height },
	];
}

/** Sutherland–Hodgman clipping for convex polygons. */
export function intersectConvexPolygons(subject: readonly CropPoint[], clip: readonly CropPoint[]): CropPoint[] {
	let output = [...subject];
	if (output.length < 3 || clip.length < 3) return [];
	const signedArea = clip.reduce((sum, p, i) => {
		const next = clip[(i + 1) % clip.length];
		return sum + p.x * next.y - next.x * p.y;
	}, 0);
	const orientation = signedArea >= 0 ? 1 : -1;
	const inside = (p: CropPoint, a: CropPoint, b: CropPoint) =>
		orientation * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= -1e-7;
	const intersection = (p: CropPoint, q: CropPoint, a: CropPoint, b: CropPoint): CropPoint => {
		const dx = q.x - p.x;
		const dy = q.y - p.y;
		const ex = b.x - a.x;
		const ey = b.y - a.y;
		const denominator = dx * ey - dy * ex;
		if (Math.abs(denominator) < 1e-9) return q;
		const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / denominator;
		return { x: p.x + t * dx, y: p.y + t * dy };
	};
	for (let i = 0; i < clip.length && output.length; i++) {
		const a = clip[i];
		const b = clip[(i + 1) % clip.length];
		const input = output;
		output = [];
		let previous = input[input.length - 1];
		for (const current of input) {
			const currentInside = inside(current, a, b);
			const previousInside = inside(previous, a, b);
			if (currentInside !== previousInside) output.push(intersection(previous, current, a, b));
			if (currentInside) output.push(current);
			previous = current;
		}
	}
	return output;
}

export function pointInsideConvexPolygon(point: CropPoint, polygon: readonly CropPoint[]): boolean {
	if (polygon.length < 3) return false;
	const signedArea = polygon.reduce((sum, p, i) => {
		const next = polygon[(i + 1) % polygon.length];
		return sum + p.x * next.y - next.x * p.y;
	}, 0);
	const orientation = signedArea >= 0 ? 1 : -1;
	return polygon.every((a, i) => {
		const b = polygon[(i + 1) % polygon.length];
		return orientation * ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) >= -1e-6;
	});
}

export function polygonBounds(polygon: readonly CropPoint[]): SceneRect | null {
	if (polygon.length < 3) return null;
	const xs = polygon.map((p) => p.x);
	const ys = polygon.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Maps an image file's natural pixels into its *currently visible* local box. */
export function filePixelsToCurrentLocal(el: CropImageElement, natural: { w: number; h: number }): AffineTransform {
	const crop = el.crop ?? { x: 0, y: 0, width: natural.w, height: natural.h, naturalWidth: natural.w, naturalHeight: natural.h };
	const flipX = el.scale?.[0] === -1;
	const flipY = el.scale?.[1] === -1;
	// Excalidraw stores crop origins from the opposite edge when an image is
	// flipped. Convert that storage convention back to the source pixels that
	// are actually visible, then include the visual mirror in the matrix.
	const visualCropX = flipX ? natural.w - crop.width - crop.x : crop.x;
	const visualCropY = flipY ? natural.h - crop.height - crop.y : crop.y;
	const scaleX = el.width / crop.width;
	const scaleY = el.height / crop.height;
	return {
		a: flipX ? -scaleX : scaleX,
		b: 0,
		c: 0,
		d: flipY ? -scaleY : scaleY,
		e: flipX ? el.width + visualCropX * scaleX : -visualCropX * scaleX,
		f: flipY ? el.height + visualCropY * scaleY : -visualCropY * scaleY,
	};
}

/**
 * Restores the coordinate relationship for a materialized viewport crop.
 *
 * A viewport crop starts as a generated PNG whose local coordinate system is
 * the bounding box of `state.polygon`. Excalidraw can subsequently native-crop,
 * flip, resize, and rotate that PNG. Its native crop is expressed in PNG pixels,
 * whereas the saved polygon/source transform is expressed in the original local
 * units. Compose the two here before applying another viewport crop.
 */
export function viewportCropToCurrentLocal(
	el: CropImageElement,
	state: { polygon: readonly CropPoint[] },
	generatedNatural: { w: number; h: number },
): AffineTransform | null {
	const outputBounds = polygonBounds(state.polygon);
	if (!outputBounds || outputBounds.width <= 0 || outputBounds.height <= 0) return null;
	const localToGeneratedPixels: AffineTransform = {
		a: generatedNatural.w / outputBounds.width,
		b: 0,
		c: 0,
		d: generatedNatural.h / outputBounds.height,
		e: -outputBounds.x * generatedNatural.w / outputBounds.width,
		f: -outputBounds.y * generatedNatural.h / outputBounds.height,
	};
	return multiplyAffine(filePixelsToCurrentLocal(el, generatedNatural), localToGeneratedPixels);
}

export function localPolygonForSceneRect(el: CropImageElement, rect: SceneRect): CropPoint[] | null {
	const inverse = invertAffine(elementLocalToScene(el));
	return inverse ? sceneRectPolygon(rect).map((p) => applyAffine(inverse, p)) : null;
}

/**
 * Computes the new geometry + `crop` for one upright image so its visible region
 * becomes the intersection of its *current visible* rect with `rect` (both in
 * scene coords). Composes with any existing crop and with horizontal/vertical
 * flips (`scale === -1`), which store the crop origin from the opposite edge.
 *
 * Crop only ever *removes*: the result is clamped to what's currently shown, so a
 * rect reaching past the current crop never re-adds already-hidden pixels
 * (Excalidraw's own double-click remains the way to re-expose the full original).
 *
 * Returns null when the rect misses the current visible region, or when the
 * sliver is degenerate. When an *uncropped* image is fully covered the result
 * stays uncropped (crop null) rather than gaining a redundant full crop.
 */
export function planImageCrop(
	el: CropImageElement,
	rect: SceneRect,
	natural: { w: number; h: number },
): { x: number; y: number; width: number; height: number; crop: ImageCrop | null } | null {
	// Rotation is deferred: a screen-aligned rect maps to a rotated quad in image
	// space, which the axis-aligned `crop` rect can't represent. Skip such images.
	if (el.angle && Math.abs(el.angle) > 1e-6) return null;

	const nw = natural.w;
	const nh = natural.h;
	const crop = el.crop ?? null;
	const flipX = el.scale?.[0] === -1;
	const flipY = el.scale?.[1] === -1;

	// On-canvas size of the *uncropped* image at this element's current scale.
	const uncroppedW = crop ? el.width / (crop.width / crop.naturalWidth) : el.width;
	const uncroppedH = crop ? el.height / (crop.height / crop.naturalHeight) : el.height;
	if (uncroppedW <= 0 || uncroppedH <= 0) return null;

	const natPerCanvasX = nw / uncroppedW;
	const natPerCanvasY = nh / uncroppedH;

	// Current visible crop origin as seen on screen (undo the flip storage), in
	// natural px → convert to canvas px to locate the uncropped image's top-left.
	const visualCropX = crop ? (flipX ? nw - crop.width - crop.x : crop.x) : 0;
	const visualCropY = crop ? (flipY ? nh - crop.height - crop.y : crop.y) : 0;
	const uncroppedX = el.x - visualCropX / natPerCanvasX;
	const uncroppedY = el.y - visualCropY / natPerCanvasY;

	// Intersect the drag rect with the CURRENT VISIBLE box (the element's own
	// on-canvas rect), not the uncropped image — so a crop can only shrink the
	// visible region, never re-add pixels an earlier crop removed.
	const vx = Math.max(rect.x, el.x);
	const vy = Math.max(rect.y, el.y);
	const vRight = Math.min(rect.x + rect.width, el.x + el.width);
	const vBottom = Math.min(rect.y + rect.height, el.y + el.height);
	const vw = vRight - vx;
	const vh = vBottom - vy;
	if (vw < MIN_CROP_SCENE || vh < MIN_CROP_SCENE) return null;

	// Visible sub-rect back into natural px (screen/visual space, pre-flip).
	const visW = vw * natPerCanvasX;
	const visH = vh * natPerCanvasY;
	const visX = (vx - uncroppedX) * natPerCanvasX;
	const visY = (vy - uncroppedY) * natPerCanvasY;

	// Full coverage → uncrop.
	if (Math.abs(visX) < CROP_RESET_EPSILON && Math.abs(visY) < CROP_RESET_EPSILON && Math.abs(visW - nw) < CROP_RESET_EPSILON && Math.abs(visH - nh) < CROP_RESET_EPSILON) {
		return { x: vx, y: vy, width: vw, height: vh, crop: null };
	}

	// Re-apply flip storage (crop origin measured from the opposite edge).
	const nextCrop: ImageCrop = {
		x: flipX ? nw - visW - visX : visX,
		y: flipY ? nh - visH - visY : visY,
		width: visW,
		height: visH,
		naturalWidth: nw,
		naturalHeight: nh,
	};
	return { x: vx, y: vy, width: vw, height: vh, crop: nextCrop };
}
