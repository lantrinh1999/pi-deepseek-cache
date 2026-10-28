/**
 * Pure chart helpers for `/cache-graph`.
 *
 * Kept separate from the TUI component so the sampling, scaling and
 * cache-break detection can be unit-tested without a terminal.
 */

import type { HistoryPoint } from "./store.ts";

const BLOCKS = "▁▂▃▄▅▆▇█";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Keep first and last point, pick the rest evenly, never exceed `maxLen`. */
export function sampleSeries<T>(items: T[], maxLen: number): T[] {
  if (maxLen <= 0) return [];
  if (items.length <= maxLen) return [...items];
  if (maxLen === 1) return [items[items.length - 1] as T];
  const lastIndex = items.length - 1;
  const picked: T[] = [];
  for (let i = 0; i < maxLen; i++) {
    const index = Math.round((i * lastIndex) / (maxLen - 1));
    picked.push(items[index] as T);
  }
  return picked;
}

export interface GraphScale {
  min: number;
  max: number;
}

/**
 * Scale for the chart. A little headroom below the minimum keeps the lowest
 * point visible instead of pinned to the baseline.
 */
export function graphScale(values: number[]): GraphScale {
  if (values.length === 0) return { min: 0, max: 1 };
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const min = clamp(rawMin - 0.05, 0, 1);
  const max = clamp(Math.max(rawMax + 0.02, min + 0.05), 0, 1);
  return { min, max };
}

/** Render `values` (0..1) as block characters scaled between min and max. */
export function sparkline(
  values: number[],
  scale: GraphScale = graphScale(values),
): string {
  const range = scale.max - scale.min || 1;
  return values
    .map((value) => {
      const level = Math.round(
        ((clamp(value, scale.min, scale.max) - scale.min) / range) *
          (BLOCKS.length - 1),
      );
      return BLOCKS[clamp(level, 0, BLOCKS.length - 1)];
    })
    .join("");
}

export interface SeriesStats {
  min: number;
  max: number;
  average: number;
  latest: number;
}

export function seriesStats(values: number[]): SeriesStats {
  if (values.length === 0) {
    return { min: 0, max: 0, average: 0, latest: 0 };
  }
  let min = values[0] as number;
  let max = min;
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return {
    min,
    max,
    average: sum / values.length,
    latest: values[values.length - 1] as number,
  };
}

export interface CacheBreak {
  point: HistoryPoint;
  previousRate: number;
}

/**
 * Find turns where the hit rate collapsed — the signature of a busted prefix.
 *
 * A break is a drop to at most half of the previous rate, from a rate that was
 * already meaningful (>= 20%), on a prompt large enough for a cache hit to be
 * plausible. Tiny prompts that never had a chance to hit are ignored.
 */
export function detectBreaks(
  history: HistoryPoint[],
  options: { dropRatio?: number; minPreviousRate?: number; minPromptTokens?: number } = {},
): CacheBreak[] {
  const dropRatio = options.dropRatio ?? 0.5;
  const minPreviousRate = options.minPreviousRate ?? 0.2;
  const minPromptTokens = options.minPromptTokens ?? 1000;

  const breaks: CacheBreak[] = [];
  for (let i = 1; i < history.length; i++) {
    const previous = history[i - 1] as HistoryPoint;
    const point = history[i] as HistoryPoint;
    if (previous.rate < minPreviousRate) continue;
    if (point.rate > previous.rate * dropRatio) continue;
    if (previous.cacheRead + previous.input + previous.cacheWrite < minPromptTokens)
      continue;
    breaks.push({ point, previousRate: previous.rate });
  }
  return breaks;
}
