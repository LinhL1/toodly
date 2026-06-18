/**
 * lib/storage.js — unified storage layer for both the Chrome extension and the
 * hosted Notion widget.
 *
 * Context detection: if chrome.storage.local is available (extension page) it
 * is used and chrome.storage.onChanged fires re-renders automatically.
 * Otherwise localStorage is used (widget / any web page) and a synthetic
 * 'toodly:changed' CustomEvent fires with the same payload shape so panel.js
 * can use one identical handleStorageChanged handler in both contexts.
 *
 * PHASE 2 SEAM: the `source` field on Todo is reserved for a future Google
 * Tasks sync integration. All todos created here get source: 'local'.
 */

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

export const isExtension =
  typeof chrome !== 'undefined' && chrome?.storage?.local != null;

// Short key names — used as chrome.storage keys AND as the event payload keys
// for the localStorage path so handleStorageChanged sees identical data.
const KEYS = { TODOS: 'todos', MOSAIC: 'mosaic' };
// localStorage namespace prefix to avoid key collisions on shared origins.
const LS = 'toodly_';

// ---------------------------------------------------------------------------
// Raw read / write — the only two places that touch the underlying store
// ---------------------------------------------------------------------------

async function get(key) {
  if (isExtension) {
    const r = await chrome.storage.local.get(key);
    return r[key] ?? null;
  }
  try { return JSON.parse(localStorage.getItem(LS + key)); } catch { return null; }
}

async function set(key, val) {
  if (isExtension) {
    await chrome.storage.local.set({ [key]: val });
    // chrome.storage.onChanged fires automatically — nothing more to do.
    return;
  }
  localStorage.setItem(LS + key, JSON.stringify(val));
  // Synthetic event matching the chrome.storage.onChanged payload shape so
  // panel.js handleStorageChanged works identically in both contexts.
  window.dispatchEvent(new CustomEvent('toodly:changed', {
    detail: { changes: { [key]: { newValue: val } } },
  }));
}

// ---------------------------------------------------------------------------
// Todo helpers
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<Array>}
 */
export async function getTodos() {
  return (await get(KEYS.TODOS)) ?? [];
}

/**
 * @param {Array} todos
 */
export async function setTodos(todos) {
  await set(KEYS.TODOS, todos);
}

/**
 * @param {string} title
 * @param {{ date?: string|null, time?: string|null }} [opts]
 * @returns {Promise<Object>} the new todo
 */
export async function addTodo(title, { date = null, time = null } = {}) {
  const todos = await getTodos();
  const normDate = date || null;
  const normTime = (normDate && time) ? time : null;

  // Append to end of the same (date, time) tied group.
  const sameGroup = todos.filter(
    t => (t.date ?? null) === normDate && (t.time ?? null) === normTime
  );
  const maxOrder = sameGroup.reduce((m, t) => Math.max(m, t.manualOrder ?? 0), -1);

  const todo = {
    id: crypto.randomUUID(),
    title: title.trim(),
    completed: false,
    completedAt: null,
    listId: 'default',
    source: 'local',      // PHASE 2 SEAM: Google sync would use 'google'
    date: normDate,
    time: normTime,
    manualOrder: maxOrder + 1,
    starred: false,
  };
  todos.push(todo);
  await setTodos(todos);
  return todo;
}

/**
 * @param {string} id
 */
export async function deleteTodo(id) {
  const todos = await getTodos();
  await setTodos(todos.filter(t => t.id !== id));
}

/**
 * Remove all completed todos in one write.
 */
export async function clearCompleted() {
  const todos = await getTodos();
  await setTodos(todos.filter(t => !t.completed));
}

/**
 * Toggle the starred flag on a todo.
 * @param {string} id
 */
export async function toggleStar(id) {
  const todos = await getTodos();
  const todo = todos.find(t => t.id === id);
  if (!todo) return;
  todo.starred = !todo.starred;
  await setTodos(todos);
}

/**
 * Rewrite manualOrder for an entire tied group in the user's new drag order.
 * Takes the group's IDs in the desired final order; assigns 0, 1, 2, …
 * Rewriting the whole group on every drag keeps values from drifting out of
 * sync with each other across separate add/edit operations over time.
 *
 * @param {string[]} orderedIds — all IDs in the tied group, in new order
 */
