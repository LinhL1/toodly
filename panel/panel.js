import {
  getTodos, addTodo, completeTodo, uncompleteTodo, deleteTodo,
  clearCompleted, clearCompletedBefore, reorderTiedGroup, toggleStar, updateTodo,
  getMosaic, setActiveMosaicImage, reorderMosaicBottomUp,
  getFocusSessions, addFocusSession,
  getGroups, createGroup, addTaskToGroup, removeTaskFromGroup,
  dissolveGroup, renameGroup, reorderGroupTasks, toggleGroupCollapsed, toggleGroupPinned,
  isExtension,
} from '../lib/storage.js';
import { loadImageURL, processImageToDotMap } from '../lib/imageProcessor.js';
import { renderMosaic } from '../lib/mosaicRenderer.js';
import { renderGrid } from '../lib/spiralRenderer.js';
import { getTodayDateString, isInToday, isInUpcoming, isInArchive, sortTodos } from '../lib/sections.js';

// ── element refs ──────────────────────────────────────────────────────────────

const el = {
  addForm:        document.getElementById('add-form'),
  addInput:       document.getElementById('add-input'),
  dateToggle:     document.getElementById('date-toggle'),
  addDateRow:     document.getElementById('add-date-row'),
  addDate:        document.getElementById('add-date'),
  addTime:        document.getElementById('add-time'),
  listToolbar:      document.getElementById('list-toolbar'),
  clearCompleted:   document.getElementById('clear-completed'),
  sectionPinned:    document.getElementById('section-pinned'),
  listPinned:       document.getElementById('list-pinned'),
  sectionGroups:    document.getElementById('section-groups'),
  listGroups:       document.getElementById('list-groups'),
  listToday:        document.getElementById('list-today'),
  listUpcoming:     document.getElementById('list-upcoming'),
  listArchive:      document.getElementById('list-archive'),
  sectionUpcoming:  document.getElementById('section-upcoming'),
  sectionArchive:   document.getElementById('section-archive'),
  canvas:         document.getElementById('mosaic-canvas'),
  emptyState:     document.getElementById('empty-state'),
  progress:       document.getElementById('progress'),
  tabs:           document.querySelectorAll('.tab'),
  viewTasks:      document.getElementById('view-tasks'),
  viewTimer:      document.getElementById('view-timer'),
  viewMosaic:     document.getElementById('view-mosaic'),
  sandCanvas:     document.getElementById('sand-canvas'),
  spiralCanvas:   document.getElementById('spiral-canvas'),
  spiralMeta:     document.getElementById('spiral-meta'),
  spiralTooltip:  document.getElementById('spiral-tooltip'),
  timerToggle:    document.getElementById('timer-toggle'),
  timerReset:     document.getElementById('timer-reset'),
  timerDigits:    null, // set by initTimer after segments are built
  timerDisplayArea: document.getElementById('timer-display-area'),
  timerSegDisplay:  document.getElementById('timer-seg-display'),
  timerInput:       document.getElementById('timer-input'),
};

// ── local state ───────────────────────────────────────────────────────────────
// Display caches only. onChanged is the single re-render trigger.

let todos          = [];
let mosaic         = null;
let focusSessions  = [];
let groups         = [];
let autoLoadingHeart = false;
let spiralDots     = [];
let editingId        = null;  // id of the todo currently open in inline edit mode
let editingFocusDate = false; // when true, auto-focus the date input instead of the title
let editingGroupId   = null;  // id of the group whose name is being edited inline
let pendingGroup     = null;  // { draggedId, targetId } — awaiting user grouping confirm

// ── timer state ───────────────────────────────────────────────────────────────

let timerDuration  = 25 * 60; // seconds
let timerRemaining = 25 * 60;
let timerRunning   = false;
let timerInterval  = null;
let timerLastMs    = null;    // wall-clock ms at last tick; delta drives decrement
let audioCtx       = null;   // created on first "start" click (user gesture) so Chrome allows it
let alarmTimer     = null;   // setInterval handle for the repeating alarm ring

// Hourglass dot grid — 10×10 cell positions, hourglass-shaped subset.
// Each half has 30 cells (row widths 10,8,6,4,2 = 30). 60 total.
//
// Upper half ordered top→bottom: surface falls from row 0 downward as sand drains.
// Lower half ordered bottom→top: sand accumulates from row 9 upward as it collects.
// At any elapsed fraction f, exactly round(f*30) cells have transitioned in each half,
// so the total solid-dot count is always 30 (sand is conserved, like a real hourglass).

const UPPER_CELLS = (() => {
  const cells = [];
  for (let row = 0; row <= 4; row++) {
    const width = 10 - row * 2, start = row;
    for (let col = start; col < start + width; col++) cells.push({ row, col });
  }
  return cells; // 10+8+6+4+2 = 30
})();

