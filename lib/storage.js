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

import { getTodayDateString } from './sections.js';

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

export const isExtension =
  typeof chrome !== 'undefined' && chrome?.storage?.local != null;

// Short key names — used as chrome.storage keys AND as the event payload keys
// for the localStorage path so handleStorageChanged sees identical data.
const KEYS = { TODOS: 'todos', MOSAIC: 'mosaic', FOCUS_SESSIONS: 'focusSessions', GROUPS: 'groups' };
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

// Atomic write for multiple keys at once (e.g. todos + groups must stay in sync).
async function setMultiple(obj) {
  if (isExtension) {
    await chrome.storage.local.set(obj);
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    localStorage.setItem(LS + key, JSON.stringify(val));
  }
  const changes = Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, { newValue: v }])
  );
  window.dispatchEvent(new CustomEvent('toodly:changed', { detail: { changes } }));
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

  // Prepend to top of the same (date, time) tied group (below any starred tasks,
  // which are floated by the sort in sections.js and not affected by manualOrder).
  const sameGroup = todos.filter(
    t => (t.date ?? null) === normDate && (t.time ?? null) === normTime
  );
  const minOrder = sameGroup.reduce((m, t) => Math.min(m, t.manualOrder ?? 0), 0);
  const newOrder = sameGroup.length > 0 ? minOrder - 1 : 0;

  const todo = {
    id: crypto.randomUUID(),
    title: title.trim(),
    completed: false,
    completedAt: null,
    listId: 'default',
    source: 'local',      // PHASE 2 SEAM: Google sync would use 'google'
    date: normDate,
    time: normTime,
    manualOrder: newOrder,
    starred: false,
    groupId: null,
  };
  todos.push(todo);
  await setTodos(todos);
  return todo;
}

/**
 * @param {string} id
 */
export async function deleteTodo(id) {
  const [todos, groups] = await Promise.all([getTodos(), getGroups()]);
  const todo = todos.find(t => t.id === id);
  const gid  = todo?.groupId ?? null;

  const newTodos  = todos.filter(t => t.id !== id);
  let   newGroups = groups;
  if (gid) {
    newGroups = groups
      .map(g => g.id === gid ? { ...g, taskIds: g.taskIds.filter(tid => tid !== id) } : g)
      .filter(g => g.taskIds.length > 0);
  }
  await setMultiple({ [KEYS.TODOS]: newTodos, [KEYS.GROUPS]: newGroups });
}

/**
 * Remove all completed todos in one write.
 */
export async function clearCompleted() {
  const todos = await getTodos();
  await setTodos(todos.filter(t => !t.completed));
}

/**
 * Remove completed todos whose completedAt timestamp falls before dateStr.
 * Called at startup and on the day-rollover interval to automatically sweep
 * tasks completed on a previous day.
 *
 * @param {string} dateStr — 'YYYY-MM-DD'; tasks completed before this date are removed
 */