export async function reorderTiedGroup(orderedIds) {
  const todos = await getTodos();
  orderedIds.forEach((id, idx) => {
    const t = todos.find(t => t.id === id);
    if (t) t.manualOrder = idx;
  });
  await setTodos(todos);
}

/**
 * Set or clear the date/time on an existing todo.
 * Clearing date also clears time — a task cannot have a time with no date.
 *
 * @param {string} id
 * @param {{ date?: string|null, time?: string|null }} opts
 */
export async function setTodoDateTime(id, { date = null, time = null } = {}) {
  const todos = await getTodos();
  const todo = todos.find(t => t.id === id);
  if (!todo) return;
  todo.date = date || null;
  todo.time = (todo.date && time) ? time : null;
  await setTodos(todos);
}

/**
 * Flip a todo to completed. Idempotent — if already completed, returns null
 * without revealing another dot. On a fresh completion, reveals the next
 * mosaic cell and returns it.
 *
 * @param {string} id
 * @returns {Promise<{ cell: Object, justCompleted: boolean } | null>}
 */
export async function completeTodo(id) {
  const todos = await getTodos();
  const todo = todos.find(t => t.id === id);
  if (!todo) return null;
  if (todo.completed) return null;  // idempotent — already done

  todo.completed = true;
  todo.completedAt = Date.now();
  await setTodos(todos);

  return revealNextCell();
}

/**
 * Flip a todo back to incomplete. Does NOT un-reveal a dot — earned dots stay
 * earned. This is a deliberate product decision: don't punish an accidental
 * check. The dot economy only ever grows.
 *
 * @param {string} id
 */
export async function uncompleteTodo(id) {
  const todos = await getTodos();
  const todo = todos.find(t => t.id === id);
  if (!todo || !todo.completed) return;

  todo.completed = false;
  todo.completedAt = null;
  await setTodos(todos);
}

// ---------------------------------------------------------------------------
// Mosaic helpers
// ---------------------------------------------------------------------------

/** @returns {Promise<Object|null>} */
export async function getMosaic() {
  return (await get(KEYS.MOSAIC)) ?? null;
}

/** @param {Object} mosaic */
export async function setMosaic(mosaic) {
  await set(KEYS.MOSAIC, mosaic);
}

/**
 * Install a new active mosaic image, discarding any unfinished reveal progress
 * on the previous image. The previous image is NOT archived — only completed
 * images enter completedImages.
 *
 * @param {string} imageId
 * @param {{ grid, cells, revealOrder, imageMeta }} dotMap — from imageProcessor
 */
export async function setActiveMosaicImage(imageId, dotMap) {
  const existing = await getMosaic();
  const completedImages = existing?.completedImages ?? [];

  const mosaic = {
    activeImageId: imageId,
    grid: dotMap.grid,
    cells: dotMap.cells,
    revealOrder: dotMap.revealOrder,
    nextRevealPointer: 0,
    totalRevealed: 0,
    imageMeta: dotMap.imageMeta,
    completedImages,
  };

  await setMosaic(mosaic);
  return mosaic;
}

/**
 * Pull the next cell off the reveal queue, mark it revealed, and persist.
 * Archives the image into completedImages if the last cell was just revealed.
 *
 * @returns {Promise<{ cell: Object, justCompleted: boolean } | null>}
 */
export async function revealNextCell() {
  const mosaic = await getMosaic();
  if (!mosaic || !mosaic.activeImageId) return null;
  if (isMosaicComplete(mosaic)) return null;

  const idx = mosaic.revealOrder[mosaic.nextRevealPointer];
  const cell = mosaic.cells[idx];
  cell.revealed = true;

  mosaic.nextRevealPointer += 1;
  mosaic.totalRevealed += 1;

  let justCompleted = false;
  if (isMosaicComplete(mosaic)) {
    justCompleted = true;
    mosaic.completedImages.push({
      id: mosaic.activeImageId,
      completedAt: Date.now(),
      imageMeta: mosaic.imageMeta,
    });
    mosaic.activeImageId = null;
  }

  await setMosaic(mosaic);
  return { cell, justCompleted };
}

/**
 * @param {Object} mosaic
 * @returns {boolean}
 */
export function isMosaicComplete(mosaic) {
  if (!mosaic) return false;
  return mosaic.nextRevealPointer >= mosaic.revealOrder.length;
}