const LOWER_CELLS = (() => {
  const cells = [];
  for (let row = 9; row >= 5; row--) {
    const off = 9 - row, width = 10 - off * 2, start = off;
    for (let col = start; col < start + width; col++) cells.push({ row, col });
  }
  return cells; // 10+8+6+4+2 = 30
})();

const HGLASS_HALF = 30;

// ── drag state ────────────────────────────────────────────────────────────────

let dragId      = null;  // id of the item being dragged
let dragDate    = null;  // its date (null = undated)
let dragTime    = null;  // its time (null = untimed)
let dragGroupId = null;  // groupId of the dragged item, or null
let dropInfo    = null;  // { id, position: 'above'|'below'|'onto' } of the current target

// ── auto-load heart ───────────────────────────────────────────────────────────

async function autoLoadHeart() {
  if (autoLoadingHeart) return;
  autoLoadingHeart = true;
  try {
    const heartUrl = isExtension
      ? chrome.runtime.getURL('assets/heart.png')
      : '../assets/heart.png';
    const img    = await loadImageURL(heartUrl);
    const dotMap = processImageToDotMap(img);
    await setActiveMosaicImage(crypto.randomUUID(), dotMap);
  } catch (err) {
    console.error('[toodly] failed to load heart.png', err);
  } finally {
    autoLoadingHeart = false;
  }
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function init() {
  [todos, mosaic, focusSessions, groups] = await Promise.all([getTodos(), getMosaic(), getFocusSessions(), getGroups()]);
  await clearCompletedBefore(getTodayDateString()); // sweep tasks completed on prior days
  await reorderMosaicBottomUp();                    // migrate existing mosaic to bottom-up fill
  renderTodos();
  startClock();
  initTimer();

  // Auto-load the fixed heart image if there's no active mosaic yet.
  if (!mosaic || !mosaic.activeImageId) autoLoadHeart();

  el.addForm.addEventListener('submit', handleAddTodo);
  el.dateToggle.addEventListener('click', handleDateToggle);
  el.addDate.addEventListener('change', () => {
    if (el.addDate.value) {
      el.addTime.classList.remove('hidden');
    } else {
      el.addTime.value = '';
      el.addTime.classList.add('hidden');
    }
  });
  // date/time inputs don't propagate Enter to the form's submit handler natively.
  [el.addDate, el.addTime].forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && el.addInput.value.trim()) el.addForm.requestSubmit();
    });
  });
  el.clearCompleted.addEventListener('click', () => clearCompleted());
  el.tabs.forEach(tab => tab.addEventListener('click', handleTabClick));

  if (el.spiralCanvas) {
    el.spiralCanvas.addEventListener('mousemove', handleSpiralHover);
    el.spiralCanvas.addEventListener('mouseleave', hideSpiralTooltip);
  }

  if (isExtension) {
    chrome.storage.onChanged.addListener(handleStorageChanged);
  } else {
    window.addEventListener('toodly:changed', e =>
      handleStorageChanged(e.detail.changes, 'local')
    );
  }

  // Recompute sections and sweep old completed tasks in case the panel stays open past midnight.
  setInterval(() => { renderTodos(); clearCompletedBefore(getTodayDateString()); }, 3 * 60 * 1000);
}

// ── tab switching ─────────────────────────────────────────────────────────────

function handleTabClick(e) {
  const name = e.currentTarget.dataset.tab;
  el.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  el.viewTasks.classList.toggle('hidden', name !== 'tasks');
  el.viewTimer.classList.toggle('hidden', name !== 'timer');
  el.viewMosaic.classList.toggle('hidden', name !== 'mosaic');
  if (name === 'mosaic') { renderMosaicView(); renderSpiralView(); }
  if (name === 'timer') drawSandTimer(); // canvas needs a paint after becoming visible
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
    el.addTime.classList.add('hidden');
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
  el.addTime.classList.add('hidden');
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
  if (editingId === id) editingId = null;
  if (pendingGroup?.draggedId === id || pendingGroup?.targetId === id) pendingGroup = null;
  await deleteTodo(id);
  // onChanged → renderTodos()
}

async function handleTodoStar(id) {
  await toggleStar(id);
  // onChanged → renderTodos()
}

// ── storage change listener ───────────────────────────────────────────────────

function handleStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (changes.todos) {
    todos = changes.todos.newValue ?? [];
    renderTodos();
  }
  if (changes.groups) {
    groups = changes.groups.newValue ?? [];
    renderTodos();
  }
  if (changes.mosaic) {
    mosaic = changes.mosaic.newValue ?? null;
    if (!mosaic || !mosaic.activeImageId) {
      autoLoadHeart();
    } else if (!el.viewMosaic.classList.contains('hidden')) {
      renderMosaicView();
    }
  }
  if (changes.focusSessions) {
    focusSessions = changes.focusSessions.newValue ?? [];
    if (!el.viewMosaic.classList.contains('hidden')) renderSpiralView();
  }
}

// ── rendering ─────────────────────────────────────────────────────────────────

function renderTodos() {
  const today      = getTodayDateString();
  const sorted     = sortTodos(todos);
  const ungrouped  = sorted.filter(t => !t.groupId);
  const inToday    = ungrouped.filter(t => isInToday(t, today));
  const inUpcoming = ungrouped.filter(t => isInUpcoming(t, today));
  const inArchive  = ungrouped.filter(t => isInArchive(t, today));

  const byOrder = (a, b) => (a.manualOrder ?? 0) - (b.manualOrder ?? 0);
  const pinnedGroups  = groups.filter(g =>  g.pinnedAboveToday).sort(byOrder);
  const regularGroups = groups.filter(g => !g.pinnedAboveToday).sort(byOrder);

  const hasCompleted = todos.some(t => t.completed);
  el.listToolbar.classList.toggle('hidden', !hasCompleted);
  el.sectionPinned.classList.toggle('hidden',  pinnedGroups.length === 0);
  el.sectionGroups.classList.toggle('hidden',  regularGroups.length === 0);
  el.sectionUpcoming.classList.toggle('hidden', inUpcoming.length === 0);
  el.sectionArchive.classList.toggle('hidden',  inArchive.length === 0);

  buildGroupList(el.listPinned,  sorted, pinnedGroups);
  buildGroupList(el.listGroups,  sorted, regularGroups);
  buildList(el.listToday,    inToday);
  buildList(el.listUpcoming, inUpcoming);
  buildList(el.listArchive,  inArchive);
}

function buildList(ul, items) {
  ul.innerHTML = '';
  for (const todo of items) ul.appendChild(buildItem(todo));
}

function buildGroupList(ul, sortedTodos, groupList) {
  ul.innerHTML = '';
  for (const group of groupList) ul.appendChild(buildGroupItem(group, sortedTodos));
}

function buildGroupItem(group, sortedTodos) {
  const li = document.createElement('li');
  li.className = 'group-item' + (group.pinnedAboveToday ? ' group-item--pinned' : '');
  li.dataset.groupId = group.id;

  // ── header ──────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'group-header';

  const toggle = document.createElement('button');
  toggle.className   = 'group-toggle';
  toggle.textContent = group.collapsed ? '▸' : '▾';
  toggle.addEventListener('click', () => toggleGroupCollapsed(group.id));

  header.appendChild(toggle);

  if (editingGroupId === group.id) {
    const input = document.createElement('input');
    input.type         = 'text';
    input.className    = 'group-name-input';
    input.value        = group.name;
    input.autocomplete = 'off';

    let closed = false;
    const doSave = () => {
      if (closed) return; closed = true;
      const n = input.value.trim();
      editingGroupId = null;
      if (n) {
        const g = groups.find(g => g.id === group.id);
        if (g) g.name = n; // optimistic local update
        renameGroup(group.id, n); // persist async
      }
      renderTodos();
    };
    const doCancel = () => {
      if (closed) return; closed = true;
      editingGroupId = null;
      renderTodos();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
    });
    input.addEventListener('blur', doSave);
    header.appendChild(input);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  } else {
    const nameSpan = document.createElement('span');
    nameSpan.className   = 'group-name';
    nameSpan.textContent = group.name;
    nameSpan.addEventListener('click', () => { editingGroupId = group.id; renderTodos(); });

    const pinBtn = document.createElement('button');
    pinBtn.className = 'group-pin';
    pinBtn.title     = group.pinnedAboveToday ? 'unpin from top' : 'pin above today';
    pinBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="3.5" cy="3.5" r="2.5" fill="currentColor"/><line x1="5.5" y1="5.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    pinBtn.addEventListener('click', () => toggleGroupPinned(group.id));

    const ungroupBtn = document.createElement('button');
    ungroupBtn.className   = 'group-ungroup';
    ungroupBtn.textContent = 'ungroup';
    ungroupBtn.addEventListener('click', () => dissolveGroup(group.id));

    header.appendChild(nameSpan);
    header.appendChild(pinBtn);
    header.appendChild(ungroupBtn);
  }

  // ── header as drop target (add any dragged task to this group) ───────────────
  header.addEventListener('dragover', e => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    clearDropIndicators();
    header.classList.add('drop-onto');
  });
  header.addEventListener('dragleave', e => {
    if (!header.contains(e.relatedTarget)) header.classList.remove('drop-onto');
  });
  header.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    header.classList.remove('drop-onto');
    if (dragId) addTaskToGroup(dragId, group.id);
    clearDragState();
  });

  li.appendChild(header);

  // ── member tasks ─────────────────────────────────────────────────────────────
  if (!group.collapsed) {
    const memberUl = document.createElement('ul');
    memberUl.className = 'group-members';

    const members = group.taskIds
      .map(id => sortedTodos.find(t => t.id === id))
      .filter(Boolean);

    for (const task of members) memberUl.appendChild(buildItem(task));
    li.appendChild(memberUl);
  }

  return li;
}

