# Performance profiling via the Obsidian DevTools MCP

How to measure real interaction cost (not guesses from reading code) across
this plugin's windows -- the main Obsidian window, an editable PureRef popout,
and the read-only transparent-proto.html window -- using the
`obsidian-devtools-mcp` server's window probes.

Use this before believing a "this is unoptimized" claim about a hot path.
Static reading finds *structurally* inefficient code; it does not tell you
whether the cost is actually perceptible at real scale. See the numbers in
[investigations/](investigations/) (or git history around chrome-hider.ts,
pointer-drag.ts, board-render.ts) for a worked example: several suspected
hotspots measured under 0.2ms/call on a real vault and were left alone, while
board-render.ts's uncached SVG export measured 45-220ms/call and was real.

## Why window probes, not `obsidian_execute_js`

A PureRef Board can open three separate renderer realms with independent
`document`s: the main Obsidian window, an editable popout
(`popout-manager.ts`), and a transparent read-only window
(`transparent-proto.html`). The editable popout is destroyed and recreated
only when fully closed (hidden/shown across F10 read/edit toggles instead --
see `popout-manager.ts:285-347`); the read-only window is destroyed and
**recreated on every single F10 toggle**.

`obsidian_execute_js` targets one specific CDP target at call time. Pasting a
profiler into a window that gets destroyed on the very interaction you're
trying to measure loses the instrumentation before you can read it back.
`obsidian_install_window_probe` installs an Electron main-process
`browser-window-created` hook that auto-injects into every window matching a
URL/title pattern, present and future, for the rest of the session -- open
the probe once, then drive the plugin normally (toggle F10, drag, add media)
without re-pasting anything.

## Setup

1. Launch Obsidian with `--remote-debugging-port=9222` (see
   `launch-obsidian-debug.ps1` / `.bat` in the repo root).
2. `obsidian_connect`, then `obsidian_set_toolset({ toolset: "full" })` --
   window probes live in `full` because they use `evaluateMain`.
3. Install the two probes below once per debugging session.
4. Interact with the plugin normally (or ask a human to).
5. `obsidian_list_targets` to find each window's current `targetId`, then
   `obsidian_read_probe({ id, targetId })` per window.

## Probe A -- Obsidian renderer windows (main window + editable popout)

**Omit `urlPattern`** (match every window). The editable popout's
`location.href` stays `"about:blank"` for its entire lifetime -- it never
navigates to a real `app://` URL, `window.app` is just injected into the
blank page -- so a pattern like `"app://obsidian\\.md"` silently misses it
and only matches the main window. The installer below self-guards with
`if (!window.app) return () => {}`, so matching every window is safe --
worker targets are never real `BrowserWindow`s and can't receive it anyway.

One call now covers both the main window and the editable popout. Wraps
`ExcalidrawAutomate.createSVG` (including the fresh instance
`board-render.ts` gets from `getAPI()` on every render -- wrapping only the
singleton misses that call entirely), tracks workspace lifecycle events, and
approximates chrome-hider's `hideAll()` call frequency with a same-shaped
`MutationObserver` on `document.body`.

