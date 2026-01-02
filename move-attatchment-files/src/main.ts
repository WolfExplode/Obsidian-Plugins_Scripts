import {
  Plugin,
  Editor,
  Notice,
  TFile,
  normalizePath,
  PluginSettingTab,
  App,
  Setting,
} from "obsidian";

interface MoveAttachmentSettings {
  /**
   * When set, any attachment whose path or file name contains this string
   * will be ignored and left in place.
   */
  excludeString: string;
}

const DEFAULT_SETTINGS: MoveAttachmentSettings = {
  excludeString: "",
};

export default class MoveAttatchmentFiles extends Plugin {
  settings: MoveAttachmentSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "move-embedded-files",
      name: "Move embedded files to note folder",
      editorCallback: (editor: Editor) => this.moveEmbeddedFiles(editor),
    });

    this.addSettingTab(new MoveAttachmentSettingTab(this.app, this));
  }

  private async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) ?? {}
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async moveEmbeddedFiles(editor: Editor) {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file");
      return;
    }

    // Full content of the current note
    const content = editor.getValue();

    // Match embedded wiki-embeds: ![[path/to/file.ext]] or ![[path/to/file.ext|alias]]
    const embedRegex = /!\[\[([^\]|]+)(\|[^\]]+)?\]\]/g;
    const matches: RegExpExecArray[] = [];
    let match: RegExpExecArray | null;
    while ((match = embedRegex.exec(content)) !== null) {
      matches.push(match);
    }

    if (matches.length === 0) {
      new Notice("No embedded files found");
      return;
    }

    // Folder name = note filename (without extension), created next to the note
    const noteName = activeFile.basename;
    const noteParentPath = activeFile.parent?.path || "";
    const targetFolderPath = normalizePath(`${noteParentPath}/${noteName}`);

    // Ensure target folder exists
    let targetFolder = this.app.vault.getAbstractFileByPath(targetFolderPath);
    if (!targetFolder) {
      targetFolder = await this.app.vault.createFolder(targetFolderPath);
      new Notice(`Created folder: ${noteName}`);
    }

    let movedCount = 0;

    for (const match of matches) {
      const linkPath = match[1].trim(); // original link target (may include subfolders)

      // Resolve the file from the vault relative to the current note
      const file = this.app.metadataCache.getFirstLinkpathDest(
        linkPath,
        activeFile.path
      );

      // Only move real files, and skip markdown notes (keep them where they are)
      if (!(file instanceof TFile)) continue;
      if (!file.extension || file.extension.toLowerCase() === "md") continue;

      // Respect exclusion setting: skip any file whose path or name contains
      // the configured string (case-insensitive).
      const exclude = this.settings.excludeString?.trim();
      if (exclude) {
        const needle = exclude.toLowerCase();
        const pathLower = file.path.toLowerCase();
        const nameLower = file.name.toLowerCase();
        if (pathLower.includes(needle) || nameLower.includes(needle)) {
          continue;
        }
      }

      try {
        const newPath = normalizePath(`${targetFolderPath}/${file.name}`);

        // Skip if it's already in the target folder
        if (file.path === newPath) {
          continue;
        }

        // Move the underlying file. The note text and its links are intentionally
        // left unchanged so Obsidian can resolve them using its default logic.
        await this.app.fileManager.renameFile(file, newPath);
        movedCount++;
      } catch (error) {
        console.error(`Failed to move ${linkPath}:`, error);
        new Notice(`Failed to move ${linkPath}`);
      }
    }

    if (movedCount > 0) {
      new Notice(`Moved ${movedCount} file(s) to ${noteName}/`);
    } else {
      new Notice("No attachment files to move");
    }
  }

  // Compute a vault-relative path from one file to another
  private getRelativePath(from: string, to: string): string {
    const fromParts = from.split("/");
    const toParts = to.split("/");

    // Remove the filename from the "from" path
    fromParts.pop();

    // Find common prefix
    let i = 0;
    while (
      i < fromParts.length &&
      i < toParts.length &&
      fromParts[i] === toParts[i]
    ) {
      i++;
    }

    const upCount = fromParts.length - i;
    const relativeParts = [...Array(upCount).fill(".."), ...toParts.slice(i)];

    return relativeParts.join("/");
  }
}

class MoveAttachmentSettingTab extends PluginSettingTab {
  plugin: MoveAttatchmentFiles;

  constructor(app: App, plugin: MoveAttatchmentFiles) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Move Attachment Files - Settings" });
    containerEl.createEl("h4", { text: "press `ctrl+P` to open the command palette and type 'Move Embedded Files' to move the files" });
    new Setting(containerEl)
      .setName("Exclude attachments containing")
      .setDesc(
        "Any attachment whose file name or path contains this text (case-insensitive) will NOT be moved."
      )
      .addText((text) =>
        text
          .setPlaceholder("e.g. keep-here, assets, shared")
          .setValue(this.plugin.settings.excludeString)
          .onChange(async (value) => {
            this.plugin.settings.excludeString = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