function buildItem(todo) {
  // When this task is the pending group target, show only the confirm prompt.
  if (pendingGroup?.targetId === todo.id) {
    const li = document.createElement('li');
    li.className = 'todo-item group-confirm-item';
    li.dataset.id = todo.id;

    const label = document.createElement('span');
    label.className   = 'group-confirm-label';
    label.textContent = 'Confirm task group?';

    const yes = document.createElement('button');
    yes.className   = 'group-confirm-btn';
    yes.textContent = 'y';
    yes.addEventListener('click', async () => {
      const { draggedId, targetId } = pendingGroup;
      pendingGroup = null;
      const g = await createGroup('group', targetId, draggedId);
      editingGroupId = g.id;
      renderTodos();
    });

    const no = document.createElement('button');
    no.className   = 'group-confirm-btn';
    no.textContent = 'n';
    no.addEventListener('click', () => { pendingGroup = null; renderTodos(); });

    li.append(label, yes, no);
    return li;
  }

  const isEditing = todo.id === editingId;

  const li = document.createElement('li');
  li.className = 'todo-item' + (todo.completed ? ' done' : '') + (todo.starred ? ' starred' : '');
  li.draggable = !isEditing;
  li.dataset.id = todo.id;

  if (!isEditing) {
    li.addEventListener('dragstart', e  => handleDragStart(e, todo));
    li.addEventListener('dragover',  e  => { handleDragOver(e, todo); e.stopPropagation(); });
    li.addEventListener('dragleave', e  => handleDragLeave(e));
    li.addEventListener('drop',      e  => { e.stopPropagation(); handleDrop(e, todo); });
    li.addEventListener('dragend',   () => clearDragState());
  }

  const check = document.createElement('input');
  check.type      = 'checkbox';
  check.className = 'todo-check';
  check.checked   = todo.completed;
  check.addEventListener('change', ev => handleTodoCheck(todo.id, ev.target.checked));

  const star = document.createElement('button');
  star.className   = 'todo-star' + (todo.starred ? ' is-starred' : '');
  star.title       = todo.starred ? 'unstar' : 'star';
  star.textContent = todo.starred ? '★' : '☆';
  star.addEventListener('click', () => handleTodoStar(todo.id));

  const remove = document.createElement('button');
  remove.className   = 'todo-remove';
  remove.title       = 'remove';
  remove.textContent = '×';
  remove.addEventListener('click', () => handleTodoDelete(todo.id));

  li.appendChild(check);

  if (isEditing) {
    // ── inline edit form: title input + date/time row ─────────────────────────
    const wrap = document.createElement('div');
    wrap.className = 'todo-edit-wrap';

    const titleIn = document.createElement('input');
    titleIn.type         = 'text';
    titleIn.className    = 'todo-edit-title';
    titleIn.value        = todo.title;
    titleIn.autocomplete = 'off';

    const dateRow = document.createElement('div');
    dateRow.className = 'todo-edit-date-row';

    const dateIn = document.createElement('input');
    dateIn.type      = 'date';
    dateIn.className = 'date-input';
    dateIn.value     = todo.date ?? '';

    const timeIn = document.createElement('input');
    timeIn.type      = 'time';
    timeIn.className = 'time-input';
    timeIn.value     = todo.time ?? '';
    if (!todo.date) timeIn.classList.add('hidden');

    dateIn.addEventListener('change', () => {
      if (dateIn.value) timeIn.classList.remove('hidden');
      else { timeIn.value = ''; timeIn.classList.add('hidden'); }
    });

    // One-shot flag prevents double-call from Enter + deferred mousedown.
    let editClosed = false;

    const doSave = () => {
      if (editClosed) return;
      editClosed = true;
      document.removeEventListener('mousedown', onOutsideClick, true);

      const newTitle = titleIn.value.trim();
      const date     = dateIn.value || null;
      const time     = (date && timeIn.value) ? timeIn.value : null;

      // Only clear editingId and re-render if we still own the edit slot.
      // If another task's click already set editingId to its id, don't disrupt it.
      const weOwn = editingId === todo.id;
      if (weOwn) editingId = null;

      if (!newTitle) {
        if (weOwn) renderTodos();
        return;
      }

      // Optimistically patch in-memory todos so renderTodos() shows the correct
      // value immediately — onChanged may not fire if nothing actually changed.
      const mem = todos.find(t => t.id === todo.id);
      if (mem) { mem.title = newTitle; mem.date = date; mem.time = time; }

      if (weOwn) renderTodos();
      updateTodo(todo.id, { title: newTitle, date, time }); // persist
    };

    const doCancel = () => {
      if (editClosed) return;
      editClosed = true;
      document.removeEventListener('mousedown', onOutsideClick, true);
      if (editingId === todo.id) { editingId = null; renderTodos(); }
    };

    titleIn.addEventListener('keydown', e => {
      if (e.key === 'Enter')  doSave();
      if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
    });
    [dateIn, timeIn].forEach(inp => inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  doSave();
      if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
    }));

    // Click outside the task item → save. Uses mousedown (not focusout) so it
    // fires even when clicking non-focusable elements like section labels.
    // setTimeout defers so click handlers on the clicked element (another task's
    // title, star, delete) fire on their original DOM nodes before re-render.
    const onOutsideClick = e => {
      if (!li.contains(e.target)) setTimeout(doSave, 0);
    };
    document.addEventListener('mousedown', onOutsideClick, true);

    dateRow.append(dateIn, timeIn);
    wrap.append(titleIn, dateRow);
    li.appendChild(wrap);

    requestAnimationFrame(() => {
      if (editingFocusDate) dateIn.focus();
      else { titleIn.focus(); titleIn.select(); }
      editingFocusDate = false;
    });

  } else {
    // ── display mode ──────────────────────────────────────────────────────────
    const titleSpan = document.createElement('span');
    titleSpan.className   = 'todo-title';
    titleSpan.textContent = todo.title;
    titleSpan.addEventListener('click', () => {
      editingId = todo.id; editingFocusDate = false; renderTodos();
    });
    li.appendChild(titleSpan);

    if (todo.date) {
      const dateSpan = document.createElement('span');
      dateSpan.className   = 'todo-date';
      dateSpan.title       = 'edit date';
      dateSpan.textContent = formatTodoDate(todo.date, todo.time);
      dateSpan.addEventListener('click', () => {
        editingId = todo.id; editingFocusDate = true; renderTodos();
      });
      li.appendChild(dateSpan);
    } else {
      const addDateBtn = document.createElement('button');
      addDateBtn.className   = 'todo-date-add';
      addDateBtn.textContent = 'edit';
      addDateBtn.addEventListener('click', () => {
        editingId = todo.id; editingFocusDate = true; renderTodos();
      });
      li.appendChild(addDateBtn);
    }
  }

  li.append(star, remove);
  return li;
}