```
obsidian_install_window_probe({
  id: "epr-perf",
  installer: `(emit) => {
    const app = window.app;
    if (!app) return () => {};
    const offRefs = [];
    offRefs.push(app.workspace.on("file-open", (file) => emit({ label: "file-open", path: file?.path ?? null })));
    offRefs.push(app.workspace.on("active-leaf-change", (leaf) => emit({ label: "active-leaf-change", viewType: leaf?.view?.getViewType?.() ?? null })));
    offRefs.push(app.workspace.on("layout-change", () => emit({ label: "layout-change" })));

    const excalPlugin = app.plugins.plugins["obsidian-excalidraw-plugin"];
    const base = excalPlugin?.ea;
    const wrapCreateSVG = (instance) => {
      if (!instance || instance.__eprSvgWrapped || typeof instance.createSVG !== "function") return;
      const original = instance.createSVG.bind(instance);
      instance.createSVG = async (...args) => {
        const t0 = performance.now();
        try { return await original(...args); }
        finally { emit({ label: "createSVG", ms: Math.round((performance.now() - t0) * 100) / 100, filePath: args[0] ?? null }); }
      };
      instance.__eprSvgWrapped = true;
    };
    let restoreGetAPI = null;
    if (base) {
      wrapCreateSVG(base);
      if (typeof base.getAPI === "function" && !base.__eprGetAPIWrapped) {
        const originalGetAPI = base.getAPI.bind(base);
        base.getAPI = (...args) => { const instance = originalGetAPI(...args); wrapCreateSVG(instance); return instance; };
        base.__eprGetAPIWrapped = true;
        restoreGetAPI = () => { base.getAPI = originalGetAPI; base.__eprGetAPIWrapped = false; };
      }
    }

    // Same observer shape as chrome-hider.ts's applyChromeHiding, so batch
    // counts approximate real hideAll() call frequency in this window.
    let mutBatchCount = 0, mutRecordCount = 0;
    const mutObs = new MutationObserver((muts) => { mutBatchCount++; mutRecordCount += muts.length; });
    mutObs.observe(document.body, { childList: true, subtree: true });
    const flushInterval = setInterval(() => {
      if (mutBatchCount > 0) { emit({ label: "mutation-stats-2s", batches: mutBatchCount, records: mutRecordCount }); mutBatchCount = 0; mutRecordCount = 0; }
    }, 2000);

    let lastCanvasCount = document.querySelectorAll("canvas.excalidraw__canvas").length;
    const canvasObs = new MutationObserver(() => {
      const count = document.querySelectorAll("canvas.excalidraw__canvas").length;
      if (count !== lastCanvasCount) { emit({ label: "canvas-count-change", from: lastCanvasCount, to: count }); lastCanvasCount = count; }
    });
    canvasObs.observe(document.body, { childList: true, subtree: true });

    emit({ label: "profiler-installed", title: document.title, url: location.href });

    return () => {
      offRefs.forEach((ref) => app.workspace.offref(ref));
      restoreGetAPI?.();
      mutObs.disconnect();
      canvasObs.disconnect();
      clearInterval(flushInterval);
    };
  }`
})
```

## Probe B -- the read-only prototype window

`transparent-proto.html` has no `window.app` (it's a bare HTML page, not an
Obsidian renderer) and is torn down and rebuilt on every F10 toggle, so it
needs its own probe with its own URL match:

```
obsidian_install_window_probe({
  id: "epr-perf-proto",
  urlPattern: "transparent-proto\\.html",
  installer: `(emit) => {
    emit({ label: "proto-window-script-loaded", readyState: document.readyState });
    let obs = null;
    const attach = () => {
      const viewport = document.getElementById("viewport");
      if (!viewport) { emit({ label: "proto-viewport-missing" }); return; }
      obs = new MutationObserver(() => {
        const svg = viewport.querySelector("svg");
        emit({ label: "proto-viewport-content-set", hasSvg: !!svg, childCount: viewport.children.length });
      });
      obs.observe(viewport, { childList: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach, { once: true });
    else attach();
    return () => obs?.disconnect();
  }`
})
```

## Reading results

Each matched window keeps its own independent event buffer -- `epr-perf` on
the main window is a different buffer from `epr-perf` on the editable popout,
even though they share an id. Correlate timing across windows using each
event's `timestamp`/`lastTimestamp` (wall-clock `Date.now()`, comparable
across targets) rather than `performance.now()`, which is per-renderer.

```
obsidian_list_targets                      # find each window's current targetId
obsidian_read_probe({ id: "epr-perf", targetId: "<main or popout target>" })
obsidian_read_probe({ id: "epr-perf-proto", targetId: "<proto target, if currently open>" })
```

The read-only window's targetId changes on every F10 toggle (new window, new
CDP target) -- re-run `obsidian_list_targets` after each toggle rather than
reusing a cached id.

## Cleanup

`obsidian_remove_window_probe({ id })` stops future auto-injection; it does
not retroactively strip the probe from windows already reached (use
`obsidian_remove_probe({ id, targetId })` there directly, or just disconnect
-- `obsidian_disconnect` tears down every window-probe hook and every
per-window probe buffer registered during the session).
