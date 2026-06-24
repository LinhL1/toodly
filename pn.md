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
│   └── panel.js               Panel logic — tabs, todo list, mosaic + spiral views (shared by widget)
├── lib/
│   ├── storage.js             Unified storage adapter — chrome.storage.local or localStorage
│   ├── sections.js            Pure functions: section membership, sorting
│   ├── imageProcessor.js      Photo → dot-map conversion
│   ├── mosaicRenderer.js      Canvas renderer shared by upload preview and live reveal
│   ├── spiralLayout.js        Pure Archimedean spiral geometry (no DOM, no storage)
│   └── spiralRenderer.js      Canvas renderer for the focus-session spiral
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
                                         lib/spiralLayout.js
                                         lib/spiralRenderer.js
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
| `focusSessions` / `toodly_focusSessions` | `chrome.storage.local` | `localStorage` | Array of FocusSession records |

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

### FocusSession shape

```js
{
  id: string,           // crypto.randomUUID()
  date: string,         // 'YYYY-MM-DD', local timezone (same as todo date logic)
  durationMinutes: number,  // rounded to nearest minute
  completedAt: number,  // epoch ms
}
```

A `FocusSession` is only created when the timer reaches 0 — resetting or closing the panel mid-session creates nothing. There is no archiving concept; the full session history is always retained and is the entire point.

### The single re-render trigger

`chrome.storage.onChanged` (or the synthetic `toodly:changed` event in the widget) is the only thing that calls `renderTodos()`. Handlers write to storage and stop — they never mutate local state or call render themselves. This eliminates the race condition where an optimistic local push and an `onChanged` callback both render the same new todo and briefly show a duplicate.

---

## Sections and Sorting (`lib/sections.js`)

All section logic is pure — no storage access, no side effects.

### Today vs Upcoming vs Archive

Three sections, computed fresh on every render from the same flat todo array — membership is never stored:

- **Today** — no date (undated tasks), or `date === today`
- **Upcoming** — `date > today` (future-dated tasks); hidden when empty
- **Archive** — `date < today` (past-dated); hidden when empty

Order in the UI: Today → Upcoming → Archive.

Keeping membership derived (not stored) means day-rollover is automatic: `renderTodos()` runs on every storage change and on a 3-minute `setInterval`, so an upcoming task silently becomes today's task at midnight without any migration step.

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

Each todo optionally carries a `date` and `time`. Both are set via native `<input type="date">` and `<input type="time">` pickers — the browser handles formatting, validation, and the calendar/time UI.

**Adding on create:** the add form has a `+ date` toggle that reveals a date picker; the time picker only appears after a date is selected. Time requires a date; clearing date also clears time (enforced in `addTodo()` and `setTodoDateTime()` in `lib/storage.js`).

**Editing after creation:** clicking the task title or date badge opens a full inline editor for that task. The `editingId` module-level variable tracks which todo is in edit mode; `editingFocusDate` (bool) records whether the date input or title input should receive focus when the form renders.

In edit mode `buildItem` renders a `.todo-edit-wrap` (column flex) containing a `.todo-edit-title` text input and a `.todo-edit-date-row` with date/time pickers. The date input shows immediately; the time input is hidden until a date is selected. The `<li>` gets `draggable=false` so drag-and-drop doesn't interfere.

Save paths: Enter on any input, or focus leaving the `<li>` (`focusout` with `relatedTarget` outside the item). Cancel path: Escape. Empty title on save discards and exits without writing. `updateTodo(id, { title, date, time })` in `lib/storage.js` batches all three fields in one write. The double-call guard (`if (editingId !== todo.id) return`) prevents focusout and keydown from both firing save. `handleTodoDelete` clears `editingId` if the deleted task was being edited.

### Drag-and-drop reorder

Drag handles are on every `<li>` (via the `draggable` attribute). Dragging is only permitted within a tied group — tasks with different `(date, time)` pairs are not drop targets for each other. This is checked in `handleDragOver` by comparing the dragged item's `(date, time)` against the target's.