// ── drag-and-drop ─────────────────────────────────────────────────────────────

// Drop zone thresholds: top/bottom 20% = reorder, middle 60% = onto (group).
const ONTO_TOP = 0.2;
const ONTO_BOT = 0.8;

function getDropZone(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const rel  = (e.clientY - rect.top) / rect.height;
  return rel < ONTO_TOP ? 'above' : rel > ONTO_BOT ? 'below' : 'onto';
}

function handleDragStart(e, todo) {
  dragId      = todo.id;
  dragDate    = todo.date ?? null;
  dragTime    = todo.time ?? null;
  dragGroupId = todo.groupId ?? null;
  e.dataTransfer.effectAllowed = 'move';
  requestAnimationFrame(() => e.target.classList.add('dragging'));
}

function handleDragOver(e, todo) {
  if (todo.id === dragId) { e.dataTransfer.dropEffect = 'none'; return; }

  const pos = getDropZone(e);

  if (pos === 'onto') {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropIndicators();
    e.currentTarget.classList.add('drop-onto');
    dropInfo = { id: todo.id, position: 'onto' };
    return;
  }

  // above/below — gate logic
  const sameGroup    = dragGroupId && dragGroupId === todo.groupId;
  const fromGroup    = !!dragGroupId;
  const bothUngrouped = !dragGroupId && !todo.groupId;
  const sameTie      = (todo.date ?? null) === dragDate && (todo.time ?? null) === dragTime;

  // Allow: same-group reorder, drag-out-of-group, ungrouped same-tied-group reorder
  const allowed = sameGroup || (fromGroup && !todo.groupId) || (bothUngrouped && sameTie);
  if (!allowed) { e.dataTransfer.dropEffect = 'none'; return; }

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropIndicators();
  e.currentTarget.classList.add(pos === 'above' ? 'drop-above' : 'drop-below');
  dropInfo = { id: todo.id, position: pos };
}

function handleDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('drop-above', 'drop-below', 'drop-onto');
  }
}

function handleDrop(e, todo) {
  e.preventDefault();
  if (!dragId || !dropInfo) { clearDragState(); return; }

  const { id: targetId, position } = dropInfo;

  if (position === 'onto') {
    handleDropOnto(dragId, targetId);
    clearDragState();
    return;
  }

  const targetTodo = todos.find(t => t.id === targetId);

  if (dragGroupId && dragGroupId === targetTodo?.groupId) {
    // Reorder within same group
    const grp = groups.find(g => g.id === dragGroupId);
    if (grp) {
      const ids = [...grp.taskIds];
      ids.splice(ids.indexOf(dragId), 1);
      const ti = ids.indexOf(targetId);
      if (ti !== -1) ids.splice(position === 'above' ? ti : ti + 1, 0, dragId);
      reorderGroupTasks(dragGroupId, ids);
    }
  } else if (dragGroupId && !targetTodo?.groupId) {
    // Drag out of group — ungroup and drop into flat list at natural position
    removeTaskFromGroup(dragId);
  } else {
    // Ungrouped reorder — existing tied-group logic
    const tiedGroup = sortTodos(
      todos.filter(t => !t.groupId && (t.date ?? null) === dragDate && (t.time ?? null) === dragTime)
    );
    const ids = tiedGroup.map(t => t.id);
    ids.splice(ids.indexOf(dragId), 1);
    const ti = ids.indexOf(targetId);
    if (ti !== -1) ids.splice(position === 'above' ? ti : ti + 1, 0, dragId);
    reorderTiedGroup(ids);
  }

  clearDragState();
}

function handleDropOnto(draggedId, targetId) {
  const targetTodo = todos.find(t => t.id === targetId);
  if (targetTodo?.groupId) {
    // Target already in a group — add dragged task to it
    addTaskToGroup(draggedId, targetTodo.groupId);
    return;
  }
  // Both ungrouped (or dragged from another group onto ungrouped task) — ask to confirm
  pendingGroup = { draggedId, targetId };
  renderTodos();
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-above, .drop-below, .drop-onto')
    .forEach(el => el.classList.remove('drop-above', 'drop-below', 'drop-onto'));
}

function clearDragState() {
  clearDropIndicators();
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  dragId      = null;
  dragDate    = null;
  dragTime    = null;
  dragGroupId = null;
  dropInfo    = null;
}

// ── mosaic rendering ──────────────────────────────────────────────────────────

function renderMosaicView() {
  if (!mosaic || !mosaic.activeImageId) {
    el.emptyState.classList.remove('hidden');
    el.progress.textContent = '';
    clearCanvas();
    return;
  }

  el.emptyState.classList.add('hidden');
  el.progress.textContent = `${mosaic.totalRevealed} / ${mosaic.revealOrder.length} revealed`;
  const completedCount = mosaic.completedImages?.length ?? 0;
  requestAnimationFrame(() =>
    renderMosaic(el.canvas, mosaic, { showGhost: true, previewAll: false, completedCount })
  );
}

function renderSpiralView() {
  if (!el.spiralCanvas) return;
  const year = new Date().getFullYear();
  requestAnimationFrame(() => {
    const { dots } = renderGrid(el.spiralCanvas, focusSessions, { year });
    spiralDots = dots;
  });
  if (el.spiralMeta) {
    const yStr = String(year);
    const yearSessions = focusSessions.filter(s => s.date.startsWith(yStr));
    if (yearSessions.length === 0) {
      el.spiralMeta.textContent = 'complete a timer session to begin';
    } else {
      const activeDays = new Set(yearSessions.map(s => s.date)).size;
      const total = yearSessions.reduce((s, sess) => s + sess.durationMinutes, 0);
      el.spiralMeta.textContent =
        `${activeDays} day${activeDays !== 1 ? 's' : ''} · ${yearSessions.length} session${yearSessions.length !== 1 ? 's' : ''} · ${total} min`;
    }
  }
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

// ── 7-segment display helpers (shared by clock and timer) ────────────────────

// Segments lit for each digit 0–9 (standard naming: a = top bar, g = middle, etc.)
const SEG_MAP = [
  'abcdef',   // 0
  'bc',        // 1
  'abdeg',     // 2
  'abcdg',     // 3
  'bcfg',      // 4
  'acdfg',     // 5
  'acdefg',    // 6
  'abc',       // 7
  'abcdefg',   // 8
  'abcdfg',    // 9
];

function buildSegmentSpans(digitEl) {
  for (const s of 'abcdefg') {
    const span = document.createElement('span');
    span.className = `seg seg-${s}`;
    span.dataset.seg = s;
    digitEl.appendChild(span);
  }
}

function setSegmentDigit(digitEl, n) {
  const lit = SEG_MAP[n] ?? '';
  digitEl.querySelectorAll('.seg').forEach(span => {
    span.classList.toggle('on', lit.includes(span.dataset.seg));
  });
}

// ── live clock ────────────────────────────────────────────────────────────────

function startClock() {
  const digitEls = [0, 1, 2, 3, 4, 5].map(i => {
    const digitEl = document.getElementById(`d${i}`);
    buildSegmentSpans(digitEl);
    return digitEl;
  });

  function tick() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    [Math.floor(h / 10), h % 10,
     Math.floor(m / 10), m % 10,
     Math.floor(s / 10), s % 10]
      .forEach((d, i) => setSegmentDigit(digitEls[i], d));
  }

  tick();
  setInterval(tick, 1000);
}

