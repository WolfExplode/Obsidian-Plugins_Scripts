import type ExcalidrawPureRefPlugin from "../main";

const HELPER_FILE = "electron-webcontents-view-helper-v10.cjs";

interface MainHelper {
	MARKER: string;
	begin(openerWindowId: number): boolean;
	end(openerWindowId: number): boolean;
	enforceTransparency?(label: string): unknown;
	snapshot(): unknown;
}

let loadedHelper: MainHelper | null = null;
let flowSequence = 0;

function trace(stage: string, data: unknown = {}): void {
	console.log(`[EPR flow ${++flowSequence}] ${stage} ${JSON.stringify(data)}`);
}

function compactSnapshot(snapshot: unknown): unknown {
	if (!snapshot || typeof snapshot !== "object") return snapshot;
	const value = snapshot as { events?: unknown[]; hosts?: unknown[] };
	const events = Array.isArray(value.events) ? value.events : [];
	const meaningfulEvents = events.filter((event) => {
		if (!event || typeof event !== "object") return true;
		const stage = (event as { stage?: unknown }).stage;
		return !["host.layout", "host.focus", "host.blur"].includes(String(stage));
	});
	const latest = events.at(-1) as { sequence?: unknown } | undefined;
	return {
		retainedEventCount: events.length,
		latestSequence: latest?.sequence ?? null,
		recentMeaningfulEvents: meaningfulEvents.slice(-8),
		hosts: Array.isArray(value.hosts) ? value.hosts : [],
	};
}

type RequireFn = (id: string) => unknown;

function getRequire(): RequireFn | null {
	return (window as Window & { require?: RequireFn }).require ?? null;
}

function loadHelper(plugin: ExcalidrawPureRefPlugin): MainHelper | null {
	const req = getRequire();
	if (!req) return null;
	try {
		const injectedRemote = (window as Window & {
			electron?: { remote?: { require?(path: string): unknown } };
		}).electron?.remote;
		const remote = injectedRemote?.require
			? injectedRemote
			: (req("@electron/remote") as { require?(path: string): unknown });
		if (!remote.require) return null;
		const path = req("path") as { join(...parts: string[]): string };
		const adapter = plugin.app.vault.adapter as unknown as { getBasePath?(): string };
		const basePath = adapter.getBasePath?.();
		if (!basePath || !plugin.manifest.dir) return null;
		const helperPath = path.join(basePath, plugin.manifest.dir, HELPER_FILE);
		trace("helper.load", { helperPath, source: injectedRemote?.require ? "window.electron.remote" : "@electron/remote" });
		loadedHelper = remote.require(helperPath) as MainHelper;
		trace("helper.loaded", compactSnapshot(loadedHelper.snapshot()));
		return loadedHelper;
	} catch (error) {
		console.error("[Excalidraw PureRef] could not load the WebContentsView host helper:", error);
		return null;
	}
}

function getCurrentWindowId(): number | null {
	const req = getRequire();
	if (!req) return null;
	try {
		const injectedRemote = (window as Window & {
			electron?: { remote?: { getCurrentWindow?(): { id: number } } };
		}).electron?.remote;
		const remote = injectedRemote?.getCurrentWindow
			? injectedRemote
			: (req("@electron/remote") as { getCurrentWindow?(): { id: number } });
		if (!remote.getCurrentWindow) return null;
		return remote.getCurrentWindow().id;
	} catch {
		return null;
	}
}

/** Opens one Obsidian child through the experimental transparent host helper. */
export function openWithTransparentHost<T>(plugin: ExcalidrawPureRefPlugin, open: () => T): T {
	trace("openWithTransparentHost.enter");
	const helper = loadHelper(plugin);
	const openerId = getCurrentWindowId();
	trace("openWithTransparentHost.bridge", { helper: Boolean(helper), openerId });
	if (!helper || openerId == null) {
		throw new Error("Electron transparent-host bridge is unavailable");
	}

	const originalOpen = window.open;
	window.open = function (url?: string | URL, target?: string, features?: string): Window | null {
		const taggedFeatures = (features ? `${features},` : "") + helper.MARKER;
		trace("window.open.tagged", { url: String(url), target, originalFeatures: features, taggedFeatures });
		return originalOpen.call(window, url as string, target as string, taggedFeatures);
	} as typeof window.open;

	if (!helper.begin(openerId)) {
		window.open = originalOpen;
		throw new Error("Could not install the transparent-host window-open handler");
	}
	trace("handler.begin.succeeded", { openerId });
	try {
		const result = open();
		trace("openPopoutLeaf.returned", { result: Boolean(result), mainSnapshot: compactSnapshot(helper.snapshot()) });
		return result;
	} finally {
		window.open = originalOpen;
		helper.end(openerId);
		trace("handler.end.completed", compactSnapshot(helper.snapshot()));
	}
}

export function logTransparentHostSnapshot(label: string): void {
	try {
		const enforcement = loadedHelper?.enforceTransparency?.(label) ?? null;
		trace(`snapshot.${label}`, {
			enforcement,
			main: loadedHelper ? compactSnapshot(loadedHelper.snapshot()) : { helper: "not loaded" },
		});
	} catch (error) {
		trace(`snapshot.${label}.failed`, { error: String(error) });
	}
}
