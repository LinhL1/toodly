/**
 * lib/storage.js — single source of truth for all chrome.storage reads/writes.
 * Nothing outside this module should call chrome.storage directly.
 *
 * PHASE 2 SEAM: the `source` field on Todo is reserved for a future Google Tasks
 * sync integration. All todos created here get source: 'local'. A Google sync
 * implementation would add source: 'google' todos alongside these without
 * changing the storage schema.
 */

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

// Both todos and mosaic live in local storage.
// Todos: chrome.storage.sync has an 8 KB per-item cap — a modest list blows
//   past it immediately. Since v1 has no cloud sync, local is the right call.
// Mosaic: cells+revealOrder can be 50–90 KB, far too large for sync anyway.
const LOCAL_KEYS = { TODOS: 'todos', MOSAIC: 'mosaic' };

// ---------------------------------------------------------------------------
// Todo helpers
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<Array>}
 */
export async function getTodos() {
  const result = await chrome.storage.local.get(LOCAL_KEYS.TODOS);
  return result[LOCAL_KEYS.TODOS] ?? [];
}

/**
 * @param {Array} todos
 */
export async function setTodos(todos) {
  await chrome.storage.local.set({ [LOCAL_KEYS.TODOS]: todos });
}

/**
 * @param {string} title
 * @returns {Promise<Object>} the new todo
 */
export async function addTodo(title) {
  const todos = await getTodos();
  const todo = {
    id: crypto.randomUUID(),
    title: title.trim(),
    completed: false,
    completedAt: null,
    listId: 'default',
    source: 'local',   // PHASE 2 SEAM: Google sync would use 'google'
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
  const result = await chrome.storage.local.get(LOCAL_KEYS.MOSAIC);
  return result[LOCAL_KEYS.MOSAIC] ?? null;
}

/** @param {Object} mosaic */
export async function setMosaic(mosaic) {
  await chrome.storage.local.set({ [LOCAL_KEYS.MOSAIC]: mosaic });
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
