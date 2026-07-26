/**
 * Heals cross-realm drag-and-drop of media into a Popout.
 *
 * An Obsidian Popout is a *separate JavaScript realm* — its `File`, `Blob` and
 * `ArrayBuffer` are different constructors from the main window's, even though
 * both share the same `app` object (which lives in the main realm). Verified
 * live: `popoutWindow.ArrayBuffer !== mainWindow.ArrayBuffer`.
 *
 * When you drop a file into the Popout, Chromium mints the dropped
 * `File`/`ArrayBuffer` from the *Popout's* realm. Excalidraw's importer
 * (`createOrOverwriteFile` in the Excalidraw plugin) runs in the *main* realm
 * and branches on `i instanceof Blob` / `i instanceof ArrayBuffer`. A
 * Popout-realm object fails those checks, so the import falls through to the
 * text-write path (`vault.create(path, arrayBuffer)`) and Node's `fs.writeFile`
 * throws "the data argument must be ... Received an instance of ArrayBuffer".
 * That's why a *new* file fails to import while media already in the vault
 * (no write needed) drops in fine, and why the main window is unaffected.
 *
 * We don't reimplement Excalidraw's import matrix (files, vault links, browser
 * images, .excalidraw payloads, …). Instead we hand Excalidraw objects it
 * recognizes: on a trusted file drop we clone each dropped file into a
 * *main-realm* `File`, rebuild the `DataTransfer`, and re-dispatch the drag
 * sequence. Excalidraw's own pipeline then runs unmodified and every
 * `instanceof` passes.
 *
 * Scope: only trusted drops carrying `dataTransfer.files` are bridged. Plain
 * string payloads (a browser image's `text/uri-list`, Obsidian's internal
 * drag via the shared `dragManager`) are realm-agnostic and already work, so
 * they pass through untouched. Our own re-dispatched events are `isTrusted:
 * false` and are ignored, so there is no re-entrancy loop.
 */

/** Marks the synthetic drag sequence we dispatch, as a second guard beyond isTrusted. */
const SYNTHETIC_FLAG = "__eprBridged";

/**
 * Obsidian's wikilink metacharacters can't appear in a vault attachment
 * filename: `![[…]]` embeds that reference them never resolve, so the file
 * imports but renders as a broken tile (Excalidraw even warns on drop). The
 * name has to be made legal *before* Excalidraw writes the file, because
 * Excalidraw records it into the scene as a raw path — not an Obsidian link —
 * so no later rename can heal the reference. We map each offender to its
 * full-width Unicode look-alike, which is link-legal, visually near-identical,
 * and verified to round-trip cross-platform sync. `#温柔甜美.mp4` → `＃温柔甜美.mp4`.
 */
const WIKILINK_UNSAFE: Record<string, string> = {
	"#": "＃", // ＃ FULLWIDTH NUMBER SIGN
	"^": "＾", // ＾ FULLWIDTH CIRCUMFLEX ACCENT
	"[": "［", // ［ FULLWIDTH LEFT SQUARE BRACKET
	"]": "］", // ］ FULLWIDTH RIGHT SQUARE BRACKET
	"|": "｜", // ｜ FULLWIDTH VERTICAL LINE
};