export async function clearCompletedBefore(dateStr) {
  const all = await getTodos();
  const keep = all.filter(t => {
    if (!t.completed || t.completedAt == null) return true;
    const d = new Date(t.completedAt);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return ds >= dateStr;
  });
  if (keep.length < all.length) await setTodos(keep);
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
 * Update editable fields on an existing todo in one storage write.
 * Only fields that are explicitly passed are changed.
 * Passing `date: null` clears both date and time.
 *
 * @param {string} id
 * @param {{ title?: string, date?: string|null, time?: string|null }} fields
 */
export async function updateTodo(id, { title, date, time } = {}) {
  const todos = await getTodos();
  const todo = todos.find(t => t.id === id);
  if (!todo) return;
  if (title !== undefined) todo.title = title;
  if (date !== undefined) {
    todo.date = date || null;
    todo.time = (todo.date && time) ? time : null;
  }
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

/**
 * Rebuild the mosaic's revealOrder and revealed state so dots fill bottom-up.
 * Called once at startup to migrate existing mosaics.
 *
 * The count of revealed dots is preserved (progress is kept), but which cells
 * are revealed changes: the first totalRevealed slots in the new bottom-up
 * order become revealed, everything else becomes unrevealed. This means already-
 * visible dots move to the bottom of the image rather than staying at their
 * original random positions.
 *
 * Sort: y descending (bottom row first), weight descending within each row
 * (darker cells surface before lighter ones).
 */
export async function reorderMosaicBottomUp() {
  const mosaic = await getMosaic();
  if (!mosaic || !mosaic.activeImageId) return;

  const { cells } = mosaic;
  const totalRevealed = mosaic.totalRevealed ?? 0;

  // Complete bottom-up order for all non-excluded cells.
  const allEligible = cells
    .map((cell, i) => ({ i, cell }))
    .filter(({ cell }) => !cell.excluded)
    .sort((a, b) => {
      const rowDiff = b.cell.y - a.cell.y;
      if (rowDiff !== 0) return rowDiff;
      return b.cell.weight - a.cell.weight;
    })
    .map(({ i }) => i);

  // Re-assign revealed: first totalRevealed positions in the new order are revealed.
  cells.forEach(c => { c.revealed = false; });
  for (let i = 0; i < totalRevealed; i++) cells[allEligible[i]].revealed = true;

  mosaic.revealOrder = allEligible;
  mosaic.nextRevealPointer = totalRevealed;

  await setMosaic(mosaic);
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

// ---------------------------------------------------------------------------
// Focus session helpers
// ---------------------------------------------------------------------------

/** @returns {Promise<Array>} */
export async function getFocusSessions() {
  return (await get(KEYS.FOCUS_SESSIONS)) ?? [];
}

/**
 * Record a completed timer session. Call this only when the timer reaches 0 —
 * never for paused or reset timers. Partial sessions are not logged.
 *
 * @param {{ durationMinutes: number }} opts
 */
export async function addFocusSession({ durationMinutes }) {
  const sessions = await getFocusSessions();
  sessions.push({
    id: crypto.randomUUID(),
    date: getTodayDateString(),
    durationMinutes,
    completedAt: Date.now(),
  });
  await set(KEYS.FOCUS_SESSIONS, sessions);
}

/**
 * Sum all focus minutes on a given date.
 * @param {string} dateStr — 'YYYY-MM-DD'
 * @returns {Promise<number>}
 */
export async function getDailyFocusMinutes(dateStr) {
  const sessions = await getFocusSessions();
  return sessions
    .filter(s => s.date === dateStr)
    .reduce((sum, s) => sum + s.durationMinutes, 0);
}

/**
 * Returns the date range [startDate, today] for the spiral layout.
 * Pure — takes the already-loaded sessions array, no storage read.
 *
 * startDate: earliest session date, or today if there are no sessions yet
 * (so a single ghost dot is shown rather than nothing).
 *
 * @param {Array} sessions
 * @returns {{ startDate: string, endDate: string }}
 */
export function getFocusDateRange(sessions) {
  const today = getTodayDateString();
  if (!sessions || sessions.length === 0) return { startDate: today, endDate: today };
  const earliest = sessions.reduce((min, s) => (s.date < min ? s.date : min), sessions[0].date);
  return { startDate: earliest, endDate: today };
}

// ---------------------------------------------------------------------------
// Group helpers
// ---------------------------------------------------------------------------

/** @returns {Promise<Array>} */
export async function getGroups() {
  return (await get(KEYS.GROUPS)) ?? [];
}

/** @param {Array} groups */
export async function setGroups(groups) {
  await set(KEYS.GROUPS, groups);
}

/**
 * Create a new group from two founding tasks. Both tasks receive the new groupId.
 * If either task was already in another group, it is removed from that group first
 * (auto-deleting the old group if it becomes empty).
 *
 * @param {string} name
 * @param {string} taskId1
 * @param {string} taskId2
 * @returns {Promise<Object>} the new group
 */
export async function createGroup(name, taskId1, taskId2) {
  const [todos, groups] = await Promise.all([getTodos(), getGroups()]);

  const group = {
    id:          crypto.randomUUID(),
    name:        name || 'group',
    taskIds:     [taskId1, taskId2],
    collapsed:   false,
    createdAt:   Date.now(),
    manualOrder: groups.length > 0 ? Math.max(...groups.map(g => g.manualOrder ?? 0)) + 1 : 0,
  };

  for (const todo of todos) {
    if (todo.id !== taskId1 && todo.id !== taskId2) continue;
    // Remove from any prior group
    if (todo.groupId && todo.groupId !== group.id) {
      const old = groups.find(g => g.id === todo.groupId);
      if (old) old.taskIds = old.taskIds.filter(id => id !== todo.id);
    }
    todo.groupId = group.id;
  }

  groups.push(group);
  const cleaned = groups.filter(g => g.id === group.id || g.taskIds.length > 0);
  await setMultiple({ [KEYS.TODOS]: todos, [KEYS.GROUPS]: cleaned });
  return group;
}

/**
 * Add a task to an existing group. Handles removal from any prior group.
 * Auto-deletes the prior group if it becomes empty.
 */
export async function addTaskToGroup(taskId, groupId) {
  const [todos, groups] = await Promise.all([getTodos(), getGroups()]);

  const task        = todos.find(t => t.id === taskId);
  const targetGroup = groups.find(g => g.id === groupId);
  if (!task || !targetGroup) return;

  if (task.groupId && task.groupId !== groupId) {
    const old = groups.find(g => g.id === task.groupId);
    if (old) old.taskIds = old.taskIds.filter(id => id !== taskId);
  }

  task.groupId = groupId;
  if (!targetGroup.taskIds.includes(taskId)) targetGroup.taskIds.push(taskId);

  const cleaned = groups.filter(g => g.id === groupId || g.taskIds.length > 0);
  await setMultiple({ [KEYS.TODOS]: todos, [KEYS.GROUPS]: cleaned });
}

/**
 * Remove a task from its group. Auto-deletes the group if it becomes empty.
 */
export async function removeTaskFromGroup(taskId) {
  const [todos, groups] = await Promise.all([getTodos(), getGroups()]);

  const task = todos.find(t => t.id === taskId);
  if (!task || !task.groupId) return;

  const group = groups.find(g => g.id === task.groupId);
  task.groupId = null;
  if (group) group.taskIds = group.taskIds.filter(id => id !== taskId);

  const cleaned = groups.filter(g => g.taskIds.length > 0);
  await setMultiple({ [KEYS.TODOS]: todos, [KEYS.GROUPS]: cleaned });
}

/**
 * Dissolve a group: all member tasks become ungrouped, group is deleted.
 */
export async function dissolveGroup(groupId) {
  const [todos, groups] = await Promise.all([getTodos(), getGroups()]);

  for (const todo of todos) {
    if (todo.groupId === groupId) todo.groupId = null;
  }

  await setMultiple({
    [KEYS.TODOS]:  todos,
    [KEYS.GROUPS]: groups.filter(g => g.id !== groupId),
  });
}

/** Rename a group. */
export async function renameGroup(groupId, name) {
  const groups = await getGroups();
  const group  = groups.find(g => g.id === groupId);
  if (!group) return;
  group.name = name.trim() || 'group';
  await setGroups(groups);
}

/** Reorder tasks within a group by replacing taskIds. */
export async function reorderGroupTasks(groupId, taskIds) {
  const groups = await getGroups();
  const group  = groups.find(g => g.id === groupId);
  if (!group) return;
  group.taskIds = taskIds;
  await setGroups(groups);
}

/** Toggle collapsed state for a group. */
export async function toggleGroupCollapsed(groupId) {
  const groups = await getGroups();
  const group  = groups.find(g => g.id === groupId);
  if (!group) return;
  group.collapsed = !group.collapsed;
  await setGroups(groups);
}

// ---------------------------------------------------------------------------
// Mosaic helpers
// ---------------------------------------------------------------------------

/**
 * @param {Object} mosaic
 * @returns {boolean}
 */
export function isMosaicComplete(mosaic) {
  if (!mosaic) return false;
  return mosaic.nextRevealPointer >= mosaic.revealOrder.length;
}
