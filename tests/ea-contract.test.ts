import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Contract test against the real ExcalidrawAutomate class, not our own guesses
 * about its shape.
 *
 * WHY THIS EXISTS: our code reaches into another plugin's API surface
 * (window.ExcalidrawAutomate / plugin.ea) through hand-written TypeScript
 * interfaces (ExcalidrawAutomateLike, etc.) that describe what we *assume*
 * that object looks like. TypeScript only checks our code against those
 * assumed interfaces — it has no way to catch an assumption that's simply
 * wrong, because there's no compile-time link to the real upstream class. A
 * method that was invented, renamed, or removed upstream compiles cleanly and
 * fails silently at runtime (most call sites use `?.()`, so a nonexistent
 * method just does nothing instead of throwing). This test closes that gap by
 * grepping the vendored upstream source directly.
 *
 * SOURCE OF TRUTH: reference/obsidian-excalidraw-plugin-master, a local-only
 * checkout documented in AGENTS.md ("Reference material"). It is gitignored,
 * so on a fresh clone (or in CI) it won't exist — every test below skips
 * itself with a pointer to AGENTS.md rather than failing, since its absence
 * says nothing about whether our code is correct.
 *
 * WHAT THIS DOES NOT CATCH: the vendored copy is a point-in-time snapshot,
 * not the live installed plugin — see the existing project lesson that a
 * vendored/declared API surface can lag what's actually shipped. Re-pull
 * reference/obsidian-excalidraw-plugin-master periodically (see AGENTS.md) so
 * this test is checking against something reasonably current, and still
 * exercise the real feature in the live app before trusting this alone.
 */

const testsDir = dirname(fileURLToPath(import.meta.url));
const eaSourcePath = join(
	testsDir,
	"..",
	"reference",
	"obsidian-excalidraw-plugin-master",
	"src",
	"shared",
	"ExcalidrawAutomate.ts",
);

const eaSourceAvailable = existsSync(eaSourcePath);
const eaSource = eaSourceAvailable ? readFileSync(eaSourcePath, "utf8") : "";

/**
 * True if `name` is defined as a method/property on the class in the vendored
 * source — i.e. a real declaration line, not just a string or comment
 * mentioning the name elsewhere in the file (e.g. in a JSDoc example).
 */
function classDeclaresMember(name: string): boolean {
	const pattern = new RegExp(`^[ \\t]*(public |private |protected |static |async )*${name}\\s*\\(`, "m");
	return pattern.test(eaSource);
}

/**
 * Every ExcalidrawAutomate method our plugin calls, and where. When code
 * elsewhere in src/ starts calling a new EA method, add it here — that's what
 * keeps this list an accurate map of our actual cross-plugin surface instead
 * of going stale.
 */
const USED_EA_METHODS = [
	{ name: "getAPI", usedIn: "board-render.ts" },
	{ name: "addElementsToView", usedIn: "media-auto-pack.ts (doc reference — behavioral reasoning, not a call site)" },
	{ name: "getBoundingBox", usedIn: "board-render.ts" },
	{ name: "reset", usedIn: "board-render.ts" },
	{ name: "getExportSettings", usedIn: "board-render.ts" },
	{ name: "createSVG", usedIn: "board-render.ts" },
	{ name: "copyViewElementsToEAforEditing", usedIn: "board-render.ts" },
];

describe("ExcalidrawAutomate contract (vs. vendored upstream source)", () => {
	if (!eaSourceAvailable) {
		it("skipped: reference/obsidian-excalidraw-plugin-master not checked out locally", { skip: true }, () => {});
		return;
	}

	for (const { name, usedIn } of USED_EA_METHODS) {
		it(`ExcalidrawAutomate still declares "${name}" (used in ${usedIn})`, () => {
			assert.ok(
				classDeclaresMember(name),
				`"${name}" was not found as a declared member of the ExcalidrawAutomate class in ` +
					`${eaSourcePath}. Either it was renamed/removed upstream (update our call site) or ` +
					`this list is stale (remove it from USED_EA_METHODS).`,
			);
		});
	}

	it("window.ExcalidrawAutomate really is set to a live ExcalidrawAutomate instance, not a bare factory", () => {
		// Our getExcalidrawAutomate() helpers assume `window.ExcalidrawAutomate.getAPI(view)`
		// is callable directly on the global. Confirm the upstream init function still
		// assigns the actual instance (which has getAPI on its prototype) to that global,
		// not some wrapper object.
		const initSource = readFileSync(
			join(dirname(eaSourcePath), "..", "utils", "excalidrawAutomateUtils.ts"),
			"utf8",
		);
		assert.match(
			initSource,
			/window\.ExcalidrawAutomate\s*=\s*ea\s*;/,
			"expected initExcalidrawAutomate() to assign the ExcalidrawAutomate instance straight to " +
				"window.ExcalidrawAutomate — if this changed, getExcalidrawAutomate()'s window fallback " +
				"needs to change with it.",
		);
	});
});
