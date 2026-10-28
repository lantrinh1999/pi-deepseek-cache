import { describe, expect, it } from "vitest";
import {
  detectBreaks,
  graphScale,
  sampleSeries,
  seriesStats,
  sparkline,
} from "../lib/graph.ts";
import type { HistoryPoint } from "../lib/store.ts";

const point = (
  turn: number,
  rate: number,
  promptTokens = 5000,
): HistoryPoint => ({
  turn,
  rate,
  cacheRead: Math.round(promptTokens * rate),
  cacheWrite: 0,
  input: Math.round(promptTokens * (1 - rate)),
  at: turn * 1000,
});

describe("sampleSeries", () => {
  it("returns the input when it fits", () => {
    expect(sampleSeries([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("keeps the first and last point when downsampling", () => {
    const sampled = sampleSeries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4);
    expect(sampled).toEqual([0, 3, 6, 9]);
  });

  it("handles degenerate widths", () => {
    expect(sampleSeries([1, 2, 3], 0)).toEqual([]);
    expect(sampleSeries([1, 2, 3], 1)).toEqual([3]);
  });
});

describe("graphScale", () => {
  it("adds headroom below the minimum", () => {
    const scale = graphScale([0.9, 0.95]);
    expect(scale.min).toBeCloseTo(0.85);
    expect(scale.max).toBeCloseTo(0.97);
  });

  it("never inverts and never leaves the 0..1 range", () => {
    for (const values of [[0], [1], [0, 1], [0.5, 0.5]]) {
      const scale = graphScale(values);
      expect(scale.min).toBeGreaterThanOrEqual(0);
      expect(scale.max).toBeLessThanOrEqual(1);
      expect(scale.max).toBeGreaterThan(scale.min);
    }
  });

  it("handles an empty series", () => {
    expect(graphScale([])).toEqual({ min: 0, max: 1 });
  });
});

describe("sparkline", () => {
  it("never changes the series length", () => {
    expect(sparkline([0.1, 0.5, 0.9])).toHaveLength(3);
  });

  it("renders higher values with taller blocks", () => {
    const chart = sparkline([0, 1], { min: 0, max: 1 });
    const blocks = [...chart];
    expect(blocks[0]!.charCodeAt(0)).toBeLessThan(blocks[1]!.charCodeAt(0));
  });

  it("clamps out-of-range values into the scale", () => {
    const chart = sparkline([-5, 5], { min: 0, max: 1 });
    expect(chart).toBe(sparkline([0, 1], { min: 0, max: 1 }));
  });
});

describe("seriesStats", () => {
  it("reports min, max, average and latest", () => {
    const stats = seriesStats([0.5, 0.9, 0.4]);
    expect(stats.min).toBeCloseTo(0.4);
    expect(stats.max).toBeCloseTo(0.9);
    expect(stats.average).toBeCloseTo(0.6);
    expect(stats.latest).toBeCloseTo(0.4);
  });

  it("handles an empty series", () => {
    expect(seriesStats([])).toEqual({ min: 0, max: 0, average: 0, latest: 0 });
  });
});

describe("detectBreaks", () => {
  it("finds a collapse in the hit rate", () => {
    const breaks = detectBreaks([point(1, 0.95), point(2, 0.1), point(3, 0.9)]);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.point.turn).toBe(2);
    expect(breaks[0]?.previousRate).toBeCloseTo(0.95);
  });

  it("ignores mild dips", () => {
    expect(detectBreaks([point(1, 0.9), point(2, 0.7)])).toEqual([]);
  });

  it("ignores prompts too small for a cache hit", () => {
    expect(detectBreaks([point(1, 0.95, 500), point(2, 0.05, 500)])).toEqual(
      [],
    );
  });

  it("ignores turns that never had a cache hit to lose", () => {
    expect(detectBreaks([point(1, 0.1), point(2, 0.0)])).toEqual([]);
  });

  it("skips the first turn", () => {
    expect(detectBreaks([point(1, 0)])).toEqual([]);
  });
});
