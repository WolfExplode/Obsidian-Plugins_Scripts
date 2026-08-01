import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceLeaf } from "obsidian";
import { resetSelectedRotation } from "../src/excalidraw-view";

function rotationLeaf(
	elements: Array<Record<string, unknown>>,
	selectedElementIds: Record<string, boolean>,
	onUpdate: (update: Record<string, unknown>) => void,
): WorkspaceLeaf {
	return {
		view: {
			getViewType: () => "excalidraw",
			excalidrawAPI: {
				getAppState: () => ({ selectedElementIds }),
				getSceneElements: () => elements,
			},
			updateScene: onUpdate,
		},
	} as unknown as WorkspaceLeaf;
}

describe("resetSelectedRotation", () => {
	it("resets only selected rotated elements in one immediate scene update", () => {
		const updates: Record<string, unknown>[] = [];
		const elements = [
			{ id: "selected", type: "rectangle", x: 10, y: 20, width: 30, height: 40, angle: 1, version: 2 },
			{ id: "unselected", type: "ellipse", x: 0, y: 0, width: 10, height: 10, angle: 2, version: 4 },
		];
		const leaf = rotationLeaf(elements, { selected: true }, (update) => updates.push(update));

		assert.equal(resetSelectedRotation(leaf), true);
		assert.equal(updates.length, 1);
		const update = updates[0] as { elements: Array<Record<string, unknown>>; captureUpdate: string; commitToHistory: boolean };
		assert.equal(update.captureUpdate, "IMMEDIATELY");
		assert.equal(update.commitToHistory, true);
		assert.equal(update.elements[0].angle, 0);
		assert.equal(update.elements[0].x, 10);
		assert.equal(update.elements[0].y, 20);
		assert.equal(update.elements[0].version, 3);
		assert.equal(update.elements[1], elements[1]);
	});

	it("is a no-op when the selection is empty or already upright", () => {
		let updates = 0;
		const leaf = rotationLeaf(
			[{ id: "upright", type: "rectangle", x: 0, y: 0, width: 10, height: 10, angle: 0 }],
			{ upright: true },
			() => { updates++; },
		);

		assert.equal(resetSelectedRotation(leaf), false);
		assert.equal(updates, 0);
	});
});
