/**
 * lib/imageProcessor.js — photo → dot-map conversion (client-side, panel context only).
 */

const GRID_COLS = 48;
const BRIGHTNESS_THRESHOLD = 0.92; // cells brighter than this are excluded (keeps near-white areas empty)
const ALPHA_THRESHOLD = 10;         // cells with alpha < this are excluded
const WEIGHT_FLOOR = 0.05;          // ensures even very bright included cells eventually get revealed

/**
 * Decode a File into a loaded HTMLImageElement.
 * @param {File} file
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}

/**
 * Convert an image into a dot-map for the mosaic.
 *
 * Steps:
 *  1. Draw into an offscreen canvas sized exactly cols×rows — the browser's
 *     image smoothing is a free box filter / downsampler.
 *  2. Compute per-cell luminance and mark exclusions.
 *  3. Build revealOrder via Efraimidis–Spirakis weighted sampling without
 *     replacement, so dark areas surface first on average but light areas
 *     still appear eventually (due to WEIGHT_FLOOR). This produces an organic,
 *     non-scanline reveal pattern.
 *
 * @param {HTMLImageElement} imgEl
 * @param {number} gridCols
 * @returns {{ grid, cells, revealOrder, imageMeta }}
 */
export function processImageToDotMap(imgEl, gridCols = GRID_COLS) {
  const aspectRatio = imgEl.naturalHeight / imgEl.naturalWidth;
  const gridRows = Math.max(1, Math.round(gridCols * aspectRatio));

  const canvas = document.createElement('canvas');
  canvas.width = gridCols;
  canvas.height = gridRows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imgEl, 0, 0, gridCols, gridRows);

  const { data } = ctx.getImageData(0, 0, gridCols, gridRows);

  const cells = [];
  for (let y = 0; y < gridRows; y++) {
    for (let x = 0; x < gridCols; x++) {
      const i = (y * gridCols + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const excluded = a < ALPHA_THRESHOLD || luminance > BRIGHTNESS_THRESHOLD;
      cells.push({ x, y, weight: excluded ? 0 : 1 - luminance, revealed: false, excluded });
    }
  }

  // Build reveal order: fill bottom-up (higher y rows first), with Efraimidis–Spirakis
  // weighted random ordering within each row so dark areas surface before light ones.
  const revealOrder = cells
    .map((cell, i) => ({ i, key: Math.random() ** (1 / (cell.weight + WEIGHT_FLOOR)) }))
    .filter(({ i }) => !cells[i].excluded)
    .sort((a, b) => {
      const rowDiff = cells[b.i].y - cells[a.i].y; // bottom row (highest y) first
      if (rowDiff !== 0) return rowDiff;
      return b.key - a.key;                         // within row: dark areas first
    })
    .map(({ i }) => i);

  return {
    grid: { cols: gridCols, rows: gridRows },
    cells,
    revealOrder,
    imageMeta: { width: imgEl.naturalWidth, height: imgEl.naturalHeight },
  };
}
