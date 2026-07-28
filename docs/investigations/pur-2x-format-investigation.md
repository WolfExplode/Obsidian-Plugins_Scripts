# PureRef 2.x `.pur` format — reverse-engineering notes

Working notes from reverse-engineering PureRef 2.1.0.beta4's `.pur` file format,
started per ADR 0006 (`docs/adr/0006-pur-interchange-targets-1x-format-only.md`),
which requires 2.0+ compatibility before interchange work can proceed. This
supersedes nothing yet — it's raw findings to inform a future ADR revision and
implementation.

Method: PureRef 2.1.0.beta4 is installed locally
(`C:\Program Files\PureRef\PureRef.exe`). A controlled matrix of minimal `.pur`
files was generated (empty canvas, one image, one image moved/resized, two
images, one image also saved via "Save As" in the legacy 1.x format) and
analyzed with Python scripts kept in `reference/pur2x-investigation/` (not
committed — see "Reproducing this investigation" below). The already-vendored
1.x reader/writer
in `reference/PureRef-format-main/` was used both as a structural reference and,
via its "Save As" legacy export, as a cross-reference oracle for known-good
numeric values (image position, crop bounds) in the same scene.

## Top-level container structure

A `.pur` 2.x file is **not** a single flat serialized stream like 1.x. It's a
small custom header, followed by a JPEG thumbnail, followed (eventually) by an
**embedded SQLite database** that holds the actual scene data.

```
[0:104)     custom header (see below), ends with an MD5 checksum
[104:108)   4-byte length prefix for the thumbnail JPEG (also included in checksum)
[108:...)   thumbnail JPEG (used by the Explorer thumbnail handler,
            PureRefThumbnailProvider.dll — not the canvas content)
...         more content (large full-resolution image blobs were observed
            in this region too; not yet fully mapped)
[X:EOF)     an embedded SQLite database (magic "SQLite format 3\0"), the
            real scene data
```

### Custom header (bytes 0–103)

Same overall shape as the 1.x header (magic + fixed version tag + length-prefixed
strings), just far more compact (104 bytes vs 1.x's 224):

| offset | size | contents |
|---|---|---|
| 0 | 4 | magic `u32be` = `6` (1.x used `8`) |
| 4 | 8 | fixed-width version tag, UTF-16BE, null-padded (e.g. `"2.1\0"`; 1.x used `"1.10"`) |
| 12 | 4 | zero in every sample seen |
| 16 | 4 | varies with content — **not yet decoded** (e.g. 0 for empty canvas, 12 for one image, 13 for two images; not a simple item count, needs more samples) |
| 20 | 2 | varies with content — **not yet decoded** (e.g. `0x9000` empty canvas, `0xd000`/`0xc000`/`0x9000`/`0xa000` across samples) |
| 22 | 4 | length prefix, always `10` |
| 26 | 10 | full version string, UTF-16BE, e.g. `"2.1.0"` |
| 36 | 4 | length prefix, always `64` |
| 40 | 64 | MD5 checksum of `file[104:]`, as a lowercase hex string, UTF-16BE — **confirmed** by recomputing `md5(data[104:])` and matching exactly against this field on every sample file tested |

Total header = 104 bytes. The checksum covers everything from byte 104 to EOF,
same design as 1.x's checksum (which covered `pur_bytes[108:]` under a 224-byte
header) — 2.x just shrank the fixed portion.

### Thumbnail JPEG

Right after the header, at offset 108 in every sample (header 104 bytes + a
4-byte length prefix at 104:108), sits a JPEG. Confirmed present even in an
**empty canvas** file (which has no user content at all), so this is not scene
content — it's almost certainly feeding
`C:\Program Files\PureRef\PureRefThumbnailProvider.dll`, the Windows shell
thumbnail handler installed alongside PureRef. Its byte length varies with
canvas content (417 bytes for an empty canvas, tens of KB for populated ones),
consistent with it being a rendered preview rather than fixed-size placeholder.

### The SQLite database

Located by searching for the literal SQLite magic string
`"SQLite format 3\x00"`. Present in every sample at an offset that is always an
exact multiple of the DB's own page size (4096 bytes in all samples).

**Known issue, unresolved:** the SQLite header's own `size_in_pages` field
(bytes 28:32 of the DB, big-endian u32), multiplied by `page_size`, exactly
equals the *file offset* at which the DB was found — not a plausible byte
length for the DB itself (e.g. for `OneImage_default location.pur`: DB found at
byte 839680, header claims `205 pages × 4096 = 839680` bytes, but only 33,414
bytes actually remain in the file after that offset — the header's claimed size
is ~25× larger than what's physically present). This was consistent across
every sample tested. Root cause not yet understood; two live hypotheses:

1. The field is stale/inherited from a larger in-memory working database
   PureRef trims down on save, without updating this header field.
2. Something in how the DB's start offset is located is wrong, and the true
   start is earlier — though the magic string search found only one
   occurrence per file, which argues against this.

**Working around it:** patching the `size_in_pages` header field down to
`floor(available_bytes / page_size)` and feeding the result to
`sqlite3 file.db ".recover"` (SQLite's corruption-tolerant recovery mode, not a
plain `.tables`/`SELECT`, which still errors on an invalid root page) **does**
successfully reconstruct the full schema and most row data. A plain open still
reports "malformed database schema (items_groups) - invalid rootpage", implying
some tables' B-tree pages sit beyond the truncated/available page range (likely
where large BLOB overflow pages — full-resolution image bytes — would live).

