/**
 * EXPERIMENT -- reading the geometry Excalidraw emits instead of reproducing it.
 *
 * See "Worth revisiting" in docs/behavior/front-of-embed-rendering.md. The ports
 * in rough.ts and freehand.ts reconstruct what Excalidraw draws; this asks
 * Excalidraw for it instead, via `exportToSvg`, whose `<path>` data drops
 * straight into a `Path2D`.
 *
 * The trade is that `exportToSvg` is async -- there is no synchronous
 * per-element geometry API anywhere -- so this can only ever be a cache, and the
 * question the experiment answers is whether the cost of filling that cache is
 * noticeable. Two things keep it viable:
 *
 * - The cache key is the element's *geometry*, not its `version`. Moving,
 *   rotating, re-colouring or re-ordering an element leaves the key untouched,
 *   so no re-export happens; only drawing and resizing change it. That matters
 *   because a scene change fires on every pointer move of a drag.
 * - The ports stay as the synchronous fallback, so a frame with no cache entry
 *   yet still masks correctly rather than flashing.
 *
 * Path coordinates come out element-local already (verified 2026-07-30: a
 * rectangle exports as `M32 0 ...`, matching rough.ts's own element-local
 * output), so the `<g>` transform is SVG layout only and is deliberately
 * ignored.
 */

/** One `<path>` from Excalidraw's own export, in element-local coordinates. */
export interface EmittedPath {
	d: string;
	/** Whether Excalidraw fills this path -- its fill paths and its stroke paths are separate. */
	filled: boolean;
	/** Set when Excalidraw strokes this path, at the width it strokes it. */
	strokeWidth: number | null;
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
 * puts it. Deliberately excludes `x`, `y`, `angle`, `version` and every colour:
 * a drag would otherwise re-export on every frame, which is the cost that would
 * sink this approach.
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
	// Not the colour itself, only whether there is a fill at all -- that changes
	// whether Excalidraw emits a fill path.
] as const;

export function geometrySignature(element: GeometryElement): string {
	const parts: unknown[] = [];
	for (const name of GEOMETRY_FIELDS) parts.push(field(element, name) ?? null);
	const background = field(element, "backgroundColor");
	parts.push(typeof background === "string" && background !== "transparent");
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
		paths.push({
			d,
			filled: !!fill && fill !== "none",
			strokeWidth: stroke && stroke !== "none" && Number.isFinite(width) ? width : null,
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
