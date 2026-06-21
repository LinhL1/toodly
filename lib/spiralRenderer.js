/**
 * lib/spiralRenderer.js — canvas renderer for the focus-session year grid.
 *
 * Shows a compact dot grid for the current calendar year: one dot per day,
 * ordered Jan 1 (top-left) → Dec 31 (bottom-right) in a 20-column × 19-row
 * layout that fills the square canvas.
 *
 * Future days (after today) are not drawn — slots are left empty so the
 * "filled" portion of the grid grows visibly through the year.
 *
 * Past days with no sessions render as ghost dots (very faint + small).
 * Days with sessions use weight-based radius and opacity:
 *   weight = √(min(minutes, 120) / 120)
 *
 * Returns a `dots` array for hit-testing (hover tooltips in panel.js).
 */

import { getTodayDateString } from './sections.js';

const COLS = 20;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array} sessions — FocusSession records from storage
 * @param {{ year: number }} opts
 * @returns {{ dots: Array<{px,py,r,date,minutes}> }}
 */
export function renderGrid(canvas, sessions, { year } = {}) {
  const dpr  = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (size === 0 || !year) return { dots: [] };

  const todayStr = getTodayDateString();

  // --- build date list: every calendar day in the year ---------------------
  const isLeap  = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const yearLen = isLeap ? 366 : 365;
  const dates   = [];
  const d0      = new Date(year + '-01-01T12:00:00');
  for (let i = 0; i < yearLen; i++) {
    const d  = new Date(d0);
    d.setDate(d0.getDate() + i);
    const y  = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${mo}-${dy}`);
  }

  // --- daily minutes map (current year only) --------------------------------
  const yStr = String(year);
  const minutesByDate = new Map();
  for (const s of sessions) {
    if (s.date.startsWith(yStr)) {
      minutesByDate.set(s.date, (minutesByDate.get(s.date) ?? 0) + s.durationMinutes);
    }
  }

  // --- grid geometry -------------------------------------------------------
  const ROWS     = Math.ceil(yearLen / COLS); // 19 for both 365 and 366
  const padding  = 8;
  const cellSize = Math.min(
    (size - 2 * padding) / COLS,
    (size - 2 * padding) / ROWS
  );
  const gridW    = COLS * cellSize;
  const gridH    = ROWS * cellSize;
  const offsetX  = (size - gridW) / 2;
  const offsetY  = (size - gridH) / 2;

  const maxDotR   = cellSize * 0.38;
  const ghostDotR = maxDotR * 0.35;

  // --- draw ----------------------------------------------------------------
  canvas.width  = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fafaf8';
  ctx.fillRect(0, 0, size, size);

  const dots = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    if (date > todayStr) continue; // future days: leave empty

    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const px  = offsetX + (col + 0.5) * cellSize;
    const py  = offsetY + (ROWS - 1 - row + 0.5) * cellSize;

    const minutes = minutesByDate.get(date) ?? 0;

    let r, alpha;
    if (minutes === 0) {
      r     = ghostDotR;
      alpha = 0.07;
    } else {
      const weight = Math.sqrt(Math.min(minutes, 120) / 120);
      r     = ghostDotR + (maxDotR - ghostDotR) * weight;
      alpha = 0.07 + 0.78 * weight;
    }

    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(26,26,26,${alpha.toFixed(3)})`;
    ctx.fill();

    // Minimum hit radius of 5px keeps ghost dots hoverable.
    dots.push({ px, py, r: Math.max(r, 5), date, minutes });
  }

  return { dots };
}