On drop, `reorderTiedGroup(orderedIds)` receives the full group's IDs in the new desired order and rewrites each task's `manualOrder` to `0, 1, 2, …` in one storage write. Rewriting the whole group (not just swapping two values) prevents `manualOrder` values from drifting out of sync across separate edits over time.

### Star / priority

The `starred` boolean field on each todo is toggled by `toggleStar(id)`. Starred tasks sort to the top of their section (Today or Archive independently), and their title renders bold and italic via the `.starred` CSS class. The star button is hidden until hover, but always visible when a task is starred.

### Clear completed

`clearCompleted()` removes all completed todos in a single storage write. The "clear completed" toolbar button only appears when at least one completed todo exists, computed on every render.

### Auto-clear from previous days

`clearCompletedBefore(dateStr)` in `lib/storage.js` removes completed todos whose `completedAt` timestamp falls before `dateStr`. It is called at startup (in `init()`) and inside the existing 3-minute day-rollover `setInterval`, so tasks completed on any prior day are swept out automatically — at next open, or at most 3 minutes after midnight while the panel is open. Tasks with `completedAt == null` (edge-case stale data) are kept. The key field used is `completedAt`, not `date` — a task's assigned date is irrelevant; what matters is when it was checked off.

---

## Task Groups

Groups cluster related tasks under a named heading. They render above all section headers (Today / Upcoming / Archive) regardless of the dates their member tasks carry — group membership takes priority over section placement.

### Data shape

```js
// storage key: 'groups'
{
  id:          string,    // crypto.randomUUID()
  name:        string,    // user-editable; defaults to 'group' on creation
  taskIds:     string[],  // ordered member task ids
  collapsed:   boolean,   // UI state — false on creation
  createdAt:   number,    // Date.now()
  manualOrder: number,    // position within the groups list
}
```

Each todo gains `groupId: string | null` (null = ungrouped). Existing tasks without the field are treated as `null` — no migration write needed until the user creates a group. `deleteTodo`, `createGroup`, `addTaskToGroup`, and `removeTaskFromGroup` all write `todos` and `groups` atomically via `setMultiple` to keep them in sync.

### Grouping flow

