import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GeometryStore } from "../src/geometry-store";
import { HotkeyStore } from "../src/hotkey-store";
import { PluginDataWriter, type PluginDataAdapter } from "../src/plugin-data-writer";

class MemoryPluginData implements PluginDataAdapter {
	data: unknown = {};
	failNextSave = false;
	activeTransactions = 0;
	maxActiveTransactions = 0;

	async loadData(): Promise<unknown> {
		this.activeTransactions++;
		this.maxActiveTransactions = Math.max(this.maxActiveTransactions, this.activeTransactions);
		await Promise.resolve();
		return structuredClone(this.data);
	}

	async saveData(data: unknown): Promise<void> {
		try {
			await Promise.resolve();
			if (this.failNextSave) {
				this.failNextSave = false;
				throw new Error("simulated save failure");
			}
			this.data = structuredClone(data);
		} finally {
			this.activeTransactions--;
		}
	}
}

describe("PluginDataWriter", () => {
	it("serializes concurrent writes so geometry and hotkeys both survive", async () => {
		const adapter = new MemoryPluginData();
		const writer = new PluginDataWriter(adapter);
		const geometry = new GeometryStore(writer);
		const hotkeys = new HotkeyStore(writer);

		await Promise.all([
			geometry.set("board.excalidraw", { x: 1, y: 2, width: 3, height: 4 }),
			hotkeys.set("pack-left", [{ modifiers: ["Ctrl"], key: "ArrowLeft" }]),
		]);

		assert.deepEqual(adapter.data, {
			geometry: {
				boards: { "board.excalidraw": { x: 1, y: 2, width: 3, height: 4 } },
				viewports: {},
			},
			hotkeys: { "pack-left": [{ modifiers: ["Ctrl"], key: "ArrowLeft" }] },
		});
		assert.equal(adapter.maxActiveTransactions, 1);
	});

	it("rejects a failed write without poisoning the shared queue", async () => {
		const adapter = new MemoryPluginData();
		const writer = new PluginDataWriter(adapter);
		adapter.failNextSave = true;

		await assert.rejects(writer.writeSection("geometry", { boards: {} }), /simulated save failure/);
		await writer.writeSection("hotkeys", { "pack-left": [] });

		assert.deepEqual(adapter.data, { hotkeys: { "pack-left": [] } });
	});
});
