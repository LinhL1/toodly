import {
  getTodos, addTodo, completeTodo, uncompleteTodo, deleteTodo,
  clearCompleted, reorderTiedGroup,
  getMosaic, setActiveMosaicImage,
} from '../lib/storage.js';
import { loadImageFile, processImageToDotMap } from '../lib/imageProcessor.js';
import { renderMosaic } from '../lib/mosaicRenderer.js';
import { getTodayDateString, isInToday, isInArchive, sortTodos } from '../lib/sections.js';

// ── element refs ──────────────────────────────────────────────────────────────

const el = {
  addForm:        document.getElementById('add-form'),
  addInput:       document.getElementById('add-input'),
  dateToggle:     document.getElementById('date-toggle'),
  addDateRow:     document.getElementById('add-date-row'),
  addDate:        document.getElementById('add-date'),
  addTime:        document.getElementById('add-time'),
  listToolbar:    document.getElementById('list-toolbar'),
  clearCompleted: document.getElementById('clear-completed'),
  listToday:      document.getElementById('list-today'),
  listArchive:    document.getElementById('list-archive'),
  sectionArchive: document.getElementById('section-archive'),
  canvas:         document.getElementById('mosaic-canvas'),
  emptyState:     document.getElementById('empty-state'),
  progress:       document.getElementById('progress'),
  imageUpload:    document.getElementById('image-upload'),
  tabs:           document.querySelectorAll('.tab'),
  viewTasks:      document.getElementById('view-tasks'),
  viewMosaic:     document.getElementById('view-mosaic'),
};

// ── local state ───────────────────────────────────────────────────────────────
// Display caches only. onChanged is the single re-render trigger.

let todos  = [];
let mosaic = null;

// ── drag state ────────────────────────────────────────────────────────────────

let dragId   = null;   // id of the item being dragged
let dragDate = null;   // its date (null = undated)
let dragTime = null;   // its time (null = untimed)
let dropInfo = null;   // { id, position: 'above'|'below' } of the current target

// ── boot ──────────────────────────────────────────────────────────────────────

async function init() {
  [todos, mosaic] = await Promise.all([getTodos(), getMosaic()]);
  renderTodos();

  el.addForm.addEventListener('submit', handleAddTodo);
  el.dateToggle.addEventListener('click', handleDateToggle);
  el.clearCompleted.addEventListener('click', () => clearCompleted());
  el.imageUpload.addEventListener('change', handleImageUpload);
  el.tabs.forEach(tab => tab.addEventListener('click', handleTabClick));

  chrome.storage.onChanged.addListener(handleStorageChanged);

  // Recompute sections in case the panel stays open past midnight.
  setInterval(renderTodos, 3 * 60 * 1000);
}

// ── tab switching ─────────────────────────────────────────────────────────────

function handleTabClick(e) {
  const name = e.currentTarget.dataset.tab;
  el.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  el.viewTasks.classList.toggle('hidden', name !== 'tasks');
  el.viewMosaic.classList.toggle('hidden', name !== 'mosaic');
  if (name === 'mosaic') renderMosaicView();
}

// ── date/time toggle ──────────────────────────────────────────────────────────

function handleDateToggle() {
  const opening = el.addDateRow.classList.contains('hidden');
  el.addDateRow.classList.toggle('hidden', !opening);
  el.dateToggle.textContent = opening ? '− date' : '+ date';
  if (opening) {
    el.addDate.focus();
  } else {
    el.addDate.value = '';
    el.addTime.value = '';
  }
}

// ── todo handlers ─────────────────────────────────────────────────────────────
// Each handler writes to storage and stops; onChanged drives all re-renders.

async function handleAddTodo(e) {
  e.preventDefault();
  const title = el.addInput.value.trim();
  if (!title) return;

  // Native date/time inputs always return '' or a valid 'YYYY-MM-DD'/'HH:MM'
  // string — no manual format validation needed.
  const date = el.addDate.value || null;
  const time = (date && el.addTime.value) ? el.addTime.value : null;

  el.addInput.value = '';
  el.addDate.value  = '';
  el.addTime.value  = '';
  el.addDateRow.classList.add('hidden');
  el.dateToggle.textContent = '+ date';

  await addTodo(title, { date, time });
}

async function handleTodoCheck(id, checked) {
  if (checked) {
    const result = await completeTodo(id);
    if (result) notifyContentScript();
  } else {
    await uncompleteTodo(id);
  }
  // onChanged → renderTodos()
}

async function handleTodoDelete(id) {
  await deleteTodo(id);
  // onChanged → renderTodos()
}

// ── image upload ──────────────────────────────────────────────────────────────

async function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  el.progress.textContent = 'processing…';
  try {
    const img    = await loadImageFile(file);
    const dotMap = processImageToDotMap(img);
    const id     = crypto.randomUUID();
    await setActiveMosaicImage(id, dotMap);
  } catch (err) {
    el.progress.textContent = 'could not process image';
    console.error('[toodly]', err);
  }
  e.target.value = '';
}

// ── storage change listener ───────────────────────────────────────────────────

function handleStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (changes.todos) {
    todos = changes.todos.newValue ?? [];
    renderTodos();
  }
  if (changes.mosaic) {
    mosaic = changes.mosaic.newValue ?? null;
    if (!el.viewMosaic.classList.contains('hidden')) renderMosaicView();
  }
}

// ── rendering ─────────────────────────────────────────────────────────────────