**Creating a group:** Drag a task and drop it onto the center zone (middle 60% of the target's height) of another task. The target task shows an inline confirm row — `group with "[name]"? [yes] [no]`. On yes, `createGroup` is called and the new group's name field opens immediately for editing. On no, state resets with no change.

**Adding to an existing group:** Drop any task onto the group's header (drop-onto highlight appears on the header) or onto any task already inside a group (center zone). No confirm — intent is unambiguous. Handled by `addTaskToGroup`, which also removes the task from any prior group and auto-deletes the prior group if empty.

**Drag-reorder within a group:** above/below zones on group member tasks reorder `group.taskIds` via `reorderGroupTasks`.

**Drag out of a group:** drag a group member and drop it in above/below position onto an ungrouped task. Calls `removeTaskFromGroup` (task returns to the flat list at its natural sort position). Auto-deletes the group if it becomes empty.

**Empty group auto-delete:** All storage operations that remove tasks from groups (`removeTaskFromGroup`, `deleteTodo`, `dissolveGroup`) filter out groups with zero `taskIds` before writing.

### Rename and ungroup

Click the group name → inline text input (same pattern as task inline edit). Enter saves, Escape cancels, blur saves. The `[ungroup]` button (revealed on header hover) calls `dissolveGroup` — clears all member `groupId`s and removes the group in one atomic write.

### Drop zone detection

```
top 20%    → 'above'  (reorder)
middle 60% → 'onto'   (group trigger or add-to-group)
bottom 20% → 'below'  (reorder)
```

Constants `ONTO_TOP = 0.2` and `ONTO_BOT = 0.8` in `panel.js`. The existing same-`(date, time)` reorder gate is bypassed for group member drags, allowing them to be dropped anywhere.

### Storage

Two keys: `todos` (existing) and `groups` (new). Stored in `chrome.storage.local` (10 MB limit). Atomic multi-key writes use `setMultiple(obj)` in `storage.js`. `handleStorageChanged` in `panel.js` handles `changes.groups` and re-renders.

---

## Sand Timer Tab

A third tab ("timer") sits between tasks and mosaic. It provides a session timer for focused work/study with two visual layers: a large 7-segment digital countdown and a dot-grid canvas that acts as a visual sand timer.

### Timer state

Timer state is in-memory only (not persisted to storage). Timers are naturally session-scoped — a restarted browser means a fresh session, so persistence would add complexity with no real value.

```
timerDuration   — total seconds for the current session
timerRemaining  — seconds left; decremented by timerTick()
timerRunning    — boolean
timerLastMs     — Date.now() snapshot at the last tick
```

`timerTick()` runs on a 200ms interval but computes elapsed time as `Math.floor((Date.now() - timerLastMs) / 1000)`. It only decrements on whole-second boundaries and advances `timerLastMs` by exactly `delta * 1000`. This prevents drift from `setInterval`'s inherent imprecision — if the tab is backgrounded and intervals fire late, the timer catches up correctly on the next tick.

### Completion alarm

When the timer reaches 0, `startAlarm()` begins a repeating two-tone ring ("di-da": 1000 Hz → 1250 Hz, 400 ms per tone, 500 ms apart, burst every 1.8 s) using the Web Audio API. The alarm continues until the user explicitly resets the timer — `stopAlarm()` is called by `handleTimerReset`, by `handleTimerToggle` when starting a new session (e.g. via Enter on a custom time), and by preset button clicks.

The `AudioContext` (`audioCtx`) is created once inside `handleTimerToggle` the first time the user clicks "start" — a real user gesture. Chrome's autoplay policy blocks `AudioContext` creation inside `setInterval` callbacks (suspended state that can't be resumed without a gesture), so the context must be created and unlocked during the click. `startAlarm` / `playAlarmBurst` then reuse this already-running context, which is why audio works when the timer fires from `setInterval`. No audio file, no extra permissions.

### Preset durations

Three preset buttons (15m, 30m, 45m — covering short break, Pomodoro, and deep-focus block). Clicking a preset while the timer is running is a no-op. When a preset is selected, duration and remaining are both reset.

### 7-segment display (MM:SS)

Reuses the shared `buildSegmentSpans` / `setSegmentDigit` helpers and `SEG_MAP` constant. Four digit elements (`td0`–`td3`) with a single colon. The timer digits are sized larger than the clock digits via `.seg-display--timer` CSS overrides (~42×74px vs 26×48px for the clock).

### Dot hourglass (`drawSandTimer`)

An hourglass-shaped dot grid drawn on `#sand-canvas`. Visual language is identical to the mosaic (same dot sizes, ghost opacity, background colour). The grid uses 10×10 cell positions with only the hourglass-shaped subset drawn; cells outside the shape show the background, giving the outline its form.

Row widths (symmetric about the midpoint): 10, 8, 6, 4, 2 | 2, 4, 6, 8, 10 → 30 cells per half, 60 total.

The animation is split into two independently ordered arrays:

- **`UPPER_CELLS`** (30 cells, row 0 → row 4): ordered top-to-bottom. These start solid. As time passes, cells become ghost starting from row 0 (the top surface falls, like sand draining from a chamber).
- **`LOWER_CELLS`** (30 cells, row 9 → row 5): ordered bottom-to-top. These start ghost. As time passes, cells become solid starting from row 9 (sand accumulates from the bottom of the lower chamber upward).

At elapsed fraction `f`, `transitioned = round(f × 30)` cells change state in each half simultaneously. This keeps the total solid-dot count constant at 30 throughout — sand is conserved, exactly as in a physical hourglass. At t=50%, the top half is drained down to ~row 2 and the bottom half is filled up to ~row 7, matching a real hourglass at half-time.

### Click-to-edit custom time

