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
 * @param {{ showGhost?: boolean, previewAll?: boolean }} options
 */
export function renderMosaic(canvas, mosaic, { showGhost = true, previewAll = false } = {}) {
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

  for (const cell of cells) {
    if (cell.excluded) continue;

    const cx = (cell.x + 0.5) * cellW;
    const cy = (cell.y + 0.5) * cellH;
    const r      = Math.min(cellW, cellH) * 0.22; // uniform for all revealed dots
    const ghostR = r * 0.5;

    if (cell.revealed || previewAll) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (showGhost) {
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.arc(cx, cy, ghostR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.globalAlpha = 1;
}
