# Toodly — Project Notes

A Chrome extension where completing to-do tasks reveals dots on a mosaic made from your own photo. No backend, no accounts, no bundler — the extension loads unpacked straight from the folder. The same UI also runs as a hosted web widget that can be embedded in Notion.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Extension API | Chrome Manifest V3 | Required for modern Chrome; enforces service-worker background, stricter CSP |
| Storage | Context-aware adapter in `lib/storage.js` | `chrome.storage.local` in extension context (10 MB, no quota pain); `localStorage` in widget context. One file, same API surface, detected at runtime. |
| UI | Vanilla JS ES modules | Zero build step; panel and widget load `<script type="module">` directly |
| Rendering | Canvas 2D API | Lets us draw and update the dot-grid without any charting library |
| Isolation | Shadow DOM (closed) | Prevents host-page CSS bleeding into or out of the floating character button |
| Fonts | System monospace stack | Avoids loading external fonts from within extension pages (CSP restriction) |
| Icons | System.Drawing PNGs | Generated via PowerShell; easily swappable |

No npm, no webpack, no TypeScript, no framework.

---

## File Structure

```
toodly/
├── manifest.json              Chrome extension manifest (MV3)
├── background.js              Service worker — opens side panel, relays messages
├── CLAUDE.md                  Standing instructions for Claude Code sessions
├── content/
│   └── character.js           Floating button injected into every page
├── panel/
│   ├── panel.html             Side panel shell (also shared by widget via relative import)
│   ├── panel.css              All panel styles (shared by widget)
│   └── panel.js               Panel logic — tabs, todo list, mosaic view (shared by widget)
├── lib/
│   ├── storage.js             Unified storage adapter — chrome.storage.local or localStorage
│   ├── sections.js            Pure functions: section membership, sorting
│   ├── imageProcessor.js      Photo → dot-map conversion
│   └── mosaicRenderer.js      Canvas renderer shared by upload preview and live reveal
├── widget/
│   └── widget.html            Standalone HTML shell for the Notion embed
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## Architecture — How the Pieces Connect

```
Toolbar click / character button click
        │
        ▼
  background.js  ──── chrome.sidePanel.open() ────▶  panel/panel.html
        │                                                    │
        │  TOODLY_OPEN_PANEL (runtime message)               │
        ◀────────────────────────────────────────  content/character.js
                                                            ▲
                                                            │ TOODLY_TASK_COMPLETED
                                                      panel/panel.js
                                                            │
                                                      lib/storage.js
                                                      (isExtension?)
                                                     /             \
                                          chrome.storage.local   localStorage
                                                      │
                                         lib/imageProcessor.js
                                         lib/mosaicRenderer.js
                                         lib/sections.js

Notion embed path:
  widget/widget.html
        └── panel/panel.js  ← same file, isExtension = false → localStorage branch
```

The panel and widget share all logic. `lib/storage.js` is the only file that branches on context. The character script never reads storage — it only sends and receives messages.

---

## Permissions

```json
"permissions": ["storage", "sidePanel"]
```

Complete list. No `identity`, no `tabs` (querying the active tab works without it in MV3), no host permissions for any external API.

**`<all_urls>` content script scope** — the character button needs to appear on every page, so the content script matches all URLs. This is the widest possible scope and the line Chrome Web Store review will scrutinise. It is inherent to the concept, not an oversight.

---

## Storage Design

All reads and writes go through `lib/storage.js`. Nothing else touches the underlying store directly.

### Context detection

```js
export const isExtension =
  typeof chrome !== 'undefined' && chrome?.storage?.local != null;