Clicking the timer display (when not running) enters edit mode: the seg display hides, a plain text input appears in its place pre-filled with the current `MM:SS` value. Accepts `MM:SS` or bare `MM` (interpreted as minutes). Enter or blur commits; Escape cancels. On commit, `timerDuration` and `timerRemaining` are updated, preset active states are cleared, and the display and hourglass redraw.

### Shared segment helpers

`buildSegmentSpans(digitEl)` and `setSegmentDigit(digitEl, n)` are module-level functions shared between `startClock()` and `initTimer()`. Before this refactor, the segment-building logic was duplicated inline inside `startClock`. Extracting them means new display surfaces (like the timer) don't need to copy the code.

## Focus Session Year Grid

A second visual in the mosaic tab, placed below the task-completion mosaic and separated by a hairline. It shows a compact dot grid for the **current calendar year** — one dot per day, Jan 1 (top-left) to Dec 31 (bottom-right), arranged left-to-right top-to-bottom in a 20-column × 19-row layout that fills the square canvas.

Future slots remain empty and fill in as the year progresses — the growing patch of dots makes time and consistency visible at a glance.

### Data flow

`addFocusSession({ durationMinutes })` is called at the end of `timerTick()` in `panel.js`, only when `timerRemaining === 0`. Resetting the timer or pausing it and closing the panel never creates a session.

`getFocusSessions()` returns the full history. `renderSpiralView()` in `panel.js` filters sessions to the current year before passing them to `renderGrid`. `getFocusDateRange(sessions)` remains in `lib/storage.js` as an exported utility but is no longer used by the grid UI.

### Grid geometry and rendering (`lib/spiralRenderer.js`)

`renderGrid(canvas, sessions, { year })`:

1. Builds a list of all calendar days in `year` (365 or 366 for leap years) using noon timestamps to avoid DST-boundary errors.
2. Filters sessions to the current year and builds a `minutesByDate` Map.
3. Layout: `COLS = 20`, `ROWS = ceil(yearLen / 20) = 19`. Cell size = `min((size−16)/20, (size−16)/19)` — largest square cell fitting both axes. Grid is centered in the canvas.
4. For each day up to and including today: draws a dot with `weight = √(min(minutes, 120) / 120)`, radius `ghostDotR + (maxDotR − ghostDotR) · weight`, opacity `0.07 + 0.78 · weight`. Days with 0 minutes (gap days) get the ghost-dot treatment — small and very faint. Future days are skipped entirely.
5. Returns `{ dots }` for hover hit-testing. Ghost dots get a minimum hit radius of 5 px so they remain hoverable.

The 120-minute cap keeps one unusually long day from swamping everything else. Square-root curve: 30 min = 50% weight, 60 min = 71%, 120+ min = 100%.

### Hover tooltips

`renderSpiralView()` captures the `dots` array from `renderGrid` into `spiralDots`. A `mousemove` listener on `#spiral-canvas` hit-tests by Euclidean distance and shows `#spiral-tooltip` (a `position: fixed` dark pill) near the cursor. Content is `"jun 15, 2026"` for ghost days and `"jun 15, 2026 · 50m"` for active days. `mouseleave` hides it.

### Live update

When a session is saved, `chrome.storage.onChanged` fires (or `toodly:changed` in the widget). `handleStorageChanged` in `panel.js` catches `changes.focusSessions`, updates the `focusSessions` local cache, and calls `renderSpiralView()` if the mosaic tab is currently visible. Today's dot darkens immediately.

### UI placement

The grid lives inside `#view-mosaic`, wrapped with the task mosaic in `.mosaic-scroll` (`overflow-y: auto`). A `section-label` reading "focus" separates it from the task mosaic above. A one-line caption shows active days, session count, and total minutes for the current year.

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

The mosaic is the core mechanic: complete tasks, watch a heart emerge as a dot grid one dot at a time. The image is fixed — `assets/heart.png` is always the target. There is no upload UI.

When the heart is fully revealed, a new one starts automatically and the completed heart is drawn as a semi-transparent ghost layer behind the active one. Multiple completions stack: each adds another 10% opacity to the background ghost, capped at 45%. This makes repeated progress visible without obscuring the active heart.