// ── sand timer ────────────────────────────────────────────────────────────────

function initTimer() {
  // Build segment spans for the 4-digit MM:SS display.
  el.timerDigits = [0, 1, 2, 3].map(i => {
    const digitEl = document.getElementById(`td${i}`);
    buildSegmentSpans(digitEl);
    return digitEl;
  });

  renderTimerDisplay();
  drawSandTimer();

  // Preset buttons — only active when timer is not running.
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (timerRunning) return;
      stopAlarm();
      const minutes = parseInt(btn.dataset.minutes, 10);
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      timerDuration  = minutes * 60;
      timerRemaining = timerDuration;
      el.timerToggle.textContent = 'start';
      el.timerToggle.disabled = false;
      renderTimerDisplay();
      drawSandTimer();
    });
  });

  el.timerToggle.addEventListener('click', handleTimerToggle);
  el.timerReset.addEventListener('click', handleTimerReset);

  // Space bar toggles pause/resume while the timer is running.
  // Ignored when an input or textarea has focus so typing isn't intercepted.
  document.addEventListener('keydown', e => {
    if (e.key !== ' ') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!timerRunning && timerRemaining === timerDuration) return; // not yet started
    e.preventDefault();
    handleTimerToggle();
  });

  // Click display to enter custom-time edit mode (only when not running).
  el.timerDisplayArea.addEventListener('click', () => {
    if (timerRunning) return;
    enterTimerEdit();
  });

  el.timerInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (exitTimerEdit(true)) handleTimerToggle(); }
    if (e.key === 'Escape') { exitTimerEdit(false); }
  });
  el.timerInput.addEventListener('blur', () => exitTimerEdit(true));
}

function enterTimerEdit() {
  const m = Math.floor(timerRemaining / 60);
  const s = timerRemaining % 60;
  el.timerInput.value = `${m}:${String(s).padStart(2, '0')}`;
  el.timerDisplayArea.classList.add('editing');
  el.timerInput.classList.remove('hidden');
  el.timerInput.focus();
  el.timerInput.select();
}

function exitTimerEdit(commit) {
  // Guard: blur fires synchronously when the input is hidden inside this same
  // function, which would cause a double-call. The editing class is removed
  // first, so any re-entrant call returns immediately.
  if (!el.timerDisplayArea.classList.contains('editing')) return false;
  el.timerDisplayArea.classList.remove('editing');
  el.timerInput.classList.add('hidden');

  if (!commit) { renderTimerDisplay(); return false; }

  const raw = el.timerInput.value.trim();
  let total = null;

  if (/^\d+:\d{1,2}$/.test(raw)) {
    const [m, s] = raw.split(':').map(Number);
    if (s < 60) total = m * 60 + s;
  } else if (/^\d+$/.test(raw)) {
    total = Number(raw) * 60; // bare number → minutes
  }

  if (total && total > 0) {
    timerDuration  = total;
    timerRemaining = total;
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    el.timerToggle.textContent = 'start';
    el.timerToggle.disabled = false;
    drawSandTimer();
    renderTimerDisplay();
    return true;
  }

  renderTimerDisplay();
  return false;
}

