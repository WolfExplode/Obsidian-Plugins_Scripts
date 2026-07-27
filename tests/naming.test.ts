import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desanitizeAttachmentName, sanitizeAttachmentName } from "../src/popout-drop-bridge";
import { localLinkpath } from "../src/board-render";
import { mirrorViewport } from "../src/excalidraw-view";

/**
 * The sanitize/desanitize pair is load-bearing across module boundaries: the drop
 * bridge renames a dropped file *before* Excalidraw writes it, while
 * media-auto-pack only ever sees the ORIGINAL filename and must still recognise
 * the renamed vault file. If the two ever disagree, imports silently stop being
 * packed — with no error anywhere.
 */
describe("attachment name sanitizing", () => {
	it("replaces every wikilink metacharacter with its full-width look-alike", () => {
		assert.equal(sanitizeAttachmentName("#hash.mp4"), "＃hash.mp4");
		assert.equal(sanitizeAttachmentName("^caret.mp4"), "＾caret.mp4");
		assert.equal(sanitizeAttachmentName("[bracket].mp4"), "［bracket］.mp4");
		assert.equal(sanitizeAttachmentName("pipe|name.mp4"), "pipe｜name.mp4");
	});

	it("handles the documented real-world case", () => {
		assert.equal(sanitizeAttachmentName("#温柔甜美.mp4"), "＃温柔甜美.mp4");
	});

	it("leaves an already-legal name untouched", () => {
		for (const name of ["plain.png", "with space.mp4", "dash-under_score.gif", "dots.in.name.webp", "日本語.png"]) {
			assert.equal(sanitizeAttachmentName(name), name);
		}
	});

	it("round-trips: desanitize undoes sanitize", () => {
		for (const name of [
			"#hash.mp4",
			"^caret.mp4",
			"[bracket].mp4",
			"pipe|name.mp4",
			"#all^the[bad]chars|here.mp4",
			"plain.png",
			"",
		]) {
			assert.equal(desanitizeAttachmentName(sanitizeAttachmentName(name)), name, `round-trip failed for ${name}`);
		}
	});

	it("desanitizing a never-sanitized name is a no-op", () => {
		assert.equal(desanitizeAttachmentName("plain.png"), "plain.png");
	});

	it("converges: the two forms compare equal after desanitizing, which is what media-auto-pack relies on", () => {
		const dropped = "#clip|1.mp4";
		const onDisk = sanitizeAttachmentName(dropped);
		assert.notEqual(onDisk, dropped, "the vault path really does differ");
		assert.equal(desanitizeAttachmentName(onDisk), desanitizeAttachmentName(dropped));
	});
});

describe("localLinkpath", () => {
	it("unwraps a plain wikilink", () => {
		assert.equal(localLinkpath("[[folder/clip.mp4]]"), "folder/clip.mp4");
	});

	it("strips an alias and a heading", () => {
		assert.equal(localLinkpath("[[clip.mp4|My Clip]]"), "clip.mp4");
		assert.equal(localLinkpath("[[note.md#Heading]]"), "note.md");
		assert.equal(localLinkpath("[[note.md|Alias#Heading]]"), "note.md");
	});

	it("accepts a bare path with no wikilink brackets", () => {
		assert.equal(localLinkpath("folder/clip.mp4"), "folder/clip.mp4");
	});

	it("rejects web embeds, which the SVG's own iframe already handles", () => {
		for (const link of ["https://example.com/x", "http://example.com", "app://local/x", "obsidian://open"]) {
			assert.equal(localLinkpath(link), null, `${link} should not resolve to a vault file`);
		}
	});

	it("returns null for empty and missing links", () => {
		assert.equal(localLinkpath(null), null);
		assert.equal(localLinkpath(undefined), null);
		assert.equal(localLinkpath(""), null);
		assert.equal(localLinkpath("   "), null);
	});

	it("keeps the full-width characters the drop bridge introduced", () => {
		// The vault path really contains these, so they must survive resolution.
		assert.equal(localLinkpath("[[＃温柔甜美.mp4]]"), "＃温柔甜美.mp4");
	});
});

/**
 * mirrorViewport seeds a Popout's camera from the main window on first launch.
 * Excalidraw's transform is `viewportPx = (scene + scroll) * zoom`, so matching
 * the CENTRE across two differently-sized windows is what the math must achieve.
 */
describe("mirrorViewport", () => {
	/** The scene coordinate sitting at the centre of a view of this size. */
	const centreOf = (vp: { scrollX: number; scrollY: number; zoom: number }, width: number, height: number) => ({
		x: width / (2 * vp.zoom) - vp.scrollX,
		y: height / (2 * vp.zoom) - vp.scrollY,
	});

	it("keeps the same scene point centred when the target is a different size", () => {
		const source = { scrollX: -100, scrollY: -50, zoom: 1.5, width: 1200, height: 800 };
		const target = mirrorViewport(source, 640, 480);
		const before = centreOf(source, source.width, source.height);
		const after = centreOf(target, 640, 480);
		assert.ok(Math.abs(after.x - before.x) < 1e-9, "centre x preserved");
		assert.ok(Math.abs(after.y - before.y) < 1e-9, "centre y preserved");
	});

	it("preserves zoom", () => {
		assert.equal(mirrorViewport({ scrollX: 0, scrollY: 0, zoom: 2.25, width: 100, height: 100 }, 50, 50).zoom, 2.25);
	});

	it("is an identity when the sizes already match", () => {
		const source = { scrollX: 17, scrollY: -3, zoom: 0.8, width: 900, height: 600 };
		assert.deepEqual(mirrorViewport(source, 900, 600), { scrollX: 17, scrollY: -3, zoom: 0.8 });
	});

	it("treats zoom 0 as 1 rather than dividing by zero", () => {
		const target = mirrorViewport({ scrollX: 0, scrollY: 0, zoom: 0, width: 200, height: 200 }, 100, 100);
		assert.equal(target.zoom, 1);
		assert.ok(Number.isFinite(target.scrollX) && Number.isFinite(target.scrollY));
	});
});
