/* Transparent BaseWindow with an Obsidian BrowserWindow-ownership compatibility bridge. */
const path = require("path");
const { BaseWindow, BrowserWindow, WebContentsView } = require("electron");

const events = [];
let sequence = 0;
function trace(stage, data = {}) {
	const event = { sequence: ++sequence, stage, data, timestamp: new Date().toISOString() };
	events.push(event);
	if (events.length > 150) events.shift();
	console.log(`[EPR main ${event.sequence}] ${stage} ${JSON.stringify(data)}`);
	return event;
}

function resolveRemoteMain() {
	trace("remote-main.resolve.begin", { cachedModules: Object.keys(require.cache).length });
	for (const cached of Object.values(require.cache)) {
		if (!cached || typeof cached.filename !== "string") continue;
		const normalized = cached.filename.replace(/\\/g, "/");
		if (!normalized.includes("/@electron/remote/dist/src/main/")) continue;
		if (typeof cached.exports?.enable === "function") {
			trace("remote-main.resolve.cache-hit", { filename: normalized });
			return cached.exports;
		}
	}

	const candidates = [
		path.join(process.resourcesPath, "app.asar", "node_modules", "@electron", "remote", "dist", "src", "main", "index.js"),
		path.join(path.dirname(require.main?.filename ?? ""), "node_modules", "@electron", "remote", "dist", "src", "main", "index.js"),
	];
	for (const candidate of candidates) {
		try {
			const loaded = require(candidate);
			if (typeof loaded?.enable === "function") {
				trace("remote-main.resolve.path-hit", { candidate });
				return loaded;
			}
		} catch (error) {
			trace("remote-main.resolve.path-miss", { candidate, error: String(error) });
		}
	}
	throw new Error("Could not locate Obsidian's initialized @electron/remote main server");
}

const remoteMain = resolveRemoteMain();
const MARKER = "epr-webcontents-view-transparent-v10";
const hosts = new Map();
const adoptedOwners = new Map();

// @electron/remote implements getCurrentWindow() through
// BrowserWindow.fromWebContents(sender). An adopted WebContents in a BaseWindow
// has no BrowserWindow owner, so narrowly extend that lookup for our children.
const originalFromWebContents = BrowserWindow.fromWebContents;
const patchedFromWebContents = function (contents) {
	const nativeOwner = originalFromWebContents.call(BrowserWindow, contents);
	if (nativeOwner) return nativeOwner;
	return adoptedOwners.get(contents?.id)?.host ?? null;
};
let compatibilityPatchInstalled = false;
try {
	BrowserWindow.fromWebContents = patchedFromWebContents;
	compatibilityPatchInstalled = BrowserWindow.fromWebContents === patchedFromWebContents;
} catch (error) {
	trace("compatibility.fromWebContents.install-failed", { error: String(error) });
}
trace("compatibility.fromWebContents.installed", { compatibilityPatchInstalled });

function nativeOptions(options) {
	const keys = [
		"x", "y", "width", "height", "useContentSize", "center",
		"minWidth", "minHeight", "maxWidth", "maxHeight", "resizable",
		"movable", "minimizable", "maximizable", "closable", "focusable",
		"alwaysOnTop", "fullscreenable", "skipTaskbar", "title", "parent",
		"modal", "acceptFirstMouse", "hasShadow",
	];
	const picked = {};
	for (const key of keys) if (options[key] !== undefined) picked[key] = options[key];
	return picked;
}

function hostSnapshot(host, childContents) {
	return {
		hostType: "BaseWindow",
		hostId: host.id,
		bounds: host.getBounds(),
		contentSize: host.getContentSize(),
		backgroundColor: typeof host.getBackgroundColor === "function"
			? host.getBackgroundColor()
			: "unavailable",
		visible: host.isVisible(),
		focused: host.isFocused(),
		resizable: host.isResizable(),
		compatibilityWebContentsId: host.webContents?.id ?? null,
		fromWebContentsMapsToHost: BrowserWindow.fromWebContents(childContents) === host,
		childId: childContents.id,
		childUrl: childContents.getURL(),
		childDestroyed: childContents.isDestroyed(),
	};
}

function safeHostSnapshot(hostId, host, childContents) {
	try {
		return hostSnapshot(host, childContents);
	} catch (error) {
		return {
			hostType: "BaseWindow",
			hostId,
			destroyedOrUnavailable: true,
			error: String(error),
		};
	}
}

