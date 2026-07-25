/**
 * Tags a Popout window's Document with the vault file path of the Board it
 * hosts, so 'window-close' handling can find the right tracked state without
 * needing a separate Document -> path lookup table.
 * Pattern adapted from reference/obsidian-synaptic-hatch-master/src/popout/document-marker.ts.
 */

type MarkedDocument = Document & { __eprBoardFilePath?: string };

export function markPopupDocument(doc: Document, filePath: string): void {
	(doc as MarkedDocument).__eprBoardFilePath = filePath;
}

export function getPopupFilePath(doc: Document): string | undefined {
	return (doc as MarkedDocument).__eprBoardFilePath;
}

export function clearPopupDocumentMarker(doc: Document): void {
	delete (doc as MarkedDocument).__eprBoardFilePath;
}