### Auto-load (`panel.js → autoLoadHeart`)

`autoLoadHeart()` resolves the URL for `heart.png` (extension context: `chrome.runtime.getURL('assets/heart.png')`; widget context: `'../assets/heart.png'`), loads it via `loadImageURL`, converts it to a dot map, and calls `setActiveMosaicImage`. It is called in two places:
- `init()` — on first load, if no active mosaic exists yet
- `handleStorageChanged` — when a mosaic change arrives with `!activeImageId` (i.e., the heart just completed)

A boolean guard `autoLoadingHeart` prevents concurrent calls.

### Image processing (`lib/imageProcessor.js`)

`loadImageURL(url)` loads an `HTMLImageElement` from a URL string — used for the fixed heart asset. `loadImageFile(file)` (File → object URL path) is retained but no longer called.

`processImageToDotMap(img, gridCols=48)` does five things:

1. **Downscale to grid size.** Draws the image onto an offscreen canvas exactly 48 columns wide; rows follow from the aspect ratio. The browser's bilinear smoothing acts as a free box filter.
2. **Read pixel data.** `getImageData()` returns the raw RGBA byte array.
3. **Compute luminance per cell.** Each pixel now represents one grid cell. Perceptual luminance: `L = (0.299·R + 0.587·G + 0.114·B) / 255`.
4. **Mark exclusions.** Cells with `L > 0.92` (near-white) or `alpha < 10` (near-transparent) are flagged `excluded: true`. Everything else gets `weight = 1 − L` — dark pixels get high weight, bright pixels get low weight.
5. **Build reveal order.** Uses **Efraimidis–Spirakis** weighted sampling (`key = Math.random() ** (1 / (weight + 0.05))`) as a secondary sort within each row, but the primary sort is by `y` descending so the bottom row fills first and the image emerges upward. Dark areas within each row still surface before lighter ones. The `+ 0.05` floor ensures even near-white cells eventually appear.

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

`reorderMosaicBottomUp()` is called once at startup to migrate existing mosaics. It rebuilds `revealOrder` as a complete bottom-up sequence of all non-excluded cells (y descending, weight descending within each row), then re-assigns `cell.revealed` so that the first `totalRevealed` positions in that new order are revealed. The dot count (progress) is preserved but which cells are revealed changes — existing dots move to the bottom of the image rather than staying at their original random positions. New uploads get the same ordering from `processImageToDotMap`.

`uncompleteTodo` flips a task back to incomplete but **does not un-reveal a dot**. Earned dots are permanent — unchecking is treated as a misclick, not a reversal of progress.

### Rendering (`lib/mosaicRenderer.js`)

`renderMosaic(canvas, mosaic, { showGhost, previewAll, completedCount })` renders in one mode (live reveal):

Each call: sets physical canvas size via `devicePixelRatio` for HiDPI sharpness; fills `#fafaf8`; if `completedCount > 0`, draws all non-excluded cells at `min(completedCount × 0.1, 0.45)` opacity as the background ghost layer; then iterates cells drawing revealed ones at full opacity and unrevealed ghost dots at half-radius and 7% opacity. The `previewAll` path is still present but unused now that hearts auto-restart.

### Completion feedback

On a fresh completion, `panel.js` sends `TOODLY_TASK_COMPLETED` to the active tab. The floating character button plays a 1.2-second opacity pulse. Respects `prefers-reduced-motion`.

---

## Panel UI

The panel is a Chrome side panel (`chrome.sidePanel` API), staying open while the user browses — unlike a popup, which closes on outside click.

**Two tabs:**

**Tasks** — add-task input with an optional `+ date` row (native date/time pickers, hidden by default); scrollable list split into Today and Archive sections; "clear completed" toolbar (shown only when completed tasks exist); starred tasks appear bold and italic at the top of their section; live 7-segment clock at the bottom.

**Mosaic** — intrinsic-square canvas (`padding-top: 100%` trick), progress counter ("N / M revealed"). No upload control — the image is always `assets/heart.png`, loaded automatically.

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
