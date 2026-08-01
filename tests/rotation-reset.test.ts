import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceLeaf } from "obsidian";
import { adjustSelectedElementsOpacity, applySelectionTransform, resetSelectedRotation } from "../src/excalidraw-view";
import { captureElementRevisions } from "../src/excalidraw-element-mutation";

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

	it("does not overwrite an element changed after async planning", () => {
		const updates: Record<string, unknown>[] = [];
		const planned = { id: "selected", type: "image", x: 10, y: 20, width: 30, height: 40, angle: 0, version: 2, versionNonce: 20 };
		const live = { ...planned, x: 50, version: 3, versionNonce: 30 };
		const leaf = rotationLeaf([live], { selected: true }, (update) => updates.push(update));

		assert.equal(applySelectionTransform(
			leaf,
			[{ ...planned, x: 15 }],
			captureElementRevisions([planned]),
		), false);
		assert.equal(updates.length, 0);
		assert.equal(live.x, 50);
	});
});

describe("adjustSelectedElementsOpacity", () => {
	it("matches Excalidraw's property action by including bound text", () => {
		const updates: Record<string, unknown>[] = [];
		const elements = [
			{ id: "shape", type: "rectangle", x: 0, y: 0, width: 20, height: 20, opacity: 80 },
			{ id: "label", type: "text", containerId: "shape", x: 5, y: 5, width: 10, height: 10, opacity: 80 },
			{ id: "other", type: "text", x: 30, y: 30, width: 10, height: 10, opacity: 80 },
		];
		const leaf = rotationLeaf(elements, { shape: true }, (update) => updates.push(update));

		assert.equal(adjustSelectedElementsOpacity(leaf, 1), true);
		const changed = updates[0].elements as Array<Record<string, unknown>>;
		assert.equal(changed[0].opacity, 90);
		assert.equal(changed[1].opacity, 90);
		assert.equal(changed[2], elements[2]);
	});
});
