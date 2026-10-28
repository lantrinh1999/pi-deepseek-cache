/**
 * Cache cost math.
 *
 * Every number here comes from the provider's own accounting:
 *   - `usage.cost.*` is what pi actually billed (already priced with the
 *     model's input / cache-read / cache-write rates).
 *   - `model.cost.*` is the counterfactual: what those cache-hit tokens would
 *     have cost as fresh input.
 *
 * Deriving savings this way keeps the math correct for every provider,
 * including ones that charge a premium for cache writes (Anthropic), ones that
 * bill in plan credits (cost 0), and ones whose prices change over time.
 *
 * Pure — no pi runtime imports, so it stays unit-testable.
 */

export interface ModelCost {
  /** USD per 1M tokens. */
  input: number;
  cacheRead: number;
  output: number;
}

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: UsageCost;
}

export interface UsageDelta {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  /** Prompt tokens: cache hits + fresh input + cache writes. */
  promptTokens: number;
  /** USD saved by serving `cacheRead` tokens from cache (write premium included). */
  savedUsd: number;
  /** USD pi billed for this request, all components. */
  costUsd: number;
  /** True when the model has a cache discount, so `savedUsd` means something. */
  cacheDiscounted: boolean;
  /**
   * True when pi priced this request above zero. Free and token-plan models
   * report 0, so their savings are not reported as money.
   */
  billed: boolean;
}

const PER_MILLION = 1_000_000;

/** Keep stored money free of float noise; 1e-12 USD is far below any real bill. */
function roundMoney(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function finite(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Fold one assistant message's usage into billable counters plus the savings
 * that its cache reads produced.
 *
 * `cost` should be the price of the model that actually produced the message.
 * When it is missing, counters still accumulate and `savedUsd` stays 0 — the
 * totals never invent savings out of unknown prices.
 */
export function usageDelta(
  usage: UsageLike,
  cost: ModelCost | undefined,
): UsageDelta {
  const cacheRead = finite(usage.cacheRead);
  const cacheWrite = finite(usage.cacheWrite);
  const input = finite(usage.input);
  const output = finite(usage.output);
  const promptTokens = cacheRead + cacheWrite + input;

  const inputPerToken = finite(cost?.input) / PER_MILLION;
  const outputPerToken = finite(cost?.output) / PER_MILLION;
  const cacheDiscounted =
    inputPerToken > 0 && inputPerToken > finite(cost?.cacheRead) / PER_MILLION;

  const billedCost = usage.cost;
  const actualInputUsd = billedCost
    ? finite(billedCost.input) +
      finite(billedCost.cacheRead) +
      finite(billedCost.cacheWrite)
    : input * inputPerToken +
      cacheRead * (finite(cost?.cacheRead) / PER_MILLION) +
      cacheWrite * (finite(cost?.cacheRead) / PER_MILLION);
  const costUsd = billedCost
    ? finite(billedCost.total)
    : actualInputUsd + output * outputPerToken;

  // Counterfactual: every prompt token billed as fresh input. Cache writes can
  // legitimately cost more than input (Anthropic charges 1.25x), so clamp at
  // zero instead of reporting negative savings.
  const counterfactualUsd = promptTokens * inputPerToken;
  const charged = costUsd > 0;
  const savedUsd =
    charged && cacheDiscounted && counterfactualUsd > actualInputUsd
      ? counterfactualUsd - actualInputUsd
      : 0;

  return {
    cacheRead,
    cacheWrite,
    input,
    output,
    promptTokens,
    savedUsd: roundMoney(savedUsd),
    costUsd: roundMoney(costUsd),
    cacheDiscounted,
    billed: charged,
  };
}

/** Cache hits as a share of prompt tokens. Returns 0 when nothing was sent. */
export function hitRate(
  cacheRead: number,
  input: number,
  cacheWrite = 0,
): number {
  const total = finite(cacheRead) + finite(input) + finite(cacheWrite);
  return total > 0 ? finite(cacheRead) / total : 0;
}

// ─── Formatting ────────────────────────────────────────────────

const UNITS: ReadonlyArray<readonly [number, string]> = [
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** `1234` → `1.23K`, `1234567` → `1.23M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  for (const [scale, suffix] of UNITS) {
    if (n < scale) continue;
    const value = n / scale;
    const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    const text = value.toFixed(digits);
    const trimmed = digits === 0 ? text : text.replace(/\.?0+$/, "");
    return `${trimmed}${suffix}`;
  }
  return String(Math.round(n));
}

/** `0` → `$0.00`, `0.0004` → `<$0.01`, `12.345` → `$12.35`. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.005) return "<$0.01";
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** `0.9432` → `94.3%`. */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "0.0%";
  return `${(Math.min(ratio, 1) * 100).toFixed(1)}%`;
}
