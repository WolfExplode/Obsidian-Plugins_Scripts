import { desanitizeAttachmentName } from "./popout-drop-bridge";

function basename(path: string): string {
	return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/**
 * Whether a vault path can be the file created for one dropped filename.
 * Obsidian preserves the source stem and appends `_N` before the extension on
 * collision. The source stem itself may already end in `_N`; that part is data,
 * not a suffix to normalize away.
 */
export function importFileMatchesVaultPath(sourceName: string, targetPath: string): boolean {
	const source = desanitizeAttachmentName(basename(sourceName)).toLowerCase();
	const target = desanitizeAttachmentName(basename(targetPath)).toLowerCase();
	if (source === target) return true;

	const extensionAt = source.lastIndexOf(".");
	if (extensionAt <= 0) return false;
	const stem = source.slice(0, extensionAt);
	const extension = source.slice(extensionAt);
	if (!target.startsWith(stem) || !target.endsWith(extension)) return false;
	const collisionSuffix = target.slice(stem.length, target.length - extension.length);
	return /^_\d+$/.test(collisionSuffix);
}
