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

		await assert.rejects(writer.mutateSection("geometry", () => ({ boards: {} })), /simulated save failure/);
		await writer.mutateSection("hotkeys", () => ({ "pack-left": [] }));

		assert.deepEqual(adapter.data, { hotkeys: { "pack-left": [] } });
	});

	it("does not retain a failed geometry change in memory or leak it into a later write", async () => {
		const adapter = new MemoryPluginData();
		const geometry = new GeometryStore(new PluginDataWriter(adapter));
		adapter.failNextSave = true;

		await assert.rejects(
			geometry.set("failed.excalidraw", { x: 1, y: 2, width: 3, height: 4 }),
			/simulated save failure/,
		);
		assert.equal(geometry.get("failed.excalidraw"), null);

		await geometry.setViewport("saved.excalidraw", { scrollX: 10, scrollY: 20, zoom: 2 });
		assert.deepEqual(adapter.data, {
			geometry: {
				boards: {},
				viewports: { "saved.excalidraw": { scrollX: 10, scrollY: 20, zoom: 2 } },
			},
		});
	});

	it("serializes concurrent geometry changes without losing either one", async () => {
		const adapter = new MemoryPluginData();
		const geometry = new GeometryStore(new PluginDataWriter(adapter));

		await Promise.all([
			geometry.set("board.excalidraw", { x: 1, y: 2, width: 3, height: 4 }),
			geometry.setViewport("board.excalidraw", { scrollX: 10, scrollY: 20, zoom: 2 }),
		]);

		assert.deepEqual(adapter.data, {
			geometry: {
				boards: { "board.excalidraw": { x: 1, y: 2, width: 3, height: 4 } },
				viewports: { "board.excalidraw": { scrollX: 10, scrollY: 20, zoom: 2 } },
			},
		});
		assert.deepEqual(geometry.get("board.excalidraw"), { x: 1, y: 2, width: 3, height: 4 });
		assert.deepEqual(geometry.getViewport("board.excalidraw"), { scrollX: 10, scrollY: 20, zoom: 2 });
	});

	it("preserves committed geometry when clearAll fails", async () => {
		const adapter = new MemoryPluginData();
		const geometry = new GeometryStore(new PluginDataWriter(adapter));
		await geometry.set("existing.excalidraw", { x: 1, y: 2, width: 3, height: 4 });
		adapter.failNextSave = true;

		await assert.rejects(geometry.clearAll(), /simulated save failure/);
		assert.deepEqual(geometry.get("existing.excalidraw"), { x: 1, y: 2, width: 3, height: 4 });

		await geometry.set("later.excalidraw", { x: 5, y: 6, width: 7, height: 8 });
		assert.deepEqual(adapter.data, {
			geometry: {
				boards: {
					"existing.excalidraw": { x: 1, y: 2, width: 3, height: 4 },
					"later.excalidraw": { x: 5, y: 6, width: 7, height: 8 },
				},
				viewports: {},
			},
		});
	});

	it("starts a concurrent geometry change from committed state when the prior one fails", async () => {
		const adapter = new MemoryPluginData();
		const geometry = new GeometryStore(new PluginDataWriter(adapter));
		adapter.failNextSave = true;

		const [viewportResult, boundsResult] = await Promise.allSettled([
			geometry.setViewport("board.excalidraw", { scrollX: 10, scrollY: 20, zoom: 2 }),
			geometry.set("board.excalidraw", { x: 1, y: 2, width: 3, height: 4 }),
		]);

		assert.equal(viewportResult.status, "rejected");
		assert.equal(boundsResult.status, "fulfilled");
		assert.equal(geometry.getViewport("board.excalidraw"), null);
		assert.deepEqual(geometry.get("board.excalidraw"), { x: 1, y: 2, width: 3, height: 4 });
		assert.deepEqual(adapter.data, {
			geometry: {
				boards: { "board.excalidraw": { x: 1, y: 2, width: 3, height: 4 } },
				viewports: {},
			},
		});
	});

	it("does not retain a failed hotkey override or leak it into a later override", async () => {
		const adapter = new MemoryPluginData();
		const hotkeys = new HotkeyStore(new PluginDataWriter(adapter));
		let notifications = 0;
		hotkeys.onChange(() => { notifications++; });
		adapter.failNextSave = true;

		await assert.rejects(
			hotkeys.set("failed-action", [{ modifiers: ["Ctrl"], key: "F" }]),
			/simulated save failure/,
		);
		assert.equal(hotkeys.isOverridden("failed-action"), false);
		assert.equal(notifications, 0);

		await hotkeys.set("saved-action", [{ modifiers: ["Alt"], key: "S" }]);
		assert.equal(notifications, 1);
		assert.deepEqual(adapter.data, {
			hotkeys: { "saved-action": [{ modifiers: ["Alt"], key: "S" }] },
		});
	});

	it("keeps an override when resetting it fails", async () => {
		const adapter = new MemoryPluginData();
		const hotkeys = new HotkeyStore(new PluginDataWriter(adapter));
		await hotkeys.set("existing-action", [{ modifiers: ["Ctrl"], key: "E" }]);
		adapter.failNextSave = true;

		await assert.rejects(hotkeys.reset("existing-action"), /simulated save failure/);
		assert.equal(hotkeys.isOverridden("existing-action"), true);

		await hotkeys.set("later-action", [{ modifiers: ["Alt"], key: "L" }]);
		assert.deepEqual(adapter.data, {
			hotkeys: {
				"existing-action": [{ modifiers: ["Ctrl"], key: "E" }],
				"later-action": [{ modifiers: ["Alt"], key: "L" }],
			},
		});
	});

	it("serializes concurrent hotkey changes without losing either one", async () => {
		const adapter = new MemoryPluginData();
		const hotkeys = new HotkeyStore(new PluginDataWriter(adapter));

		await Promise.all([
			hotkeys.set("first-action", [{ modifiers: ["Ctrl"], key: "F" }]),
			hotkeys.set("second-action", [{ modifiers: ["Alt"], key: "S" }]),
		]);

		assert.deepEqual(adapter.data, {
			hotkeys: {
				"first-action": [{ modifiers: ["Ctrl"], key: "F" }],
				"second-action": [{ modifiers: ["Alt"], key: "S" }],
			},
		});
		assert.equal(hotkeys.isOverridden("first-action"), true);
		assert.equal(hotkeys.isOverridden("second-action"), true);
	});
});