function handleTimerToggle() {
  if (timerRunning) {
    timerRunning = false;
    clearInterval(timerInterval);
    timerInterval = null;
    el.timerToggle.textContent = 'start';
  } else {
    if (timerRemaining === 0) return;
    stopAlarm();
    // AudioContext must be created/resumed inside a user-gesture handler.
    // Storing it here lets timerTick (a setInterval callback) reuse the
    // already-unlocked context when the timer finishes.
    try {
      if (!audioCtx) audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (_) {}
    timerRunning = true;
    timerLastMs  = Date.now();
    el.timerToggle.textContent = 'pause';
    timerInterval = setInterval(timerTick, 200);
  }
}

function handleTimerReset() {
  stopAlarm();
  timerRunning = false;
  clearInterval(timerInterval);
  timerInterval = null;
  timerRemaining = timerDuration;
  el.timerToggle.textContent = 'start';
  el.timerToggle.disabled = false;
  renderTimerDisplay();
  drawSandTimer();
}

function timerTick() {
  const now   = Date.now();
  const delta = Math.floor((now - timerLastMs) / 1000);
  if (delta < 1) return;
  timerLastMs   += delta * 1000; // advance by whole seconds to avoid drift
  timerRemaining = Math.max(0, timerRemaining - delta);
  renderTimerDisplay();
  drawSandTimer();
  if (timerRemaining === 0) {
    timerRunning = false;
    clearInterval(timerInterval);
    timerInterval = null;
    el.timerToggle.textContent = 'done';
    el.timerToggle.disabled = true;
    startAlarm();
    addFocusSession({ durationMinutes: Math.round(timerDuration / 60) });
  }
}

function playAlarmBurst() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  // "di-da" two-tone pattern: 1000 Hz → 1250 Hz, 400 ms each, 500 ms apart.
  [[1000, 0], [1250, 0.5]].forEach(([freq, offset]) => {
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = audioCtx.currentTime + offset;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.3, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}

function startAlarm() {
  if (alarmTimer) return;
  playAlarmBurst();
  alarmTimer = setInterval(playAlarmBurst, 1800);
}

function stopAlarm() {
  clearInterval(alarmTimer);
  alarmTimer = null;
}

function renderTimerDisplay() {
  if (!el.timerDigits) return;
  const m = Math.floor(timerRemaining / 60);
  const s = timerRemaining % 60;
  [Math.floor(m / 10), m % 10, Math.floor(s / 10), s % 10]
    .forEach((d, i) => setSegmentDigit(el.timerDigits[i], d));
}

function drawSandTimer() {
  const canvas = el.sandCanvas;
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const w   = canvas.clientWidth;
  const h   = canvas.clientHeight;
  if (w === 0 || h === 0) return;

  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cellW = w / 10;
  const cellH = h / 10;
  const r     = Math.min(cellW, cellH) * 0.22;

  ctx.fillStyle = '#fafaf8';
  ctx.fillRect(0, 0, w, h);

  const elapsed      = timerDuration - timerRemaining;
  const f            = timerDuration > 0 ? elapsed / timerDuration : 0;
  const transitioned = Math.round(f * HGLASS_HALF);

  function dot(row, col, solid) {
    ctx.beginPath();
    ctx.arc((col + 0.5) * cellW, (row + 0.5) * cellH, solid ? r : r * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = solid ? 'rgba(26,26,26,0.85)' : 'rgba(26,26,26,0.07)';
    ctx.fill();
  }

  // Upper half — starts solid, surface falls from row 0 downward.
  UPPER_CELLS.forEach(({ row, col }, i) => dot(row, col, i >= transitioned));

  // Lower half — starts ghost, sand collects from row 9 upward.
  LOWER_CELLS.forEach(({ row, col }, i) => dot(row, col, i < transitioned));
}

// ── spiral hover ──────────────────────────────────────────────────────────────

function handleSpiralHover(e) {
  if (!el.spiralTooltip || spiralDots.length === 0) return;
  const rect = el.spiralCanvas.getBoundingClientRect();
  const mx   = e.clientX - rect.left;
  const my   = e.clientY - rect.top;
  const hit  = spiralDots.find(d => Math.hypot(mx - d.px, my - d.py) <= d.r);
  if (hit) {
    el.spiralTooltip.textContent = formatSpiralDot(hit.date, hit.minutes);
    el.spiralTooltip.classList.remove('hidden');
    el.spiralTooltip.style.left = (e.clientX + 12) + 'px';
    el.spiralTooltip.style.top  = Math.max(4, e.clientY - 32) + 'px';
  } else {
    hideSpiralTooltip();
  }
}

function hideSpiralTooltip() {
  if (el.spiralTooltip) el.spiralTooltip.classList.add('hidden');
}

function formatSpiralDot(dateStr, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const date   = `${months[m - 1]} ${d}, ${y}`;
  if (minutes === 0) return date;
  const h   = Math.floor(minutes / 60);
  const min = minutes % 60;
  const time = h > 0 ? (min > 0 ? `${h}h ${min}m` : `${h}h`) : `${minutes}m`;
  return `${date} · ${time}`;
}

// ── content-script notification ───────────────────────────────────────────────

function notifyContentScript() {
  if (!isExtension) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'TOODLY_TASK_COMPLETED' })
      .catch(() => { /* tab may not have a content script, e.g. chrome:// pages */ });
  });
}

init();
