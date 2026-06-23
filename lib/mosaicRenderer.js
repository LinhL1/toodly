/**
 * lib/mosaicRenderer.js — shared canvas renderer.
 * Used for both upload preview (previewAll: true) and live reveal (previewAll: false).
 *
 * Dot radius scales with cell.weight, producing a halftone density look:
 * dark areas → large dots, bright areas → small dots.
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Object} mosaic — mosaic state from storage
 * @param {{ showGhost?: boolean, previewAll?: boolean, completedCount?: number }} options
 */
export function renderMosaic(canvas, mosaic, { showGhost = true, previewAll = false, completedCount = 0 } = {}) {
  const { grid, cells } = mosaic;
  const dpr = window.devicePixelRatio || 1;

  const size = canvas.clientWidth;
  if (size === 0) return;

  canvas.width = size * dpr;
  canvas.height = size * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#fafaf8';
  ctx.fillRect(0, 0, size, size);

  const cellW = size / grid.cols;
  const cellH = size / grid.rows;
  const r      = Math.min(cellW, cellH) * 0.22;
  const ghostR = r * 0.5;

  // Completed hearts drawn as a cumulative ghost layer behind the active one.
  // Each completion adds opacity so progress is visible but not overwhelming.
  if (completedCount > 0) {
    ctx.fillStyle = '#1a1a1a';
    ctx.globalAlpha = Math.min(completedCount * 0.1, 0.45);
    for (const cell of cells) {
      if (cell.excluded) continue;
      ctx.beginPath();
      ctx.arc((cell.x + 0.5) * cellW, (cell.y + 0.5) * cellH, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.fillStyle = '#1a1a1a';
  for (const cell of cells) {
    if (cell.excluded) continue;

    const cx = (cell.x + 0.5) * cellW;
    const cy = (cell.y + 0.5) * cellH;

    if (cell.revealed || previewAll) {
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (showGhost) {
      ctx.globalAlpha = 0.07;
      ctx.beginPath();
      ctx.arc(cx, cy, ghostR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.globalAlpha = 1;
}
