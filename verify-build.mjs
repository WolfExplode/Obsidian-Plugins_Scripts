import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const versions = JSON.parse(readFileSync(path.join(root, "versions.json"), "utf8"));
const bundlePath = path.join(root, "main.js");

if (!existsSync(bundlePath) || statSync(bundlePath).size < 1000) {
	throw new Error("main.js is missing or unexpectedly small; the plugin would not load.");
}

const bundle = readFileSync(bundlePath, "utf8");
if (!bundle.includes("module.exports")) {
	throw new Error("main.js is not a CommonJS esbuild bundle.");
}
if (/from\s+["'](?:\.\/)?(?:src|main\.ts)/.test(bundle)) {
	throw new Error("main.js still contains source imports; bundling did not complete.");
}
if (versions[manifest.version] !== manifest.minAppVersion) {
	throw new Error(`versions.json does not map ${manifest.version} to ${manifest.minAppVersion}.`);
}

console.log(`Bundle OK: ${manifest.id} ${manifest.version} (${statSync(bundlePath).size} bytes)`);
