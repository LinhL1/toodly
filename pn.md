# Toodly — Project Notes

A Chrome extension where completing to-do tasks reveals dots on a mosaic made from your own photo. No backend, no accounts, no bundler. Loads unpacked straight from the folder.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Extension API | Chrome Manifest V3 | Required for modern Chrome extensions; enforces service-worker background, stricter CSP |
| Storage | `chrome.storage.local` | No quota headaches (10 MB vs sync's 8 KB per item); todos are local-only in v1 |
| UI | Vanilla JS ES modules | Zero build step; panel loads `<script type="module">` directly |
| Rendering | Canvas 2D API | Lets us draw and update the dot-grid without any charting library |
| Isolation | Shadow DOM (closed) | Prevents host-page CSS bleeding into or out of the floating character button |
| Fonts | System monospace stack | Avoids loading external fonts from within extension pages (CSP restriction) |
| Icons | System.Drawing PNGs | Generated at build time via PowerShell; easily swappable |

No npm, no webpack, no TypeScript, no framework. The extension loads as raw files.

---

## File Structure

```
toodly/
├── manifest.json              Chrome extension manifest (MV3)
├── background.js              Service worker — opens side panel, relays messages
├── content/
│   └── character.js           Floating button injected into every page
├── panel/
│   ├── panel.html             Side panel shell
│   ├── panel.css              All panel styles
│   └── panel.js              Panel logic — tabs, todo list, mosaic view
├── lib/
│   ├── storage.js             Single source of truth for all chrome.storage I/O
│   ├── imageProcessor.js      Photo → dot-map conversion (runs in panel context)
│   └── mosaicRenderer.js      Canvas renderer shared by preview and live reveal
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## How the Pieces Connect

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
                                              chrome.storage.local (read/write)
                                                            │
                                                      lib/storage.js
                                                     /            \
                                          imageProcessor.js   mosaicRenderer.js
```

The panel never touches `chrome.storage` directly — everything goes through `lib/storage.js`. The character script never reads storage — it only sends and receives messages.

---

## Permissions

```json
"permissions": ["storage", "sidePanel"]
```

That is the complete list. No `identity`, no `tabs` (query for active tab works without it), no host permissions for any external API.

**`<all_urls>` content script scope** — the character button needs to appear on every page, so the content script matches all URLs. This is the widest possible scope and the line Chrome Web Store review will scrutinise. It is inherent to the concept, not an oversight.

---

## The Mosaic — How It Works

The mosaic is the core mechanic: upload a photo, complete tasks, watch your image emerge as a dot grid one dot at a time.

### Step 1 — Image upload and processing (`lib/imageProcessor.js`)

When the user picks a file, `loadImageFile()` decodes it into an `HTMLImageElement` via a temporary object URL (no server, no FileReader — just a URL blob that's revoked after load).

`processImageToDotMap()` then does five things:

1. **Downscale to grid size.** Creates an offscreen canvas exactly 48 columns wide, rows computed from the image's aspect ratio. Draws the image into it. The browser's built-in bilinear/bicubic image smoothing acts as a free box filter — no hand-rolled averaging loop needed.

2. **Read pixel data.** Calls `getImageData()` to get the raw RGBA byte array.

3. **Compute luminance per cell.** For each pixel (which now represents one grid cell), computes perceptual luminance:
   ```
   L = (0.299·R + 0.587·G + 0.114·B) / 255
   ```
   This formula weights green heavily because the human eye is most sensitive to it.

4. **Mark exclusions.** Cells with `L > 0.92` (near-white) or `alpha < 10` (near-transparent) are flagged `excluded: true` and get `weight: 0`. Everything else gets `weight = 1 − L`, so black → weight 1.0, mid-grey → weight 0.5, near-white → weight close to 0.

5. **Build the reveal order.** This is where the organic feel comes from. Uses the **Efraimidis–Spirakis** weighted sampling-without-replacement algorithm:
   - Assign each included cell a random key: `key = Math.random() ** (1 / (weight + 0.05))`
   - Sort all cells by key, descending
   - The resulting index array is `revealOrder`

   The `+ 0.05` floor constant means even very bright cells (weight ≈ 0) eventually get picked — they just tend to appear late. Dark cells have higher weights so they cluster toward the front of the queue. The result is an order that is statistically biased toward dark areas first but with enough randomness that it never feels mechanical or scanline-sequential.

The output is `{ grid, cells, revealOrder, imageMeta }` — no pixel data is kept, just the metadata needed to render and reveal.

### Step 2 — Storing the dot-map (`lib/storage.js → setActiveMosaicImage`)

The dot-map is written to `chrome.storage.local` under the key `mosaic`. The full mosaic object looks like this:

```js
{
  activeImageId: string | null,   // null when image is fully revealed
  grid: { cols: 48, rows: N },
  cells: [                        // one entry per grid position, including excluded
    { x, y, weight, revealed, excluded }
  ],
  revealOrder: number[],          // indices into cells[], in the order they'll be revealed
  nextRevealPointer: number,      // how far along revealOrder we are
  totalRevealed: number,
  imageMeta: { width, height },
  completedImages: [{ id, completedAt, imageMeta }]
}
```

A 48×27 grid (16:9 image) produces roughly 1296 cells. In JSON that's ~60–80 KB — comfortably within `local`'s 10 MB limit but would have blown past `sync`'s 100 KB total quota.

### Step 3 — Revealing dots (`lib/storage.js → revealNextCell`)

`completeTodo(id)` is the only function that can flip a todo to `completed: true`. It is idempotent — calling it on an already-completed todo returns `null` without touching the mosaic. On a fresh completion it calls `revealNextCell()`:

- Reads `revealOrder[nextRevealPointer]` to get the next cell index
- Marks `cells[idx].revealed = true`
- Increments `nextRevealPointer` and `totalRevealed`
- If `nextRevealPointer >= revealOrder.length`, the image is complete: archives it into `completedImages` and sets `activeImageId = null`
- Writes the updated mosaic back to storage and returns `{ cell, justCompleted }`

`uncompleteTodo` flips a task back to incomplete but **does not un-reveal a dot**. Earned dots are permanent — unchecking a task is treated as a misclick, not a reversal of progress.

### Step 4 — Rendering (`lib/mosaicRenderer.js`)

`renderMosaic(canvas, mosaic, { showGhost, previewAll })` is a single function used in two modes:

| Mode | `previewAll` | `showGhost` | Used when |
|---|---|---|---|
| Live reveal | `false` | `true` | Normal mosaic view |
| Completed preview | `true` | `false` | Image fully revealed |

On each call it:

1. Reads `canvas.clientWidth` for the rendered CSS size, multiplies by `devicePixelRatio` to set the physical pixel dimensions — this keeps the canvas sharp on HiDPI/Retina screens.
2. Fills the background with `#fafaf8`.
3. Iterates every cell. Skips `excluded` ones entirely.
4. For revealed cells: draws a filled circle at `(x + 0.5) × cellWidth, (y + 0.5) × cellHeight` with a fixed radius of `22%` of the smaller cell dimension.
5. For unrevealed cells (when `showGhost` is true): draws the same position at half the radius and 7% opacity — a barely-visible ghost that lets the image's silhouette breathe without spoiling the reveal.

### Step 5 — Feedback loop

When a task is completed and a cell is revealed, `panel.js` sends a `TOODLY_TASK_COMPLETED` message to the active tab's content script. The floating character button plays a 1.2-second opacity pulse (`toodly-pulse` keyframe animation). The animation respects `prefers-reduced-motion` — if the user has that set, the class is added but the animation declaration is overridden to `none`.

---

## Storage Design

All reads and writes go through `lib/storage.js`. Nothing else calls `chrome.storage` directly.

| Key | Area | Contents |
|---|---|---|
| `todos` | local | Array of todo objects |
| `mosaic` | local | Full mosaic state (grid, cells, reveal pointer) |

**Todo shape:**
```js
{
  id: string,           // crypto.randomUUID()
  title: string,
  completed: boolean,
  completedAt: number | null,   // timestamp ms
  listId: 'default',
  source: 'local'       // reserved for future Google Tasks sync (Phase 2 seam)
}
```

`chrome.storage.onChanged` is the single trigger for UI re-renders in `panel.js`. Handlers write to storage and do nothing else — the `onChanged` callback owns the re-render. This eliminates the race condition where an optimistic local push and an `onChanged` callback both render the same new todo, temporarily creating a duplicate.

---

## Panel UI

The panel is a Chrome side panel (`chrome.sidePanel` API), which means it stays open while the user browses — unlike a popup, which closes on outside click.

Two tabs:

**Tasks** — add-task input, scrollable todo list, "clear completed" button (appears only when completed todos exist). Completed tasks sort to the bottom with strikethrough. Unchecking re-opens a task but does not un-reveal a dot.

**Mosaic** — square canvas stage (CSS `padding-top: 100%` trick for intrinsic square), upload control, progress counter (`N / total revealed`), hint text.

---

## The Floating Character (`content/character.js`)

Injected into every page at `document_idle`. Lives inside a **closed shadow root** so host-page CSS cannot reach it and its styles cannot leak out. The host element is appended to `<html>` (not `<body>`) so it works even on pages that manipulate the body early.

A `window.__toodlyInjected` guard prevents double-injection if the script somehow runs twice on the same page.

The button cannot call `chrome.sidePanel.open()` directly — content scripts have no `windowId` context. Instead it sends `TOODLY_OPEN_PANEL` to the service worker, which has the tab's `windowId` from the `sender` object and can make the call.

---

## Phase 2 Seam

The `source: 'local'` field on the todo model and a comment in `background.js` mark where Google Tasks auth/sync would be added. Nothing else in v1 anticipates it. Adding it would mean:

- `background.js` — OAuth flow, token storage, polling loop
- `storage.js` — merge logic for `source: 'google'` todos alongside local ones
- `manifest.json` — add `identity` permission

No other files would need to change.