```

In extension pages this is always `true`. In a web page (including the Notion widget iframe) `chrome.storage` is not available, so it falls back to `localStorage` with a `toodly_` namespace prefix to avoid key collisions. Both paths use short key names (`todos`, `mosaic`) and fire the same payload shape so `panel.js` uses one identical `handleStorageChanged` handler in both contexts. In the extension, `chrome.storage.onChanged` fires automatically. In the widget, `lib/storage.js` dispatches a synthetic `toodly:changed` CustomEvent that carries the same `{ changes: { [key]: { newValue } } }` structure.

### Keys

| Key | Extension area | Widget | Contents |
|---|---|---|---|
| `todos` / `toodly_todos` | `chrome.storage.local` | `localStorage` | Array of todo objects |
| `mosaic` / `toodly_mosaic` | `chrome.storage.local` | `localStorage` | Full mosaic state |

### Todo shape

```js
{
  id: string,              // crypto.randomUUID()
  title: string,
  completed: boolean,
  completedAt: number | null,  // timestamp ms; null when incomplete
  listId: 'default',
  source: 'local',         // reserved for future Google Tasks sync (Phase 2 seam)
  date: string | null,     // 'YYYY-MM-DD' or null (undated)
  time: string | null,     // 'HH:MM' or null; always null when date is null
  manualOrder: number,     // tiebreaker within a tied (date, time) group
  starred: boolean,        // priority flag — sorts above non-starred within section
}
```

### The single re-render trigger

`chrome.storage.onChanged` (or the synthetic `toodly:changed` event in the widget) is the only thing that calls `renderTodos()`. Handlers write to storage and stop — they never mutate local state or call render themselves. This eliminates the race condition where an optimistic local push and an `onChanged` callback both render the same new todo and briefly show a duplicate.

---

## Sections and Sorting (`lib/sections.js`)

All section logic is pure — no storage access, no side effects.

### Today vs Archive

A todo belongs to **Today** if it has no date, or if its date is today or in the future. A todo belongs to **Archive** if its date is strictly in the past. These are two computed views over the same flat array, recomputed fresh on every render. Section membership is never stored.

This was a deliberate choice over maintaining two separate stored lists. Stored sections would mean a task crossing midnight would silently stay in Today until the app next ran reconciliation logic. Recomputing from the date field means the view is always correct as long as `renderTodos()` runs — which it does on every storage change and every 3 minutes via `setInterval` to catch day rollover while the panel is open.

`getTodayDateString()` returns `YYYY-MM-DD` in the user's **local timezone**, not UTC. `toISOString()` returns UTC and would misclassify tasks near midnight in most timezones, so it is deliberately not used.

### Sort order

`sortTodos()` applies a four-level hierarchy:

1. **Starred** — starred tasks always float above non-starred within their section
2. **Date** — chronological; `null` (undated) sorts before any date string, so undated tasks appear first
3. **Time** — chronological within a date; `null` sorts before any time
4. **`manualOrder`** — tiebreaker within an exact `(date, time)` bucket

`manualOrder` is a tiebreaker only, never a primary sort key. It resolves ordering within a "tied group" — tasks that share the same `(date, time)` pair (including the all-`null` undated group). This means drag-and-drop reordering only makes sense within a tied group, which also implicitly means you can never drag a task from Today into Archive or vice versa — the groups don't overlap.

---

## Todo Features

### Date and time

Each todo optionally carries a `date` and `time`. Both are set via native `<input type="date">` and `<input type="time">` pickers (not text inputs) — the browser handles formatting, validation, and the calendar/time UI. The pickers are hidden behind a `+ date` toggle to keep the add form minimal for the common case.

Time requires a date; clearing date also clears time. This is enforced in `addTodo()` and `setTodoDateTime()` in `lib/storage.js`.

### Drag-and-drop reorder

Drag handles are on every `<li>` (via the `draggable` attribute). Dragging is only permitted within a tied group — tasks with different `(date, time)` pairs are not drop targets for each other. This is checked in `handleDragOver` by comparing the dragged item's `(date, time)` against the target's.

On drop, `reorderTiedGroup(orderedIds)` receives the full group's IDs in the new desired order and rewrites each task's `manualOrder` to `0, 1, 2, …` in one storage write. Rewriting the whole group (not just swapping two values) prevents `manualOrder` values from drifting out of sync across separate edits over time.

### Star / priority

The `starred` boolean field on each todo is toggled by `toggleStar(id)`. Starred tasks sort to the top of their section (Today or Archive independently), and their title renders bold and italic via the `.starred` CSS class. The star button is hidden until hover, but always visible when a task is starred.

### Clear completed

`clearCompleted()` removes all completed todos in a single storage write. The "clear completed" toolbar button only appears when at least one completed todo exists, computed on every render.

---

## Live Clock

A 7-segment digital clock display sits at the bottom of the Tasks view, showing device local time (HH:MM:SS). It uses device local time (`getHours/Minutes/Seconds()`, not UTC).

Each digit is a `<div>` containing seven `<span>` elements (one per segment, named `a`–`g` following the standard 7-segment convention). A `SEG_MAP` array in `panel.js` maps digit values 0–9 to the set of active segment letters. On each `setInterval` tick, each span's `on` class is toggled based on whether its letter appears in the active set. Inactive segments are rendered at 7% opacity to suggest the display shape without distraction.

The colons between digit groups are static `<i>` elements (not toggled) — they don't blink.

---

## Widget / Notion Embed

`widget/widget.html` is a standalone HTML page with the same structure as `panel/panel.html`. It imports `../panel/panel.css` and `../panel/panel.js` directly — the same files the extension uses. There is no separate widget JS or widget storage module.

This means: edit `panel/panel.js`, `panel/panel.css`, or any `lib/*.js` file, and the widget automatically reflects the change. The only file that is widget-specific is `widget/widget.html` itself.

The dual-backend storage adapter in `lib/storage.js` is what makes this possible. When `panel.js` runs inside `widget.html` (a plain web page), `isExtension` is `false`, and all storage calls route through `localStorage` instead of `chrome.storage.local`. The `notifyContentScript()` function in `panel.js` is a no-op when `isExtension` is false (there is no content script in a web page context).

**To publish the Notion embed:** push the repo to GitHub, enable GitHub Pages, and embed `https://USERNAME.github.io/toodly/widget/widget.html` in Notion via `/embed`. Widget data persists in the browser's `localStorage` for that origin and is independent of the extension's `chrome.storage` data — they do not sync.

---

## The Mosaic — How It Works

The mosaic is the core mechanic: upload a photo, complete tasks, watch the image emerge as a dot grid one dot at a time.

### Image processing (`lib/imageProcessor.js`)

`loadImageFile(file)` decodes the file into an `HTMLImageElement` via a temporary object URL — no server, no FileReader.

`processImageToDotMap(img, gridCols=48)` does five things:

1. **Downscale to grid size.** Draws the image onto an offscreen canvas exactly 48 columns wide; rows follow from the aspect ratio. The browser's bilinear smoothing acts as a free box filter.
2. **Read pixel data.** `getImageData()` returns the raw RGBA byte array.
3. **Compute luminance per cell.** Each pixel now represents one grid cell. Perceptual luminance: `L = (0.299·R + 0.587·G + 0.114·B) / 255`.
4. **Mark exclusions.** Cells with `L > 0.92` (near-white) or `alpha < 10` (near-transparent) are flagged `excluded: true`. Everything else gets `weight = 1 − L` — dark pixels get high weight, bright pixels get low weight.
5. **Build reveal order.** Uses the **Efraimidis–Spirakis** weighted sampling-without-replacement algorithm: `key = Math.random() ** (1 / (weight + 0.05))`, sort descending. The `+ 0.05` floor ensures even near-white cells eventually appear — they just tend to come last. Dark areas cluster toward the front of the queue naturally, without feeling mechanical or scanline-sequential.

Output: `{ grid, cells, revealOrder, imageMeta }`. No pixel data is retained.

### Mosaic storage shape

```js
{
  activeImageId: string | null,   // null when fully revealed
  grid: { cols: 48, rows: N },
  cells: [{ x, y, weight, revealed, excluded }],
  revealOrder: number[],          // indices into cells[], pre-computed reveal sequence
  nextRevealPointer: number,
  totalRevealed: number,
  imageMeta: { width, height },
  completedImages: [{ id, completedAt, imageMeta }]
}
```

A 48×27 grid (16:9) produces ~1296 cells, ~60–80 KB in JSON — well within `local`'s 10 MB limit.

### Revealing dots (`lib/storage.js → revealNextCell`)

`completeTodo(id)` is the only entry point to reveal a dot. It is idempotent — calling it on an already-completed todo returns `null` without touching the mosaic. On a fresh completion it calls `revealNextCell()`, which reads `revealOrder[nextRevealPointer]`, marks that cell `revealed`, increments the pointer, and persists. If the pointer reaches the end, the image is archived into `completedImages` and `activeImageId` is set to `null`.

`uncompleteTodo` flips a task back to incomplete but **does not un-reveal a dot**. Earned dots are permanent — unchecking is treated as a misclick, not a reversal of progress.

### Rendering (`lib/mosaicRenderer.js`)

`renderMosaic(canvas, mosaic, { showGhost, previewAll })` is used in two modes:

| Mode | `previewAll` | `showGhost` | Used when |
|---|---|---|---|
| Live reveal | `false` | `true` | Normal mosaic view while in progress |
| Completed preview | `true` | `false` | Image fully revealed |

Each call: sets physical canvas size via `devicePixelRatio` for HiDPI sharpness; fills `#fafaf8`; iterates cells (skipping excluded ones); draws revealed cells as filled circles at 22% of the smaller cell dimension; draws unrevealed cells (when `showGhost`) at half radius and 7% opacity. One renderer, two modes — no duplication.

### Completion feedback

On a fresh completion, `panel.js` sends `TOODLY_TASK_COMPLETED` to the active tab. The floating character button plays a 1.2-second opacity pulse. Respects `prefers-reduced-motion`.

---

## Panel UI

The panel is a Chrome side panel (`chrome.sidePanel` API), staying open while the user browses — unlike a popup, which closes on outside click.

**Two tabs:**

**Tasks** — add-task input with an optional `+ date` row (native date/time pickers, hidden by default); scrollable list split into Today and Archive sections; "clear completed" toolbar (shown only when completed tasks exist); starred tasks appear bold and italic at the top of their section; live 7-segment clock at the bottom.

**Mosaic** — intrinsic-square canvas (`padding-top: 100%` trick), upload control, progress counter.

---

## The Floating Character (`content/character.js`)

Injected into every page at `document_idle`. Lives inside a **closed shadow root** so host-page CSS cannot reach it and its styles cannot leak out. The host element is appended to `<html>` (not `<body>`) so it works even on pages that manipulate the body early.

`window.__toodlyInjected` guard prevents double-injection.

The button cannot call `chrome.sidePanel.open()` directly — content scripts have no `windowId`. Instead it sends `TOODLY_OPEN_PANEL` to the service worker, which has the tab's `windowId` from the `sender` object.

---

## Phase 2 Seam

The `source: 'local'` field on todos and a comment in `background.js` mark where Google Tasks sync would be added. Adding it would require:

- `background.js` — OAuth flow, token storage, polling loop
- `lib/storage.js` — merge logic for `source: 'google'` todos alongside local ones
- `manifest.json` — add `identity` permission

No other files would need to change.
