import { Notice } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";

/**
 * PureRef interchange (CONTEXT.md: "PureRef interchange", ADR 0005/0006).
 * Scoped to the reverse-engineered `purformat` 1.10/1.11.1 binary format —
 * see reference/PureRef-format-main/purformat/{read,write}.py.
 *
 * NOT YET IMPLEMENTED. This registers the two command-palette entries
 * decided in the design phase (Question 17: command-palette + OS file
 * dialogs, no vault/file-explorer integration) so the commands exist and are
 * discoverable, but porting the binary reader/writer from Python to
 * TypeScript is real, separate work that hasn't been done yet. Both commands
 * currently just say so rather than silently doing nothing or half-working.
 */
export function registerPurInterchangeCommands(plugin: ExcalidrawPureRefPlugin): void {
	plugin.addCommand({
		id: "import-pur-file",
		name: "Import .pur file...",
		callback: () => {
			new Notice(
				"PureRef import isn't implemented yet — the .pur reader still needs to be " +
					"ported from reference/PureRef-format-main/purformat/read.py.",
			);
		},
	});

	plugin.addCommand({
		id: "export-board-as-pur",
		name: "Export board as .pur...",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			const isExcalidrawFile = file?.extension === "excalidraw";
			if (checking) return isExcalidrawFile;
			if (isExcalidrawFile) {
				new Notice(
					"PureRef export isn't implemented yet — the .pur writer still needs to be " +
						"ported from reference/PureRef-format-main/purformat/write.py.",
				);
			}
			return isExcalidrawFile;
		},
	});
}
