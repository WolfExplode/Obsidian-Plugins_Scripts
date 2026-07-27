/**
 * Test runner: bundle each tests/*.test.ts with esbuild, then hand the output to
 * node:test.
 *
 * WHY BUNDLE FIRST: the modules under test are TypeScript and import each other
 * with extensionless specifiers ("./pack-elements"). Node's own type-stripping
 * cannot resolve those, and adding ts-node/tsx/vitest would mean a new
 * dependency. esbuild is already a devDependency for the plugin build, so
 * reusing it keeps the test setup dependency-free and guarantees the tests
 * compile through exactly the same pipeline as the shipped bundle.
 *
 * Only modules free of a runtime `obsidian` import can be tested this way —
 * that is the point of keeping pack-elements.ts, zorder.ts, and crop-geometry.ts
 * dependency-free. Anything importing Notice/Plugin at runtime needs Obsidian and
 * is out of scope here.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testsDir);
const outdir = path.join(root, ".test-build");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const entryPoints = readdirSync(testsDir)
	.filter((f) => f.endsWith(".test.ts"))
	.map((f) => path.join(testsDir, f));

if (entryPoints.length === 0) {
	console.error("No tests/*.test.ts files found.");
	process.exit(1);
}

await esbuild.build({
	entryPoints,
	outdir,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node18",
	sourcemap: "inline",
	// package.json has no "type": "module", so a bare .js here would be parsed as
	// CommonJS and the ESM output would be a syntax error. Force .mjs.
	outExtension: { ".js": ".mjs" },
	// node:test and node:assert stay external so the runner's own instance is used.
	external: ["node:*"],
	logLevel: "warning",
});

// Pass built files explicitly: `node --test <dir>` resolves the directory as a
// module rather than scanning it for the .mjs outputs.
const built = readdirSync(outdir)
	.filter((f) => f.endsWith(".test.mjs"))
	.map((f) => path.join(outdir, f));

const result = spawnSync(process.execPath, ["--test", ...built], { stdio: "inherit" });
process.exit(result.status ?? 1);