const sanitizeAttachmentName = (name: string): string =>
	name.replace(/[#^[\]|]/g, (ch) => WIKILINK_UNSAFE[ch] ?? ch);

const WIKILINK_UNSAFE_REVERSE: Record<string, string> = Object.fromEntries(
	Object.entries(WIKILINK_UNSAFE).map(([ascii, wide]) => [wide, ascii]),
);

/**
 * Inverse of {@link sanitizeAttachmentName}. Lets code that only ever sees the
 * *original* dropped filename (e.g. media-auto-pack's import tracking) still
 * recognize a vault file this bridge renamed, by folding both back to the same
 * ASCII form before comparing.
 */
export const desanitizeAttachmentName = (name: string): string =>
	name.replace(/[＃＾［］｜]/g, (ch) => WIKILINK_UNSAFE_REVERSE[ch] ?? ch);

/**
 * @param alwaysBridge When true (a Popout), every trusted file drop is bridged —
 *   the cross-realm clone is mandatory there. When false (the main window, where
 *   Excalidraw's native import already works), we only take over a drop that
 *   carries a filename needing sanitization, and otherwise leave Excalidraw's
 *   path untouched.
 */
export function attachPopoutDropBridge(doc: Document, { alwaysBridge = true }: { alwaysBridge?: boolean } = {}): () => void {
	const win = doc.defaultView ?? window;
	// The main window whose realm owns the constructors Excalidraw checks against.
	const mainWindow = window;
	let detached = false;

	// Resolve a dropped file's on-disk path. Excalidraw's *embeddable* branch
	// (video, PDF, etc.) needs the OS path, not the bytes: it reads `file.path`
	// and falls back to `webUtils.getPathForFile(file)`. Our byte-clone has no
	// `.path` and isn't in webUtils' registry (getPathForFile returns "" for it),
	// so without this the video path shows "can't read file path". `.path` is
	// null in this Electron build; `webUtils` (main window only) is the real
	// source. Must be called on the ORIGINAL dropped file, synchronously.
	const resolveFilePath = (file: File): string => {
		const direct = (file as unknown as { path?: unknown }).path;
		if (typeof direct === "string" && direct) return direct;
		try {
			const webUtils = (mainWindow as unknown as { electron?: { webUtils?: { getPathForFile?: (f: File) => string } } })
				.electron?.webUtils;
			return webUtils?.getPathForFile?.(file) ?? "";
		} catch {
			return "";
		}
	};

	const isBridgeable = (event: DragEvent): boolean => {
		if (!event.isTrusted) return false;
		if ((event as unknown as Record<string, unknown>)[SYNTHETIC_FLAG]) return false;
		const dt = event.dataTransfer;
		return !!dt && dt.files && dt.files.length > 0;
	};

	// Trusted dragenter/dragover for a file drop must be allowed to default so
	// the browser will deliver the drop at all. Excalidraw's own handlers also
	// preventDefault these, but if it hasn't attached to this exact target we
	// still want the drop to land. Harmless when Excalidraw already handled it.
	const onDragOver = (event: DragEvent) => {
		if (!isBridgeable(event)) return;
		event.preventDefault();
	};

	const onDrop = (event: DragEvent) => {
		if (!isBridgeable(event)) return;
		const dt = event.dataTransfer;
		if (!dt) return;

		// In the main window Excalidraw's native import already works, so only
		// intervene when a dropped filename actually carries a wikilink-unsafe
		// character; otherwise fall through to Excalidraw untouched. (Popouts
		// always bridge — the cross-realm clone is required regardless of name.)
		if (!alwaysBridge && !Array.from(dt.files).some((file) => sanitizeAttachmentName(file.name) !== file.name)) {
			return;
		}

		// Take over from Excalidraw's (about-to-fail) native handler.
		event.preventDefault();
		event.stopImmediatePropagation();

		// The DataTransfer is only readable synchronously inside the handler, so
		// snapshot everything now: each file with its resolved OS path (webUtils
		// must be queried while the drop is live), and every non-file string
		// payload. The file blobs survive past the event; the path lookup may not.
		const files = Array.from(dt.files).map((file) => ({ file, path: resolveFilePath(file) }));
		const strings: Array<[string, string]> = [];
		for (const type of Array.from(dt.types)) {
			if (type === "Files") continue;
			try {
				strings.push([type, dt.getData(type)]);
			} catch {
				/* some types refuse getData; skip them */
			}
		}

		const target = event.target instanceof Element ? event.target : doc.elementFromPoint(event.clientX, event.clientY);
		// Excalidraw picks the drop action (image-import / embeddable / link /
		// image-url) from a settings matrix keyed on the modifier keys held during
		// the drop. Dropping these from the synthetic event would pin every drop to
		// the no-modifier default, silently disabling e.g. Shift+Ctrl "embeddable"
		// (the only way to drop a video). Carry them across verbatim.
		const init: DragEventInit = {
			bubbles: true,
			cancelable: true,
			clientX: event.clientX,
			clientY: event.clientY,
			screenX: event.screenX,
			screenY: event.screenY,
			shiftKey: event.shiftKey,
			ctrlKey: event.ctrlKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
		};

		void redispatch(files, strings, target, init);
	};

	const redispatch = async (
		files: Array<{ file: File; path: string }>,
		strings: Array<[string, string]>,
		target: Element | null,
		init: DragEventInit,
	) => {
		// Rebuild each dropped file as a MAIN-realm File by copying its bytes into
		// a main-realm Uint8Array. This is what makes Excalidraw's `instanceof
		// Blob`/`instanceof ArrayBuffer` checks pass. Re-stamp the OS path we
		// resolved earlier so the embeddable branch (which reads `file.path`)
		// works too — the clone is otherwise unknown to webUtils.
		const mainFiles: File[] = [];
		for (const { file, path } of files) {
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const copy = new mainWindow.Uint8Array(bytes.length);
				copy.set(bytes);
				const clone = new mainWindow.File([copy], sanitizeAttachmentName(file.name), {
					type: file.type,
					lastModified: file.lastModified,
				});
				if (path) {
					Object.defineProperty(clone, "path", { value: path, configurable: true, enumerable: true });
				}
				mainFiles.push(clone);
			} catch (error) {
				console.error("[Excalidraw PureRef] failed to clone dropped file across realms.", error);
			}
		}
		if (detached || doc.defaultView?.closed) return;
		if (mainFiles.length === 0) return;

		const originalTarget = target?.isConnected && target.ownerDocument === doc ? target : null;
		const dropTarget =
			originalTarget ?? doc.querySelector(".excalidraw__canvas.interactive") ?? doc.querySelector(".excalidraw");
		if (!dropTarget) return;

		const dataTransfer = new mainWindow.DataTransfer();
		for (const file of mainFiles) dataTransfer.items.add(file);
		for (const [type, value] of strings) {
			try {
				dataTransfer.setData(type, value);
			} catch {
				/* setData rejects protected types (e.g. Files); ignore */
			}
		}

		// Re-run the drag sequence Excalidraw expects, flagged so our own
		// listeners ignore it (belt-and-braces with the isTrusted check).
		for (const type of ["dragenter", "dragover", "drop"] as const) {
			const synthetic = new win.DragEvent(type, { ...init, dataTransfer });
			(synthetic as unknown as Record<string, unknown>)[SYNTHETIC_FLAG] = true;
			dropTarget.dispatchEvent(synthetic);
		}
	};

	// Capture phase so we intercept before Excalidraw's own document/root handlers.
	doc.addEventListener("dragover", onDragOver, true);
	doc.addEventListener("drop", onDrop, true);

	return () => {
		detached = true;
		doc.removeEventListener("dragover", onDragOver, true);
		doc.removeEventListener("drop", onDrop, true);
	};
}
