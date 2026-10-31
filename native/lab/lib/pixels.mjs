// Is the screen blank? Works on a small grayscale copy of a screenshot, which ffmpeg makes (lib/tools.mjs). Pure.

/** The parts of a screenshot that aren't the app: status bars and the like, as shares of the height. */
export const CROP = {
  ios: { top: 0.08, bottom: 0.05 },
  android: { top: 0.06, bottom: 0.08 },
  macos: { top: 0, bottom: 0 },
  windows: { top: 0, bottom: 0 },
};

/** The size of the grayscale copy. Small keeps it fast, and thin lines of text still show as a spread of levels. */
export const GRAY_WIDTH = 128;

const LEVELS = 32;

/**
 * @param {Uint8Array} gray one byte per pixel, row by row
 * @param {number} width
 * @param {number} height
 * @param {{ top?: number, bottom?: number }} crop
 * @returns {{ mean: number, stddev: number, levels: number, dominantShare: number } | null}
 */
export function screenStats(gray, width, height, crop = {}) {
  const first = Math.floor(height * (crop.top ?? 0));
  const last = Math.ceil(height * (1 - (crop.bottom ?? 0)));
  const bins = new Array(LEVELS).fill(0);
  let count = 0;
  let sum = 0;
  let squares = 0;
  for (let y = first; y < last; y++) {
    for (let x = 0; x < width; x++) {
      const v = gray[y * width + x];
      if (v === undefined) continue;
      bins[Math.floor((v * LEVELS) / 256)]++;
      sum += v;
      squares += v * v;
      count++;
    }
  }
  if (count === 0) return null;
  const mean = sum / count;
  return {
    mean,
    stddev: Math.sqrt(Math.max(0, squares / count - mean * mean)),
    levels: bins.filter((n) => n > 0).length,
    dominantShare: Math.max(...bins) / count,
  };
}

/**
 * A screen is blank when it's one flat color, or nearly so with almost no text on the page. A canvas page has no text
 * but plenty of pixels, and a plain page with a few lines has both, so neither fails. Returns null when there's nothing
 * to go on.
 *
 * @param {{ stddev: number, dominantShare: number } | null} stats
 * @param {number | null | undefined} textLength the shell's report of the page's visible text
 */
export function isBlankScreen(stats, textLength) {
  const text = typeof textLength === "number" ? textLength : null;
  if (!stats) return text === null ? null : text === 0;
  if (stats.stddev < 1.5) return true;
  return stats.dominantShare > 0.985 && (text ?? 0) < 20;
}
