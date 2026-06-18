import {
  getTodos, addTodo, completeTodo, uncompleteTodo, deleteTodo, clearCompleted,
  getMosaic, setActiveMosaicImage,
} from '../lib/storage.js';
import { loadImageFile, processImageToDotMap } from '../lib/imageProcessor.js';
import { renderMosaic } from '../lib/mosaicRenderer.js';

// ── element refs ─────────────────────────────────────────────────────────────

const el = {
  addForm:        document.getElementById('add-form'),
  addInput:       document.getElementById('add-input'),
  todoList:       document.getElementById('todo-list'),
  listToolbar:    document.getElementById('list-toolbar'),
  clearCompleted: document.getElementById('clear-completed'),
  canvas:         document.getElementById('mosaic-canvas'),
  emptyState:     document.getElementById('empty-state'),
  progress:       document.getElementById('progress'),
  imageUpload:    document.getElementById('image-upload'),
  tabs:           document.querySelectorAll('.tab'),
  viewTasks:      document.getElementById('view-tasks'),
  viewMosaic:     document.getElementById('view-mosaic'),
};

// ── local state ───────────────────────────────────────────────────────────────
// These are display caches only. chrome.storage.onChanged is the single source
// of truth — handlers mutate storage, onChanged re-renders. No optimistic
// pushes, which eliminates the race where onChanged fires between a storage
// write and a manual push and causes a temporary duplicate.

let todos  = [];
let mosaic = null;

// ── boot ──────────────────────────────────────────────────────────────────────

async function init() {
  [todos, mosaic] = await Promise.all([getTodos(), getMosaic()]);
  renderTodos();

  el.addForm.addEventListener('submit', handleAddTodo);
  el.clearCompleted.addEventListener('click', () => clearCompleted());
  el.imageUpload.addEventListener('change', handleImageUpload);
  el.tabs.forEach(tab => tab.addEventListener('click', handleTabClick));

  chrome.storage.onChanged.addListener(handleStorageChanged);
}

// ── tab switching ─────────────────────────────────────────────────────────────

function handleTabClick(e) {
  const name = e.currentTarget.dataset.tab;
  el.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  el.viewTasks.classList.toggle('hidden', name !== 'tasks');
  el.viewMosaic.classList.toggle('hidden', name !== 'mosaic');
  if (name === 'mosaic') renderMosaicView();
}

// ── todo handlers ─────────────────────────────────────────────────────────────
// Each handler writes to storage and then stops. The onChanged listener below
// is responsible for updating the local cache and re-rendering the list.

async function handleAddTodo(e) {
  e.preventDefault();
  const title = el.addInput.value.trim();
  if (!title) return;
  el.addInput.value = '';
  await addTodo(title);
  // onChanged → renderTodos()
}

async function handleTodoCheck(id, checked) {
  if (checked) {
    const result = await completeTodo(id);
    // onChanged → renderTodos() and renderMosaicView()
    if (result) notifyContentScript();
  } else {
    await uncompleteTodo(id);
    // onChanged → renderTodos()
  }
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
    // onChanged (local, mosaic) → renderMosaicView()
  } catch (err) {
    el.progress.textContent = 'could not process image';
    console.error('[toodly]', err);
  }
  e.target.value = ''; // allow re-uploading the same file
}

// ── storage change listener ───────────────────────────────────────────────────
// Both todos and mosaic now live in chrome.storage.local.

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
  const sorted = [...todos].sort((a, b) => {
    if (a.completed === b.completed) return 0;
    return a.completed ? 1 : -1;
  });

  const hasCompleted = todos.some(t => t.completed);
  el.listToolbar.classList.toggle('hidden', !hasCompleted);

  el.todoList.innerHTML = '';
  for (const todo of sorted) {
    const li = document.createElement('li');
    li.className = 'todo-item' + (todo.completed ? ' done' : '');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'todo-check';
    check.checked = todo.completed;
    check.addEventListener('change', ev => handleTodoCheck(todo.id, ev.target.checked));

    const title = document.createElement('span');
    title.className = 'todo-title';
    title.textContent = todo.title;

    const remove = document.createElement('button');
    remove.className = 'todo-remove';
    remove.title = 'remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => handleTodoDelete(todo.id));

    li.append(check, title, remove);
    el.todoList.appendChild(li);
  }
}

function renderMosaicView() {
  if (!mosaic) {
    el.emptyState.classList.remove('hidden');
    el.progress.textContent = '';
    clearCanvas();
    return;
  }

  // Completed: activeImageId cleared but cells still present — show full reveal.
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

// ── content-script notification ───────────────────────────────────────────────

function notifyContentScript() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'TOODLY_TASK_COMPLETED' })
      .catch(() => { /* tab may not have a content script, e.g. chrome:// pages */ });
  });
}

init();
