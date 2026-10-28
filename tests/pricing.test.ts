import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatTokens,
  formatUsd,
  hitRate,
  usageDelta,
} from "../lib/pricing.ts";

/** Prices per 1M tokens, the same shape as `model.cost`. */
const DEEPSEEK_FLASH = { input: 0.3, cacheRead: 0.006, output: 1.2 };
const NO_DISCOUNT = { input: 2, cacheRead: 2, output: 4 };
const PAID_PLAN = { input: 0, cacheRead: 0, output: 0 };

describe("hitRate", () => {
  it("counts cache reads against every prompt token", () => {
    expect(hitRate(900, 100, 0)).toBeCloseTo(0.9);
    expect(hitRate(900, 50, 50)).toBeCloseTo(0.9);
  });

  it("returns 0 instead of NaN when nothing was sent", () => {
    expect(hitRate(0, 0, 0)).toBe(0);
  });
});

describe("usageDelta", () => {
  it("derives savings from pi's billed cost, not hardcoded prices", () => {
    // 9k of 10k prompt tokens hit cache at $0.3/M input vs $0.006/M cached.
    const delta = usageDelta(
      {
        input: 1000,
        cacheRead: 9000,
        cacheWrite: 0,
        output: 500,
        cost: {
          input: 0.0003,
          cacheRead: 0.000054,
          cacheWrite: 0,
          output: 0.0006,
          total: 0.000954,
        },
      },
      DEEPSEEK_FLASH,
    );

    expect(delta.promptTokens).toBe(10_000);
    expect(delta.cacheDiscounted).toBe(true);
    expect(delta.billed).toBe(true);
    // 10k tokens at the miss price minus what was actually billed.
    expect(delta.savedUsd).toBeCloseTo(0.003 - 0.000354, 6);
    expect(delta.costUsd).toBeCloseTo(0.000954, 6);
  });

  it("never reports negative savings when a cache write costs more than input", () => {
    // Anthropic-style: $3/M input, $3.75/M cache write.
    const delta = usageDelta(
      {
        input: 0,
        cacheRead: 0,
        cacheWrite: 1000,
        output: 0,
        cost: {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0.00375,
          output: 0,
          total: 0.00375,
        },
      },
      { input: 3, cacheRead: 0.3, output: 15 },
    );

    expect(delta.savedUsd).toBe(0);
  });

  it("keeps counting tokens when the model has no discount", () => {
    const delta = usageDelta(
      { input: 500, cacheRead: 500, cacheWrite: 0, output: 10 },
      NO_DISCOUNT,
    );
    expect(delta.cacheDiscounted).toBe(false);
    expect(delta.savedUsd).toBe(0);
    expect(delta.promptTokens).toBe(1000);
    expect(delta.costUsd).toBeCloseTo(0.00204, 6);
  });

  it("does not report money for zero-priced plans", () => {
    const delta = usageDelta(
      { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 },
      PAID_PLAN,
    );
    expect(delta.cacheDiscounted).toBe(false);
    expect(delta.billed).toBe(false);
    expect(delta.savedUsd).toBe(0);
    expect(delta.cacheRead).toBe(900);
  });

  it("accumulates counters even when the model is unknown", () => {
    const delta = usageDelta(
      { input: 10, cacheRead: 20, cacheWrite: 0, output: 5 },
      undefined,
    );
    expect(delta.promptTokens).toBe(30);
    expect(delta.savedUsd).toBe(0);
    expect(delta.billed).toBe(false);
  });
});

describe("formatting", () => {
  it.each([
    [0, "0"],
    [42, "42"],
    [999, "999"],
    [1000, "1K"],
    [1234, "1.23K"],
    [12_345, "12.3K"],
    [123_456, "123K"],
    [1_234_567, "1.23M"],
    [2_000_000_000, "2B"],
  ])("formatTokens(%i) = %s", (input, expected) => {
    expect(formatTokens(input)).toBe(expected);
  });

  it("formats USD without rounding real money away", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-1)).toBe("$0.00");
    expect(formatUsd(0.0001)).toBe("<$0.01");
    expect(formatUsd(0.0234)).toBe("$0.023");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("formats percentages and clamps nonsense", () => {
    expect(formatPercent(0.9432)).toBe("94.3%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(Number.NaN)).toBe("0.0%");
    expect(formatPercent(2)).toBe("100.0%");
  });
});
