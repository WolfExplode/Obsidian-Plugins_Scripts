/**
 * The geometry Excalidraw itself emits for an element, via `exportToSvg`, whose
 * `<path>` data drops straight into a `Path2D`. This is where a drawn
 * candidate's shape, colour, stroke width and dash pattern all come from -- see
 * docs/behavior/front-of-embed-rendering.md.
 *
 * `exportToSvg` is async, and there is no synchronous per-element geometry API
 * anywhere on `ExcalidrawLib`, so this is necessarily a cache. What keeps that
 * cheap is the key: it is the element's *geometry*, not its `version`, so
 * moving, rotating, re-ordering an element or changing its opacity leaves the
 * key untouched and re-exports nothing. Only drawing, resizing and recolouring
 * invalidate it -- and where a drag fires a scene change on every pointer move,
 * a recolour fires once, on commit.
 *
 * Path coordinates come out element-local already (verified 2026-07-30: a
 * rectangle exports as `M32 0 ...`), so the `<g>` transform is SVG layout only
 * and is deliberately ignored.
 */

/** One `<path>` from Excalidraw's own export, in element-local coordinates. */
export interface EmittedPath {
	d: string;
	/** Whether Excalidraw fills this path -- its fill paths and its stroke paths are separate. */
	filled: boolean;
	/**
	 * The colour Excalidraw fills this path with, when it fills it. Taken from the
	 * export rather than from the element because the mapping is not one-to-one: a
	 * hachure fill is emitted as *stroked* paths in the background colour, so
	 * "stroked path means `strokeColor`" would paint hachuring the wrong colour.
	 */
	fill: string | null;
	/** Set when Excalidraw strokes this path, at the width it strokes it. */
	strokeWidth: number | null;
	/** The colour Excalidraw strokes this path with. Same reasoning as `fill`. */
	stroke: string | null;
	dash: readonly number[] | null;
}

/**
 * The minimal Excalidraw element shape this reads. Fields beyond these are read
 * by name off the record, so it is deliberately loose rather than tied to
 * `FrontOfEmbedElement`.
 */
export interface GeometryElement {
	id: string;
	type: string;
	width: number;
	height: number;
}

function field(element: GeometryElement, name: string): unknown {
	return (element as unknown as Record<string, unknown>)[name];
}

/**
 * The element fields that change what Excalidraw *draws*, as opposed to where it
 * puts it. Deliberately excludes `x`, `y`, `angle` and `version`: a drag would
 * otherwise re-export on every frame, which is the cost that would sink this
 * approach.
 *
 * Colours *are* included, because the emitted paths carry the colours they are
 * painted in -- see `EmittedPath.fill`. That makes a recolour a re-export, which
 * a drag is not: it fires once per commit rather than once per pointer move.
 * `opacity` is deliberately still excluded; the view layer applies it live from
 * the element, so dragging the opacity slider re-exports nothing.
 */
const GEOMETRY_FIELDS = [
	"type",
	"width",
	"height",
	"points",
	"pressures",
	"simulatePressure",
	"lastCommittedPoint",
	"strokeOptions",
	"strokeWidth",
	"strokeStyle",
	"roughness",
	"roundness",
	"seed",
	"fillStyle",
	"strokeColor",
	"backgroundColor",
] as const;

export function geometrySignature(element: GeometryElement): string {
	const parts: unknown[] = [];
	for (const name of GEOMETRY_FIELDS) parts.push(field(element, name) ?? null);
	return JSON.stringify(parts);
}

/** The `exportToSvg` shape this needs from `window.ExcalidrawLib`. */
export interface SvgExporter {
	exportToSvg(opts: {
		elements: readonly unknown[];
		appState: Record<string, unknown>;
		files: unknown;
	}): Promise<SVGSVGElement>;
}

function parseDash(value: string | null): readonly number[] | null {
	if (!value) return null;
	const numbers = value
		.split(/[\s,]+/)
		.map(Number)
		.filter((n) => Number.isFinite(n));
	return numbers.length ? numbers : null;
}

/**
 * Asks Excalidraw to draw this one element and returns the paths it emitted.
 * The element is flattened to the origin with no rotation so the result is
 * reusable under the overlay's own transform.
 */
export async function fetchEmittedGeometry(
	exporter: SvgExporter,
	element: GeometryElement,
): Promise<EmittedPath[]> {
	const flattened = { ...element, x: 0, y: 0, angle: 0 };
	const svg = await exporter.exportToSvg({
		elements: [flattened],
		appState: { exportBackground: false, exportPadding: 0 },
		files: null,
	});
	const paths: EmittedPath[] = [];
	for (const node of Array.from(svg.querySelectorAll("path"))) {
		const d = node.getAttribute("d");
		if (!d) continue;
		const fill = node.getAttribute("fill");
		const stroke = node.getAttribute("stroke");
		const width = Number(node.getAttribute("stroke-width"));
		const strokes = !!stroke && stroke !== "none" && Number.isFinite(width);
		paths.push({
			d,
			filled: !!fill && fill !== "none",
			fill: fill && fill !== "none" ? fill : null,
			strokeWidth: strokes ? width : null,
			stroke: strokes ? stroke : null,
			dash: parseDash(node.getAttribute("stroke-dasharray")),
		});
	}
	return paths;
}

/**
 * Element types whose mask cannot come from emitted paths: Excalidraw exports
 * text as `<text>` and images as `<image>`, neither of which is path geometry.
 * These keep the existing mask shapes regardless.
 */
const NON_PATH_TYPES = new Set(["text", "image"]);

export function hasEmittablePaths(element: GeometryElement): boolean {
	return !NON_PATH_TYPES.has(element.type);
}