**New finding (this session), likely root cause:** re-verified directly
against all five sample files with a small probe script. Two things are true
in every sample, no exceptions:

1. `size_in_pages × page_size` (from the DB's own header) always equals `idx`,
   the absolute file offset the DB starts at — not any plausible byte length
   for the DB's own content. (E.g. `OneImage_default location.pur`: DB starts
   at byte 839680; `205 pages × 4096 = 839680`, exactly the start offset, not
   the DB's length.)
2. More importantly: `file_size − idx` (the bytes actually available for the
   DB, from its start to EOF) **always exactly equals** `108 + thumb_len`
   (header size + length-prefix + thumbnail JPEG byte length — i.e. the total
   length of the *leading* header+thumbnail block). Checked across all 5
   samples (empty canvas, one image, moved/resized, two images, Techwear) —
   exact match every time, off by zero bytes.

That second relationship is too exact to be incidental corruption. It reads
like a writer-side bug: whatever routine emits the trailing DB snapshot is
reusing a length/buffer sized for the thumbnail block, so the DB dump is
truncated to that same length regardless of how large the real database
actually is — which would also explain why `avail_bytes` is never a multiple
of `page_size` (a genuine, complete SQLite file always is one). This doesn't
yet explain where the *real*, complete database lives (in memory only? a temp
file PureRef doesn't clean up? this truncated copy is genuinely all that's
persisted and PureRef only round-trips through its own binary 1.x-like layer
data structures internally?) — that's the next thing to chase.

### Recovered schema

Identical across every multi-image sample tested (one image, two images):

```sql
CREATE TABLE images (
  id INTEGER PRIMARY KEY, source_type INTEGER, origin TEXT, source TEXT,
  format TEXT, checksum TEXT, data BLOB, width INTEGER, height INTEGER
);
CREATE TABLE metadata (
  id INTEGER PRIMARY KEY, scene_rect TEXT, application_version TEXT,
  view_transform TEXT, thumbnail BLOB, horizontal_scroll INTEGER,
  vertical_scroll INTEGER, last_save_path TEXT, last_load_path TEXT,
  last_load_checksum TEXT, saved INTEGER
);
CREATE TABLE items (
  parent INTEGER, id INTEGER PRIMARY KEY, name TEXT, transform BLOB,
  sort_order BLOB, z REAL, opacity REAL, locked INTEGER, comment INTEGER
);
CREATE TABLE items_images (
  image INTEGER, playback_speed REAL, id INTEGER PRIMARY KEY,
  playback_state INTEGER, image_transform BLOB, image_bounds BLOB,
  playback_frame INTEGER, flags INTEGER
);
CREATE TABLE items_drawings (id INTEGER PRIMARY KEY, strokes BLOB);
CREATE TABLE items_notes (
  text_color TEXT, id INTEGER PRIMARY KEY, fixed_size TEXT,
  background_color TEXT, text TEXT, style INTEGER
);
CREATE TABLE items_groups (
  id INTEGER PRIMARY KEY, background_color TEXT, lock_mode INTEGER
);
```

This is a dramatically more tractable data model than 1.x's flat serialized
stream: a normalized relational schema with a base `items` table (parent/id
tree, shared transform/z/opacity/locked fields — an obvious parallel to
Excalidraw's own element model) joined to per-type subtables
(`items_images`/`items_drawings`/`items_notes`/`items_groups`) by shared `id`.
`images` is a dedup'd content table (one row per unique source image,
referenced by `items_images.image`), matching 1.x's own duplicate-image
handling but far more directly expressed.

Confirmed recovered row data (from the two-image and one-image samples):

- `images` gets one row per unique source file: `id`, `source_type` (`1` seen,
  meaning unknown), `origin`/`source` (both the absolute source file path in
  samples), `format` (`"PNG"`, `"JPG"` — the *original* format, unlike 1.x
  which force-converts everything to PNG), `checksum` (MD5 hex of source
  bytes, matches 1.x's own per-image checksum concept), `data` (BLOB — empty
  in our recovered dump only because of the page-truncation issue above, not
  because it's actually unused).
- `metadata` gets exactly one row: `application_version` (`"2.1.0.beta4"`),
  `scene_rect`/`view_transform` (TEXT, empty in our dump — likely JSON or a
  serialized string, not yet decoded), `thumbnail` BLOB, scroll position
  ints, save/load path bookkeeping.
- `items` gets one row per placed element: `parent=-1` (top-level), `name`
  (e.g. `"reference image"` — matches 1.x's per-image `name` field), `z`,
  `opacity`, `locked`; `transform`/`sort_order` BLOBs not yet decoded (empty
  in our truncated dump).
- `items_images` gets one row per image instance (not per unique image — this
  is how the same source image could appear multiple times on the canvas,
  same concept as 1.x's duplicate-transform handling): `image` FK into
  `images.id`, `playback_speed`/`playback_state`/`playback_frame` (video/gif
  playback — new versus 1.x), `image_transform`/`image_bounds` BLOBs not yet
  decoded, `flags`.

## Open questions / not yet decoded

- The `transform`, `sort_order`, `image_transform`, `image_bounds`,
  `scene_rect`, `view_transform` BLOB/TEXT columns — these almost certainly
  hold the position/scale/rotation/crop data 1.x stored as raw doubles, but
  their encoding (JSON? a nested Qt stream? a packed binary struct?) isn't
  decoded yet. This is the next concrete step, and needs a *working* full
  extraction (not one truncated by the `size_in_pages` mismatch) to get
  non-empty sample values to decode against the known-good legacy-format
  cross-reference values (e.g. image at x=122, y=78, crop half-extents
  ±471/±488.5, recovered via `reference image.png`'s legacy 1.x sibling
  export).
- Header bytes 16:20 and 20:22 (see table above) — vary with content but
  don't match a simple item-count hypothesis.
- The real byte boundary/purpose of the large blob region between the
  thumbnail JPEG and the SQLite database (observed to contain what looks like
  a second, larger JPEG per image) — probably the full-resolution image data
  that `images.data` should logically reference, possibly stored out-of-line
  from the BLOB column for performance (consistent with ADR 0006's "changed
  for save/load performance" note) rather than inline in SQLite.
- The `size_in_pages` mismatch itself — needs an actual valid, complete
  extraction (or a hex editor pass against a real un-truncated case) to
  confirm which hypothesis (stale header vs. wrong start offset) is correct.
  **Update:** now believed to be a writer-side bug — see the
  "New finding" note above; `size_in_pages × page_size` consistently equals
  the DB's start offset, and the trailing DB chunk's available length
  consistently equals the leading header+thumbnail block's length, in every
  sample tested.

## Next steps

1. ~~**Test whether the leading/trailing length-match holds at larger
   scale.**~~ **Done — confirmed.** Tested against a 74-image, 116MB sample
   (`samples/large pureref file/LotsOfImages.pur`, built from the source
   images in the sibling `the images inside the pureref file/` folder). Both
   invariants hold exactly at this scale too (`size_in_pages × page_size ==
   idx`; `file_size − idx == 108 + thumb_len`, 38086 bytes either way) — not a
   small-sample coincidence. The gap region also contains exactly 74 PNG
   signatures, matching the 74 source images 1:1 — strong confirmation the
   gap region holds one raw full-resolution image blob per placed image,
   separate from the SQLite `images.data` column.

   **More important finding from this sample:** running `.recover` against
   the (patched, still-truncated) trailing chunk yields **only the schema and
   a single near-empty `metadata` row — zero rows in `images`, `items`,
   `items_images`**, unlike the small 1-2 image samples where `items`/`images`
   rows *did* survive. This means the earlier successful recovery of row data
   was a lucky accident of scale: the trailing chunk is capturing a *fixed
   byte budget* (tied to thumbnail size) starting from the DB's page 1, and
   for any real, populated scene that budget is nowhere near enough to reach
   the actual data pages. **Static recovery from the persisted `.pur` file
   alone cannot reach item data for realistic scenes** — this makes finding
   the real, untruncated database (next step) the actual blocker, not
   decoding the BLOB columns.
2. ~~**Find where the real, untruncated database lives.**~~ **Solved.**
   Captured a real save with Process Monitor (Sysinternals; filtered to
   `PureRef.exe`, exported to CSV, analyzed with `csv`/regex in Python — see
   `scripts/` for the analysis one-offs, not checked in as they were
   throwaway). Findings:
   - PureRef saves via a same-directory staging file named
     `<target>.<pid>.pur` (e.g. `LotsOfImages.6668.pur`), complete with real
     SQLite `-wal`/`-journal` sidecars — this is a genuine live SQLite
     database, not a snapshot. It gets renamed (`SetRenameInformationFile`,
     `ReplaceIfExists: True`) directly onto the target `.pur` path at the end
     of the save. No separate "container assembly" step — the final `.pur`'s
     bytes past the header+thumbnail **are** this staging file's bytes,
     copied in sequential ~1MB `WriteFile` calls.
   - **PureRef also keeps a full AutoSave copy that is never renamed away:**
     `%TEMP%\PureRef\<hash>_AutoSave.pur`. Checked it directly — it **is a
     complete, valid, standalone SQLite database** (`SQLite format 3\0` at
     byte 0, size an exact multiple of `page_size`, opens with a plain
     `sqlite3.connect()`, no patching). Against the 74-image sample it has
     **74 rows each in `images`, `items`, `items_images`** — real, complete
     row data, not a fragment. Confirmed with the new
     `scripts/open_autosave.py` helper.
   - This resolves the truncation mystery pragmatically: the trailing chunk
     in a *saved* `.pur` file is a real but partial (page-1-only) copy of
     this same database — apparently intentional (maybe a
     shell-property/consistency stub), not something we need to fix. **For
     reverse-engineering purposes, read `%TEMP%\PureRef\*_AutoSave.pur`
     directly instead of the saved `.pur`'s embedded chunk.** Whether a
     11.x-compatible reader needs to reconstruct full data from a
     *distributed* `.pur` file (which only has the truncated chunk) is a
     separate, still-open question — see below.
3. ~~**Decode `transform`/`sort_order`/etc.**~~ **Started.** Reading them via
   `sqlite3` requires `con.text_factory = bytes` — SQLite's manifest typing
   means these are stored as `TEXT` storage class despite the `BLOB` column
   declaration, so Python's default `str` decoding silently mangles them via
   lossy UTF-8 (bytes come back full of `�` replacement chars otherwise;
   the *stored* bytes are not corrupt, only the naive read path is).
   Real captured values:
   - `items.sort_order` (44 bytes) contains the literal ASCII tag
     `"BigRational\0"` — PureRef stores item stacking order as
     arbitrary-precision rational numbers, the standard "fractional
     indexing" trick that lets an item be inserted between any two
     neighbors indefinitely without renumbering siblings. Encoding looks
     like a small type-tagged binary format (length-prefixed tag string,
     then big-endian integer fields) — plausibly Qt's `QVariant`/custom
     stream format rather than JSON. Not yet fully decoded field-by-field.
   - `items.transform` (84-85 bytes) — a fixed-ish-size binary blob, starts
     `00 00 00 50 00 3f c3 b0 ...`. Not yet decoded; needs the known-good
     legacy 1.x cross-reference values to check against.
4. ~~**Decode `transform`/`image_bounds` against the known-good
   cross-reference.**~~ **Started, confirmed real.** Opened
   `OneImage_default location.pur` in PureRef and let AutoSave regenerate a
   fresh, complete copy (`%TEMP%\PureRef\<hash>_AutoSave.pur`, 839680 bytes —
   note this exactly equals the truncated sample's `idx`, another data point
   supporting the "size_in_pages describes a real, correctly-sized source
   database" reading). Scanning `items.transform` and `items_images.
   image_bounds` for plausible float64 (big-endian) values found real
   position/size data:
   - `transform`: an 8-byte-aligned double at byte offset 56 = **123.04**,
     and at offset 64 = **79.04** — matches the known-good x=122, y=78
     within ~1 unit (plausibly a coordinate-origin/rounding difference
     between the legacy 1.x export and 2.x's native placement, not a
     misread — the match is far too close to be coincidence).
   - `image_bounds`: doubles **471.0** and **492.16**, each repeating at a
     fixed +22-byte stride (i.e. appearing twice, 22 bytes apart) — 471.0
     matches the known half-width exactly (source image is 942px wide,
     942/2=471). 492.16 is close to but not exactly the expected half-height
     488.5, likely a slightly different crop/fit on this particular
     placement rather than a decode error. The +22-byte repeat is
     consistent with a serialized list of corner points (rectangle = 2
     unique corners, each logged twice for redundancy, or 4 corners with
     shared x/y) — ties back to the `"PainterPath\0"` tag already found
     inside this same blob (a Qt `QPainterPath`-style serialization).
   - Not yet fully mapped: the exact byte layout before/around these
     doubles (type tags, counts, the `"BigRational"`/`"PainterPath"` header
     format itself byte-by-byte). Doubles were found by brute-force
     scanning every byte offset for a plausible float64, not by parsing the
     container format - good enough to confirm the data is real and roughly
     where expected, not yet a real decoder.
5. **Next concrete step:** properly parse the Qt-style tagged binary
   container (tag-string header, then fields) instead of brute-force
   scanning for doubles - this is what's needed to reliably read arbitrary
   scenes rather than eyeballing byte offsets per sample. Once the container
   format is known, cross-check the `OneImage_moved_resized.pur` /
   `twoImages.pur` samples (regenerate their own fresh AutoSave copies the
   same way) to confirm the byte offsets generalize rather than being
   coincidental to this one scene.
6. **Ruled out: the truncation is not a "PureRef is still open" artifact.**
   Hashed `OneImage_default location.pur` (873094 bytes,
   md5 `ca435657dd2ea25c542e08f3c029041c`) before quitting PureRef entirely
   (not just closing the document - a full app exit), then re-hashed after:
   **byte-for-byte identical.** Quitting does not trigger any deferred
   checkpoint/compaction write to the saved file. Additionally, on clean
   exit PureRef deletes its `%TEMP%\PureRef\` working directory entirely
   (AutoSave copy, imagecache, lock file all gone) - so the one place we
   found complete data doesn't survive a normal quit either.

   **Conclusion:** the truncated file *is* PureRef's final, permanent output
   for a saved `.pur`, not an in-progress state. A `.pur` file a user
   actually shares - saved normally, app closed normally - structurally
   cannot have its `items`/`images`/`items_images` rows read back by static
   parsing for any non-trivial scene. This is not a decoding gap to close
   with more reverse-engineering; the bytes for that data are simply absent
   from the file. The only complete-data path found so far (PureRef's own
   live AutoSave file) requires PureRef to be installed, running, and to
   have the document open on the same machine - not viable as a general
   import path for a plugin.

   This has a direct bearing on ADR 0006 (`docs/adr/0006-pur-interchange-
   targets-1x-format-only.md`): the 1.x-only scoping is likely not just "not
   yet implemented" but may need to stay in place for a structural reason,
   pending confirmation of whether this holds across non-beta PureRef
   releases and whether any PureRef save option (e.g. an "optimize"/"pack"
   toggle, if one exists) changes this behavior.

   **Still open, pending cross-check:** all of the above shows *my current
   extraction method* (locate the magic string, read to EOF) can't get
   complete data from the saved file. It does not yet prove PureRef *itself*
   can't either. If PureRef, given nothing but this same saved file on a
   clean machine (no leftover temp/AutoSave), reopens the scene with correct
   positions, the data must exist somewhere in the file's bytes - just not
   where/how this investigation has been looking - and this would flip back
   from "structurally impossible" to "not yet located." Test in progress:
   transferring a saved `.pur` to a different computer and checking whether
   the board is preserved on open.

7. **PureRef has a real, documented CLI** (Qt `QCommandLineParser`-based -
   run `PureRef.exe --help` or `--command-help`), discovered by extracting
   printable strings from `PureRef.exe` and grepping for command-line-shaped
   text. Notably:
   - `--brute-force <.pur path>`: *"Brute force open .pur file without any
     metadata. This can be used to recover images from a partially corrupt
     .pur file."* - built for approximately our scenario; not yet tried.
   - `--restore`: *"Restores and takes ownership of autosaved file."* - an
     official, documented interface to the same crash-recovery/temp file
     this investigation has been reading by hand as `%TEMP%\PureRef\
     <hash>_AutoSave.pur`. Confirms that file isn't an accident we
     stumbled on; it's a first-class recovery mechanism.
   - `-c`/`--command '<name>;<arg1>;<arg2>...'` (repeatable) plus
     `--command-help` to list them. Full set, from a live
     `PureRef.exe --command-help` run:
     - `load;<paths>[;X][;Y]` - open file(s), optionally placing images at
       given coordinates.
     - `save;<path>` - save the current scene. **Tested: requires the
       target path to already exist** (fails with "could not open file for
       save... system cannot find the file specified" against a brand-new
       path; works once the path is pre-touched/exists).
     - `exportImages;<output dir>[;cropping][;name override]` - exports
       every image in the scene as individual PNGs, with cropping applied
       - i.e. PureRef will do the crop-decoding for us and hand back plain
       image files, no `image_bounds` decoding required, if per-image
       content (not canvas position) is what's needed.
     - `exportScene;<path>[;width][;height][;bg][;borders][;children]` -
       flattens the whole scene to a single raster image.
     - `clearScene`, `exit[;code]`.
     - Example from the app itself: `PureRef -c 'load;example.pur' -c
       'exportScene;D:/example.png;1000;1000;false' -c 'exit'`.
   - **Tested: CLI-triggered `save` produces the byte-identical truncated
     structure to an interactive GUI save** (same `idx`, same invariants,
     confirmed with `probe_structure.py` against a CLI-driven resave of
     `OneImage_default location.pur`). So scripting `load`+`save` is a real,
     fully headless automation path, but it does not sidestep the
     truncation - it's the same internal save routine either way.
   - Other CLI options found via string search but not scene-data-related:
     `--print-settings`, `--print-keybindings`, `--print-errors`,
     `--settings`, `--setting`, `--logfile`, `--debug-log` - confirm the CLI
     surface is large.

8. **PIVOTAL: cross-machine test confirms the full data is really in the
   saved file.** Transferred a saved `.pur` to a different computer (no
   leftover temp/AutoSave from this machine could be involved) and opened it
   in PureRef there: **the entire board - images, crops, transforms,
   positions - was preserved correctly.** This overturns the "structurally
   impossible" reading from item 6 above: PureRef itself can fully
   reconstruct the scene from nothing but the saved file's bytes. The
   complete data is somewhere in the file - this investigation's own
   extraction method (locate the magic string, read to EOF, patch
   `size_in_pages`, run `.recover`) has been finding the right region but
   not correctly reading it, not proving the data absent. Items 9-11 below
   dig into why.

9. **Tested `--brute-force` and `--restore`.**
   - `--brute-force <path>`: on our (actually complete) sample it behaves
     like a normal open - 1 row everywhere, as expected, since there's
     nothing corrupt to brute-force around. Its purpose is for genuinely
     damaged files; doesn't teach us anything new about this investigation.
   - `--restore <original-path>`: **destructive - takes this literally.**
     Simulated a crash (launched PureRef with a file open via
     `run_in_background`, confirmed its `%TEMP%\PureRef\<hash>_AutoSave.pur`
     existed, then force-killed the process to leave the recovery file
     orphaned). Running `PureRef.exe --restore <original .pur path>`
     **immediately deleted the original file at that path** and opened a
     new session (fresh hash, fresh temp dir) holding the recovered content,
     without prompting or writing a replacement first. The scene data
     itself survived intact in the new session's own AutoSave copy - we
     recovered our test sample by loading that raw AutoSave file via
     `-c "load;..."` and `-c "save;<original path>"` to recreate it
     byte-for-byte equivalent (verified with `probe_structure.py` - same
     size, same offsets, same invariants) - but **never run `--restore`
     against a file without a separate backup.** This should be documented
     as a hazard if it's ever wrapped in tooling.
   - `--debug-log --logfile <path>` combined with a normal `load`: only
     logged `Loading '<path>', took(ms): 45` - confirms a fast, successful
     load but no internal detail about *how* (no SQL trace, no byte
     offsets). Not useful for this investigation at this verbosity level.

10. **Found why `.recover` looked like it was returning "no data":
    over-conservative validation, not absent bytes.** Re-ran `.recover`
    against the real (truncated, distributed) `OneImage_default
    location.pur`'s own tail chunk - not the AutoSave copy - properly this
    time (previous attempts predate the `text_factory=bytes` fix). Result:
    `.recover` *does* reconstruct `items`/`images`/`items_images` rows, but
    every `transform`/`sort_order`/`image_transform`/`image_bounds` value
    comes back empty (`X''`), and `images.width`/`height` come back `0`
    despite the checksum/path fields being correct. These blob values are
    only ~85-145 bytes - far below the ~4KB threshold where SQLite would
    ever spill a value to an overflow page - so this isn't an overflow-page
    truncation issue. Likely explanation: `.recover`'s conservation-tolerant
    mode is defensively blanking values it can't fully re-verify, given the
    database has `auto_vacuum='1'` and our patched `size_in_pages` doesn't
    match what its pointer-map structure expects.
11. **Root cause of the schema-validation failure, and the next concrete
    step.** A *plain* `SELECT`/`PRAGMA integrity_check` against the same
    (patched) tail chunk - no `.recover`, just normal `sqlite3`/Python
    `sqlite3.connect()` - fails immediately with `malformed database schema
    (items_groups) - invalid rootpage`, before even reaching `items` or
    `images`. `items_groups` is empty (0 rows) but still has a schema entry
    with a rootpage pointer, and that pointer is beyond the pages our
    truncated extraction has available - so SQLite's schema validation
    refuses to open the database at all, for any table, even ones whose
    own pages are perfectly intact.
    **Next concrete step:** parse the schema page (page 1) directly, find
    `items_groups`' `CREATE TABLE` schema row and its serialized rootpage
    integer, and patch that one value in place (e.g. to point at any valid
    in-range page) so plain `SELECT`s can proceed against the tables that
    matter (`items`, `images`, `items_images`) without `.recover`'s
    defensive blanking getting in the way. If this works, it would mean the
    distributed `.pur` file's own truncated tail chunk - no AutoSave, no
    live PureRef instance, no `--restore` - is fully readable after one
    small, mechanical, well-understood binary patch. That would be the
    actual unlock for a real static reader.

12. **Done - `scripts/patch_schema.py`, and a second, bigger finding: the
    "empty blob" appearance was itself a measurement artifact, not real data
    loss (at least for scenes that fit the tail chunk's byte budget).**

    First, repointing a dangling rootpage at some other in-range page (tried
    page 1 itself, then page 2) doesn't work - both attempts still failed
    with `malformed database schema`, because these are `auto_vacuum`
    databases: page 1 is the schema page and page 2 is always a reserved
    pointer-map page, and every other in-range page is already claimed as
    some other table's own rootpage. There is no spare, correctly-typed page
    to redirect a dangling pointer to.

    What does work: parse page 1's cell array by hand (no `sqlite3` module -
    `sqlite3.connect()` fails before you'd get the chance) and **remove the
    cell pointer for any schema row whose rootpage exceeds the number of
    whole pages actually present**, rather than trying to fix it. This is a
    generalization beyond just `items_groups` - the exact set of tables that
    end up dangling depends on how many whole pages the tail chunk's fixed
    byte budget happens to cover for a given file (see below). Dropping a
    cell pointer just erases that one `CREATE TABLE` statement from the
    schema, as if it never existed; the now-unreferenced cell bytes are left
    in place in the page, harmlessly. Confirmed this makes a plain
    `sqlite3.connect()` succeed where it previously raised `malformed
    database schema (<table>) - invalid rootpage` immediately on open.

    Second, and more important: once the database opens, **`items.transform`
    and `items.sort_order` are not actually empty** - `SELECT
    length(transform) FROM items` reports `0`, matching every prior
    observation in this doc (both the `.recover`-based read in item 10 and
    naive `sqlite3` CLI probing here), but that `0` is wrong. Verified
    directly: `sqlite3 :memory: "SELECT length(CAST(X'00000050...' AS
    TEXT))"` also reports `0` even though `hex()` on the same value returns
    every byte. **SQLite's `length()`/default string handling silently
    stops at the first embedded `0x00` byte when a value's storage class is
    TEXT** (manifest typing: these columns are declared `BLOB` but stored
    with an odd/TEXT serial type - see item 3 - and this data's first two
    bytes are `00 00`), even though the value's actual stored bytes are
    completely intact past that point. Reading the same row via Python's
    `sqlite3` module with `con.text_factory = bytes` (already known-needed
    per item 3, just not previously applied *after* getting a working
    connection) or via `hex()` in the CLI returns the **full, correct**
    82-byte `transform` and 53-byte `sort_order` blobs for the one populated
    `items` row in `OneImage_default location.pur`'s own truncated,
    distributed tail chunk - byte-for-byte the same values item 4 previously
    had to regenerate a live AutoSave copy to see. No AutoSave needed after
    all, for this sample. Same result for `items_images.image_transform`
    (83 bytes) and `.image_bounds` (145 bytes, `"PainterPath"` tag and all).

    Third, this does **not** overturn item 1's "fixed byte budget" finding -
    re-ran the same recipe against `twoImages.pur` and the budget for that
    file only covers 3 whole pages (vs. 8 for the one-image sample; the
    budget is `108 + thumbnail_len`, essentially arbitrary relative to how
    much real content there is - see item 1/8's `size_in_pages` discussion).
    At that budget, `items`/`items_images`/`metadata`/`items_drawings`/
    `items_notes`/`items_groups` are *all* dangling and get dropped, leaving
    only the `images` schema - and even `images`' own row data turns out to
    still be out of range (`invalid page number` on its own overflow pages),
    so nothing usable survives for that file. **The corrected takeaway:**
    the earlier "empty blob" observations were measured wrong, but the
    underlying budget-truncation problem is exactly as real and as
    unpredictable as items 1/8 found - whether a given saved `.pur` happens
    to carry complete geometry data for its own scene is dumb luck tied to
    thumbnail size, not something a reader can rely on. The AutoSave/live-
    PureRef path (item 2) remains the only *reliable* route to complete
    data for an arbitrary scene; `patch_schema.py` + `text_factory=bytes`
    is a real improvement for whatever *does* happen to fit the budget, not
    a general fix for the truncation itself.

13. **Tested whether the gap region (item 1/8's "one full-resolution image
    blob per placed image") can be carved directly, as a simpler alternative
    to the SQLite truncation problem. It cannot, at least not without more
    reverse-engineering than initially assumed.** Tested against the
    74-image `LotsOfImages.pur` sample, cross-checked against `exportImages
    --command 'exportImages;<dir>;false'` run via the CLI (confirmed
    ground truth first: 72/74 exported files are byte-identical to the
    original sources; the 2 mismatches are filename collisions, not
    extraction failures — so the CLI export path is fully trustworthy as an
    oracle).

    - The gap region does carry real per-image metadata in cleartext
      immediately before each image's raster signature: `origin` path,
      `source` path (both, duplicated back-to-back), a format tag
      (`"PNG"`/`"JPG"`), and a 32-hex-char MD5 checksum — directly matching
      the `images` table's columns. This confirms the gap region is a
      sequential dump of `images` table rows, in insertion order.
    - Naive carving (find a raster signature, text-search for the next
      `IEND`/JPEG EOI marker) only recovered 53 of 74 images. The other 21
      signature occurrences turned out to be real, distinct per-image
      metadata headers (each with its own valid-looking origin/checksum
      text) whose image data has no findable `IEND` before the next header
      starts — i.e., naive text-search skips over real entries by matching
      a much later `IEND` instead of not matching one that exists nearby.
    - The 53 "successfully" carved images do **not** hash-match any of the
      74 known-good source files, and Pillow's `Image.open().load()` fails
      on them ("unrecognized data stream contents"), despite each carved
      slice's byte length matching where a text-search-based `IEND` was
      found.
    - Diagnosed why: walking the PNG chunk structure *properly* (reading
      each chunk's own 4-byte big-endian length field, per spec, rather
      than text-searching for `IEND`) breaks down after exactly one `IDAT`
      chunk of length `32768` (`0x8000`, suspiciously round) — the chunk
      that should follow at the computed offset is garbage, not a valid
      chunk type/length. This means the bytes are not stored as
      spec-compliant PNG chunk streams, despite starting with a genuine PNG
      signature and being immediately preceded by correct per-image
      metadata (path/format/checksum) — something is re-chunking, wrapping,
      or interleaving the raw image bytes with other framing at (or beyond)
      each 32KB boundary, not yet identified. A tried-and-failed no-length-
      prefix / delimiter-based per-record framing search (looking for a
      stable byte marker between one image's data and the next header) also
      came up empty — the bytes that looked like a stable marker between
      two adjacent tiny sample images turned out to encode
      image-size-dependent fields (varint-style), not a fixed delimiter.
    - **Conclusion: carving from the gap region is not the "simple
      alternative" it looked like from the item 1/8 count-matching finding
      alone.** The 1:1 signature-count match is real, but the bytes
      following each signature are wrapped in an unidentified
      encoding/framing layer, not plain PNG/JPEG data. Recovering images
      from here would require reverse-engineering that wrapper first — a
      materially bigger task than initially scoped, and not yet started.
    - This does not change the SQLite-side conclusion from items 1/8/12:
      that route is separately blocked by the fixed-byte-budget truncation,
      and — worth being precise about — was never actually confirmed to
      reach `images.data` itself (the real image bytes) for *any* sample,
      only the much smaller `items.transform`/`items_images.image_bounds`
      blobs. Whether `images.data` survives the budget for a trivial
      (single-image) file is still an open, untested question.
    - **Net effect on ADR 0006 scoping:** as of this session, there is no
      confirmed, general, static-parsing-only path to recover image bytes
      from an arbitrary saved (distributed) 2.x `.pur` file. The only fully
      confirmed reliable path remains PureRef's own CLI/AutoSave, which
      requires a local PureRef installation — not viable for a plugin
      import feature. 2.x image extraction should stay out of scope until
      one of the two open threads above (the gap-region wrapper, or
      whether `images.data` survives the SQLite truncation budget for
      small scenes) is actually resolved.

14. **Resolved the second open thread — `images.data` does not survive the
    truncation budget even for the smallest possible file, closing off the
    SQLite route entirely.** Tested against `OneImage_default location.pur`
    (single image, simplest non-empty case): `extract_sqlite.py` +
    `patch_schema.py` (dropping only the always-dangling `items_groups`
    schema row, same as every prior sample) produces an 8-page (32768-byte)
    database that opens cleanly enough to `SELECT * FROM items` and `SELECT
    * FROM items_images` without error — confirming again (per item 12) that
    `transform`/`sort_order`/`image_transform`/`image_bounds` are readable.
    But `SELECT * FROM images` and `SELECT * FROM metadata` both fail with
    `database disk image is malformed`. `PRAGMA integrity_check` pinpoints
    why: `images`' own B-tree (rootpage 3) references overflow page **198**
    for its `data` BLOB payload, and `metadata`'s single row (rootpage 4)
    references overflow page **10** for its `thumbnail` BLOB — both far
    beyond the 8 whole pages this truncated extraction actually has. Unlike
    `items_groups`' dangling *rootpage* (a schema-level problem, patchable
    by dropping one cell), this is a dangling *overflow-page pointer* deep
    inside the `images` row's own payload — there is no equivalent
    "drop the row from the schema" fix available, because the row's cell
    itself is what's malformed, not a schema pointer to it. The image bytes
    for `id`/`source_type`/`origin`/`source`/`format`/`checksum` (all
    inline, small columns) are technically parseable if you skip
    `sqlite3.connect()` and hand-parse the cell like `patch_schema.py`
    already does for the schema page — but `data`/`width`/`height` are not,
    for literally the simplest possible scene.

    **This closes off the SQLite-chunk route as a general solution,
    definitively:** even a one-image file's actual image bytes are not
    reachable via the distributed `.pur`'s truncated tail chunk, no matter
    how small the scene. Combined with item 13's gap-region carving being
    blocked by an unidentified wrapper format, **there is currently no known
    static-parsing path, at any scene size, to recover a placed image's
    actual pixel bytes from a saved 2.x `.pur` file.** The only two working
    paths (PureRef's own AutoSave file, or its CLI export) both require a
    local, running PureRef installation on the same machine — not usable as
    a general plugin import feature. Barring a breakthrough on the gap-
    region wrapper (item 13), 2.x `.pur` image import is not achievable with
    the current approach; ADR 0006's 1.x-only scoping should stay in place.

## Reproducing this investigation

Reusable tooling and sample files live in `reference/pur2x-investigation/`
(gitignored — `reference/` is vendored/scratch material, not committed —
so treat this as a persistent local workspace, not repo history):

```
reference/pur2x-investigation/
  scripts/
    header.py           # parse + checksum-verify the 104-byte custom header
    extract_sqlite.py   # pull the trailing SQLite chunk out, patched size_in_pages
    patch_schema.py     # drop any schema row whose rootpage is out of range, so a
                         # plain sqlite3.connect() (not just .recover) can open the
                         # extracted chunk - run after extract_sqlite.py. Read results
                         # with con.text_factory = bytes / hex(), not length() or str
                         # (length() silently truncates TEXT-storage-class blob columns
                         # at their first embedded 0x00 byte - see step 12)
    probe_structure.py  # the leading/trailing-length invariants + gap scan (see above)
    open_autosave.py    # find + open PureRef's live %TEMP%\PureRef\*_AutoSave.pur
                         # (a complete, untruncated DB - prefer this over the
                         # saved .pur's own truncated trailing chunk)
  samples/               # the matrix of minimal .pur files generated from PureRef
```

Regenerate or extend the sample matrix directly from PureRef 2.1.0.beta4
(`C:\Program Files\PureRef\PureRef.exe`, installed locally) — empty canvas,
one image, one image moved/resized, two images, and a "Save As" legacy 1.x
export of the same scene are the current set. `sqlite3` CLI (with `.recover`
support) and Python 3 with only the standard library are sufficient tooling.