function renderTodos() {
  const today    = getTodayDateString();
  const sorted   = sortTodos(todos);
  const inToday  = sorted.filter(t => isInToday(t, today));
  const inArchive = sorted.filter(t => isInArchive(t, today));

  const hasCompleted = todos.some(t => t.completed);
  el.listToolbar.classList.toggle('hidden', !hasCompleted);
  el.sectionArchive.classList.toggle('hidden', inArchive.length === 0);

  buildList(el.listToday,   inToday);
  buildList(el.listArchive, inArchive);
}

function buildList(ul, items) {
  ul.innerHTML = '';
  for (const todo of items) ul.appendChild(buildItem(todo));
}

function buildItem(todo) {
  const li = document.createElement('li');
  li.className = 'todo-item' + (todo.completed ? ' done' : '');
  li.draggable = true;
  li.dataset.id = todo.id;

  li.addEventListener('dragstart', e  => handleDragStart(e, todo));
  li.addEventListener('dragover',  e  => handleDragOver(e, todo));
  li.addEventListener('dragleave', e  => handleDragLeave(e));
  li.addEventListener('drop',      e  => handleDrop(e, todo));
  li.addEventListener('dragend',   () => clearDragState());

  const check = document.createElement('input');
  check.type      = 'checkbox';
  check.className = 'todo-check';
  check.checked   = todo.completed;
  check.addEventListener('change', ev => handleTodoCheck(todo.id, ev.target.checked));

  const title = document.createElement('span');
  title.className   = 'todo-title';
  title.textContent = todo.title;

  const remove = document.createElement('button');
  remove.className   = 'todo-remove';
  remove.title       = 'remove';
  remove.textContent = '×';
  remove.addEventListener('click', () => handleTodoDelete(todo.id));

  li.append(check, title);

  if (todo.date) {
    const dateSpan = document.createElement('span');
    dateSpan.className   = 'todo-date';
    dateSpan.textContent = formatTodoDate(todo.date, todo.time);
    li.appendChild(dateSpan);
  }

  li.appendChild(remove);
  return li;
}

// ── drag-and-drop ─────────────────────────────────────────────────────────────

function handleDragStart(e, todo) {
  dragId   = todo.id;
  dragDate = todo.date ?? null;
  dragTime = todo.time ?? null;
  e.dataTransfer.effectAllowed = 'move';
  // Delay so the browser captures the ghost image before we fade the element.
  requestAnimationFrame(() => e.target.classList.add('dragging'));
}

function handleDragOver(e, todo) {
  const sameTie = (todo.date ?? null) === dragDate && (todo.time ?? null) === dragTime;
  if (!sameTie || todo.id === dragId) {
    e.dataTransfer.dropEffect = 'none';
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const li  = e.currentTarget;
  const mid = li.getBoundingClientRect().top + li.offsetHeight / 2;
  const pos = e.clientY < mid ? 'above' : 'below';

  clearDropIndicators();
  li.classList.add(pos === 'above' ? 'drop-above' : 'drop-below');
  dropInfo = { id: todo.id, position: pos };
}

function handleDragLeave(e) {
  // Only clear when the pointer genuinely leaves this <li>, not its children.
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('drop-above', 'drop-below');
  }
}

function handleDrop(e, todo) {
  e.preventDefault();
  if (!dragId || !dropInfo) { clearDragState(); return; }

  // Rebuild the tied group from current state and reorder.
  const group = sortTodos(
    todos.filter(t => (t.date ?? null) === dragDate && (t.time ?? null) === dragTime)
  );
  const ids = group.map(t => t.id);

  ids.splice(ids.indexOf(dragId), 1);
  const targetIdx = ids.indexOf(dropInfo.id);
  ids.splice(dropInfo.position === 'above' ? targetIdx : targetIdx + 1, 0, dragId);

  reorderTiedGroup(ids); // onChanged → renderTodos()
  clearDragState();
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-above, .drop-below')
    .forEach(el => el.classList.remove('drop-above', 'drop-below'));
}

function clearDragState() {
  clearDropIndicators();
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  dragId   = null;
  dragDate = null;
  dragTime = null;
  dropInfo = null;
}

// ── mosaic rendering ──────────────────────────────────────────────────────────

function renderMosaicView() {
  if (!mosaic) {
    el.emptyState.classList.remove('hidden');
    el.progress.textContent = '';
    clearCanvas();
    return;
  }

  if (!mosaic.activeImageId && mosaic.cells?.length) {
    el.emptyState.classList.add('hidden');
    el.progress.textContent = 'complete — upload a new image to continue';
    requestAnimationFrame(() =>
      renderMosaic(el.canvas, mosaic, { showGhost: false, previewAll: true })
    );
    return;
  }

  if (!mosaic.activeImageId) {
    el.emptyState.classList.remove('hidden');
    el.progress.textContent = '';
    clearCanvas();
    return;
  }

  el.emptyState.classList.add('hidden');
  el.progress.textContent = `${mosaic.totalRevealed} / ${mosaic.revealOrder.length} revealed`;
  requestAnimationFrame(() =>
    renderMosaic(el.canvas, mosaic, { showGhost: true, previewAll: false })
  );
}

function clearCanvas() {
  const ctx = el.canvas.getContext('2d');
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function formatTodoDate(dateStr, timeStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  let s = `${months[m - 1]} ${d}`;
  if (timeStr) {
    const [h, min] = timeStr.split(':').map(Number);
    s += ` · ${h % 12 || 12}:${String(min).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
  }
  return s;
}

// ── content-script notification ───────────────────────────────────────────────

function notifyContentScript() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'TOODLY_TASK_COMPLETED' })
      .catch(() => { /* tab may not have a content script, e.g. chrome:// pages */ });
  });
}

init();