function createTransparentHost(options) {
	const childContents = options.webContents;
	trace("createWindow.enter", {
		hostType: "BaseWindow",
		hasChildContents: Boolean(childContents),
		childId: childContents?.id,
		parsedOptions: {
			x: options.x, y: options.y, width: options.width, height: options.height,
			show: options.show, frame: options.frame, transparent: options.transparent,
			backgroundColor: options.backgroundColor,
		},
	});
	if (!childContents) throw new Error("Tagged child did not supply webContents");
	const childId = childContents.id;
	if (!compatibilityPatchInstalled) {
		throw new Error("Could not install BaseWindow ownership compatibility lookup");
	}

	remoteMain.enable(childContents);
	trace("child.remote-enabled", { childId });

	const host = new BaseWindow({
		...nativeOptions(options),
		show: false,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
	});
	const hostId = host.id;
	const nativeSetBackgroundColor = host.setBackgroundColor.bind(host);
	let interceptedBackgroundRequests = 0;
	const forceTransparency = (source) => {
		try {
			nativeSetBackgroundColor("#00000000");
			trace("host.transparency-enforced", { hostId, source, interceptedBackgroundRequests });
			return { hostId, applied: true, source, interceptedBackgroundRequests };
		} catch (error) {
			trace("host.transparency-enforce-failed", { hostId, source, error: String(error) });
			return { hostId, applied: false, source, error: String(error) };
		}
	};
	try {
		Object.defineProperty(host, "setBackgroundColor", {
			configurable: true,
			enumerable: true,
			value: (requestedColor) => {
				interceptedBackgroundRequests += 1;
				trace("compatibility.setBackgroundColor.intercepted", {
					hostId,
					requestedColor,
					interceptedBackgroundRequests,
				});
				return nativeSetBackgroundColor("#00000000");
			},
		});
		trace("compatibility.setBackgroundColor.installed", { hostId });
	} catch (error) {
		trace("compatibility.setBackgroundColor.install-failed", { hostId, error: String(error) });
	}
	forceTransparency("host-created");
	let compatibilityPropertyInstalled = false;
	try {
		Object.defineProperty(host, "webContents", {
			configurable: true,
			enumerable: true,
			get: () => childContents,
		});
		compatibilityPropertyInstalled = host.webContents === childContents;
	} catch (error) {
		trace("compatibility.webContents-property.failed", { hostId, error: String(error) });
	}
	adoptedOwners.set(childId, { host, childContents });
	trace("compatibility.owner-mapped", {
		hostId,
		childId,
		compatibilityPropertyInstalled,
		fromWebContentsMapsToHost: BrowserWindow.fromWebContents(childContents) === host,
	});
	trace("host.created", hostSnapshot(host, childContents));

	const view = new WebContentsView({ webContents: childContents });
	view.setBackgroundColor("#00000000");
	host.contentView.addChildView(view);
	trace("child.adopted-into-view", {
		hostId,
		childId,
		viewBackgroundColor: "#00000000",
	});

	let layoutCount = 0;
	let lastLayoutLogAt = 0;
	const layout = () => {
		const [width, height] = host.getContentSize();
		view.setBounds({ x: 0, y: 0, width, height });
		layoutCount += 1;
		const now = Date.now();
		if (layoutCount === 1 || now - lastLayoutLogAt >= 500) {
			lastLayoutLogAt = now;
			trace("host.layout", { hostId, width, height, layoutCount });
		}
	};
	layout();
	host.on("resize", layout);

	for (const eventName of ["ready-to-show", "show", "focus", "blur", "close", "closed"]) {
		host.on(eventName, () => trace(`host.${eventName}`, { hostId }));
	}
	childContents.on("dom-ready", () => trace("child.dom-ready", safeHostSnapshot(hostId, host, childContents)));
	childContents.on("did-finish-load", () => trace("child.did-finish-load", safeHostSnapshot(hostId, host, childContents)));
	childContents.on("render-process-gone", (_event, details) => trace("child.render-process-gone", details));

	hosts.set(hostId, { host, view, childContents, layout, forceTransparency });
	host.on("closed", () => {
		hosts.delete(hostId);
		adoptedOwners.delete(childId);
		try {
			if (!childContents.isDestroyed()) childContents.close();
		} catch (error) {
			trace("child.close-after-host.failed", { hostId, childId, error: String(error) });
		}
	});
	childContents.on("destroyed", () => {
		hosts.delete(hostId);
		adoptedOwners.delete(childId);
		trace("child.destroyed", { hostId, childId });
		try {
			if (!host.isDestroyed()) host.destroy();
		} catch (error) {
			trace("host.destroy-after-child.failed", { hostId, error: String(error) });
		}
	});

	if (options.show !== false) host.show();
	trace("createWindow.return", hostSnapshot(host, childContents));
	return childContents;
}

function handler(details) {
	const isTagged = typeof details.features === "string" && details.features.includes(MARKER);
	trace("handler.invoked", { tagged: isTagged, url: details.url, features: details.features });
	if (!isTagged) return { action: "allow" };
	return { action: "allow", createWindow: createTransparentHost };
}

module.exports = {
	MARKER,
	begin(openerWindowId) {
		trace("begin", { openerWindowId });
		const opener = BrowserWindow.fromId(openerWindowId);
		if (!opener) return false;
		remoteMain.enable(opener.webContents);
		opener.webContents.setWindowOpenHandler(handler);
		trace("handler.installed", { openerWindowId, openerWebContentsId: opener.webContents.id });
		return true;
	},
	end(openerWindowId) {
		trace("end", { openerWindowId });
		const opener = BrowserWindow.fromId(openerWindowId);
		if (!opener) return false;
		opener.webContents.setWindowOpenHandler(null);
		trace("handler.removed", { openerWindowId });
		return true;
	},
	enforceTransparency(label) {
		const results = [];
		for (const { view, forceTransparency } of hosts.values()) {
			const result = forceTransparency(`renderer:${label}`);
			try {
				view.setBackgroundColor("#00000000");
				results.push({ ...result, childViewApplied: true });
			} catch (error) {
				results.push({ ...result, childViewApplied: false, childViewError: String(error) });
			}
		}
		return results;
	},
	snapshot() {
		return {
			events: events.slice(),
			hosts: Array.from(hosts.entries()).map(([hostId, { host, childContents }]) =>
				safeHostSnapshot(hostId, host, childContents)),
		};
	},
};
