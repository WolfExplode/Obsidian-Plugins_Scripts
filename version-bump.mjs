import { readFile, writeFile } from "node:fs/promises";

const manifestPath = new URL("./manifest.json", import.meta.url);
const versionsPath = new URL("./versions.json", import.meta.url);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const versions = JSON.parse(await readFile(versionsPath, "utf8"));
versions[manifest.version] = manifest.minAppVersion;

await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
await writeFile(versionsPath, `${JSON.stringify(versions, null, "\t")}\n`);
console.log(`Synchronized Obsidian version metadata for ${manifest.version}.`);
