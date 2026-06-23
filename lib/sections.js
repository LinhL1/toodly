/**
 * lib/sections.js — pure derived/computed logic for todo sections and ordering.
 * Nothing here reads from or writes to chrome.storage — that stays in storage.js.
 */

/**
 * Today's date as 'YYYY-MM-DD' in the user's LOCAL timezone.
 * Deliberately avoids toISOString() which returns UTC and misclassifies tasks
 * near midnight in most US/EU timezones.
 *
 * @returns {string}
 */
export function getTodayDateString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * A todo belongs to Today if it has no date or its date is exactly today.
 * Completion state is intentionally NOT a factor — a completed todo stays
 * in whichever section its date puts it in.
 *
 * @param {Object} todo
 * @param {string} todayStr — 'YYYY-MM-DD'
 * @returns {boolean}
 */
export function isInToday(todo, todayStr) {
  return todo.date == null || todo.date === todayStr;
}

/**
 * A todo belongs to Upcoming if its date is strictly in the future.
 *
 * @param {Object} todo
 * @param {string} todayStr — 'YYYY-MM-DD'
 * @returns {boolean}
 */
export function isInUpcoming(todo, todayStr) {
  return todo.date != null && todo.date > todayStr;
}

/**
 * A todo belongs to Archive if its date is strictly in the past.
 *
 * @param {Object} todo
 * @param {string} todayStr — 'YYYY-MM-DD'
 * @returns {boolean}
 */
export function isInArchive(todo, todayStr) {
  return todo.date != null && todo.date < todayStr;
}

/**
 * Sort todos chronologically, with manualOrder as a tiebreaker within groups
 * of tasks that share the same (date, time) value — including the all-null group.
 *
 * Sort key hierarchy:
 *  1. date  — null ('') sorts before any date string, i.e. undated tasks first
 *  2. time  — null ('') sorts before any time string within a date group
 *  3. manualOrder — resolves ties within the exact same (date, time) bucket
 *
 * This keeps section membership and sort order as two completely separate
 * concerns: this function never looks at todayStr.
 *
 * @param {Array} todos
 * @returns {Array} new sorted array (does not mutate input)
 */
export function sortTodos(todos) {
  return [...todos].sort((a, b) => {
    // Completed tasks always sink to the bottom, even if starred.
    const aC = a.completed ? 1 : 0;
    const bC = b.completed ? 1 : 0;
    if (aC !== bC) return aC - bC;

    // Among incomplete tasks, starred float to the top.
    const aS = a.starred ? 0 : 1;
    const bS = b.starred ? 0 : 1;
    if (aS !== bS) return aS - bS;

    const aDate = a.date ?? '';
    const bDate = b.date ?? '';
    if (aDate !== bDate) return aDate < bDate ? -1 : 1;

    const aTime = a.time ?? '';
    const bTime = b.time ?? '';
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;

    return (a.manualOrder ?? 0) - (b.manualOrder ?? 0);
  });
}
