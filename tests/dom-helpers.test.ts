import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearPopupDocumentMarker, getPopupFilePath, markPopupDocument } from "../src/document-marker";
import { isEditableTarget } from "../src/editable-target";

/**
 * A fake Document is fine here: the marker functions only ever read/write one
 * expando property, never touch real DOM behaviour.
 */
function fakeDocument(): Document {
	return {} as Document;
}

describe("popup document marker", () => {
	it("returns undefined for a document that was never marked", () => {
		assert.equal(getPopupFilePath(fakeDocument()), undefined);
	});

	it("round-trips the file path that was marked", () => {
		const doc = fakeDocument();
		markPopupDocument(doc, "boards/reference.excalidraw");
		assert.equal(getPopupFilePath(doc), "boards/reference.excalidraw");
	});

	it("overwrites a previous mark with the latest path", () => {
		const doc = fakeDocument();
		markPopupDocument(doc, "boards/first.excalidraw");
		markPopupDocument(doc, "boards/second.excalidraw");
		assert.equal(getPopupFilePath(doc), "boards/second.excalidraw");
	});

	it("clears the mark so the path no longer resolves", () => {
		const doc = fakeDocument();
		markPopupDocument(doc, "boards/reference.excalidraw");
		clearPopupDocumentMarker(doc);
		assert.equal(getPopupFilePath(doc), undefined);
	});

	it("clearing an unmarked document is a no-op, not an error", () => {
		const doc = fakeDocument();
		assert.doesNotThrow(() => clearPopupDocumentMarker(doc));
		assert.equal(getPopupFilePath(doc), undefined);
	});

	it("keeps marks on separate documents independent", () => {
		const a = fakeDocument();
		const b = fakeDocument();
		markPopupDocument(a, "boards/a.excalidraw");
		markPopupDocument(b, "boards/b.excalidraw");
		assert.equal(getPopupFilePath(a), "boards/a.excalidraw");
		assert.equal(getPopupFilePath(b), "boards/b.excalidraw");
	});
});

/** Minimal stand-in for the HTMLElement shape isEditableTarget actually reads. */
function el(tagName: string, isContentEditable = false): EventTarget {
	return { tagName, isContentEditable } as unknown as EventTarget;
}

describe("isEditableTarget", () => {
	it("treats null as not editable", () => {
		assert.equal(isEditableTarget(null), false);
	});

	it("treats a target with no tagName as not editable", () => {
		assert.equal(isEditableTarget({} as EventTarget), false);
	});

	it("treats INPUT and TEXTAREA as editable", () => {
		assert.equal(isEditableTarget(el("INPUT")), true);
		assert.equal(isEditableTarget(el("TEXTAREA")), true);
	});

	it("treats a plain DIV as not editable", () => {
		assert.equal(isEditableTarget(el("DIV")), false);
	});

	it("treats contenteditable as editable regardless of tag", () => {
		assert.equal(isEditableTarget(el("DIV", true)), true);
	});

	it("is case-sensitive on tagName, matching real DOM uppercase tag names", () => {
		assert.equal(isEditableTarget(el("input")), false);
	});
});
