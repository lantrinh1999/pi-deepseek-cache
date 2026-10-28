/**
 * Overlay rendering for `/cache-stats` and `/cache-graph`.
 *
 * Line building is separated from key handling: `statsLines()` and
 * `graphLines()` are pure (theme in, strings out) and can be asserted on with a
 * stub theme, while the components only translate keys into actions.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  formatPercent,
  formatTokens,
  formatUsd,
  hitRate,
} from "./pricing.ts";
import {
  detectBreaks,
  graphScale,
  sampleSeries,
  seriesStats,
  sparkline,
} from "./graph.ts";
import type { HistoryPoint, Totals } from "./store.ts";

export type OverlayAction = "stats" | "graph" | undefined;

export interface ThemeLike {
  fg(token: string, text: string): string;
}

export interface KeyMatcher {
  matches(data: string, key: string): boolean;
}

export interface StatsViewModel {
  session: Totals;
  models: string[];
  cacheDiscounted: boolean;
  billed: boolean;
  history: HistoryPoint[];
  aggregate?: {
    sessionCount: number;
    totals: Totals;
    cacheDiscounted: boolean;
    billed: boolean;
    skipped: number;
  };
  pin: { enabled: boolean; upstream?: string; userRouting?: boolean };
  statusLine: boolean;
}

export const STATS_WIDTH = 62;
export const GRAPH_WIDTH = 62;

/** Inner width of the box for a given viewport, clamped to a readable range. */
function innerWidth(width: number, preferred: number): number {
  return Math.max(24, Math.min(width, preferred) - 2);
}

function box(fg: ThemeLike["fg"], width: number, rows: string[]): string[] {
  const inner = innerWidth(width, STATS_WIDTH);
  const body = rows.map((row) => {
    const clipped = truncateToWidth(row, inner, "");
    const padding = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
    return fg("border", "│") + clipped + padding + fg("border", "│");
  });
  return [
    fg("border", `╭${"─".repeat(inner)}╮`),
    ...body,
    fg("border", `╰${"─".repeat(inner)}╯`),
  ];
}

function kv(
  fg: ThemeLike["fg"],
  label: string,
  value: string,
  labelWidth = 15,
): string {
  return `  ${fg("dim", label.padEnd(labelWidth))}${fg("accent", value)}`;
}

function plainKv(
  fg: ThemeLike["fg"],
  label: string,
  value: string,
  labelWidth = 15,
): string {
  return `  ${fg("dim", label.padEnd(labelWidth))}${value}`;
}

function sectionTitle(fg: ThemeLike["fg"], title: string): string {
  return ` ${fg("dim", `─── ${title} `)}`;
}

function hitRateOf(totals: Totals): number {
  return hitRate(totals.cacheRead, totals.input, totals.cacheWrite);
}

function savingsText(
  totals: Totals,
  cacheDiscounted: boolean,
  billed: boolean,
): string {
  if (!cacheDiscounted) return "—  (model has no cache discount)";
  if (!billed) return "—  (not metered)";
  return `${formatUsd(totals.savedUsd)} at list price`;
}

function compactSavings(
  totals: Totals,
  cacheDiscounted: boolean,
  billed: boolean,
): string {
  if (!cacheDiscounted) return "no cache discount";
  if (!billed) return "not metered";
  return `${formatUsd(totals.savedUsd)} list`;
}

/**
 * Short model label for tight spaces: keep the model name, drop the provider
 * and OpenRouter vendor namespaces (`openrouter/deepseek/x` → `x`).
 */
function shortModel(models: string[]): string {
  if (models.length === 0) return "unknown";
  if (models.length > 1) return `${models.length} models`;
  const id = models[0] as string;
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

interface TotalsRowOptions {
  cacheDiscounted: boolean;
  billed: boolean;
  labelWidth?: number;
}

function totalsRows(
  fg: ThemeLike["fg"],
  totals: Totals,
  options: TotalsRowOptions,
): string[] {
  const { cacheDiscounted, billed, labelWidth = 15 } = options;
  const rows = [
    kv(fg, "Hit rate", formatPercent(hitRateOf(totals)), labelWidth),
    kv(fg, "Reused", `${formatTokens(totals.cacheRead)} tokens`, labelWidth),
    kv(fg, "Fresh input", `${formatTokens(totals.input)} tokens`, labelWidth),
  ];
  if (totals.cacheWrite > 0) {
    rows.push(
      kv(fg, "Cache writes", `${formatTokens(totals.cacheWrite)} tokens`, labelWidth),
    );
  }
  rows.push(kv(fg, "Turns", String(totals.turns), labelWidth));
  rows.push(
    kv(fg, "Saved", savingsText(totals, cacheDiscounted, billed), labelWidth),
  );
  return rows;
}

/**
 * Hint for a cache break on the turn that just finished. Older breaks are the
 * graph's job — the footer only warns about the present.
 */
function lastBreakHint(
  fg: ThemeLike["fg"],
  history: HistoryPoint[],
  compact = false,
): string | undefined {
  if (history.length < 2) return undefined;
  const latest = history[history.length - 1] as HistoryPoint;
  const point = detectBreaks(history)
    .filter((item) => item.point.turn === latest.turn)
    .pop()?.point;
  if (!point) return undefined;
  if (compact) {
    return `  ${fg("warning", `↘ turn ${point.turn}: ${formatPercent(point.rate)}`)}`;
  }
  const promptTokens = point.cacheRead + point.input + point.cacheWrite;
  return `  ${fg(
    "warning",
    `↘ turn ${point.turn}: ${formatPercent(point.rate)} of ${formatTokens(promptTokens)} prompt — prefix likely changed`,
  )}`;
}

export function statsLines(
  view: StatsViewModel,
  width: number,
  fg: ThemeLike["fg"],
): string[] {
  const inner = innerWidth(width, STATS_WIDTH);
  const rows =
    inner < 40
      ? narrowStatsRows(view, fg, inner, view.cacheDiscounted, view.billed)
      : wideStatsRows(view, fg, inner);
  return box(fg, width, rows);
}

/** Full layout: aligned label/value rows, used when there is room. */
function wideStatsRows(
  view: StatsViewModel,
  fg: ThemeLike["fg"],
  inner: number,
): string[] {
  const rows: string[] = ["", ` ${fg("accent", "⚡ Prefix cache")}`, ""];

  if (view.session.turns === 0) {
    rows.push(`  ${fg("dim", "No cache data yet — send a message first.")}`);
  } else {
    rows.push(
      ...totalsRows(fg, view.session, {
        cacheDiscounted: view.cacheDiscounted,
        billed: view.billed,
      }),
    );
    const hint = lastBreakHint(fg, view.history, inner < 58);
    if (hint) rows.push(hint);
  }

  const aggregate = view.aggregate;
  if (aggregate && aggregate.sessionCount > 1) {
    rows.push("");
    rows.push(sectionTitle(fg, `all sessions · ${aggregate.sessionCount}`));
    rows.push(
      ...totalsRows(fg, aggregate.totals, {
        cacheDiscounted: aggregate.cacheDiscounted,
        billed: aggregate.billed,
      }),
    );
    if (aggregate.skipped > 0) {
      rows.push(
        `  ${fg("dim", `${aggregate.skipped} unreadable session file(s) skipped`)}`,
      );
    }
  }

  rows.push("");
  if (view.models.length === 1) {
    const id = view.models[0] as string;
    // Drop the provider prefix when the full id would be truncated anyway.
    const label = 2 + 15 + id.length <= inner ? id : shortModel(view.models);
    rows.push(plainKv(fg, "Model", fg("text", label)));
  } else if (view.models.length > 1) {
    rows.push(
      plainKv(fg, "Models", fg("text", `${view.models.length} in this session`)),
    );
    rows.push(`  ${fg("dim", view.models.slice(0, 3).join(", "))}`);
  }

  const pin = view.pin;
  rows.push(plainKv(fg, "OpenRouter pin", fg("text", pinText(pin))));
  rows.push(
    plainKv(fg, "Footer line", fg("text", view.statusLine ? "on" : "off")),
  );

  rows.push("");
  rows.push(` ${fg("dim", "g graph · esc close")}`);

  return rows;
}

interface Span {
  text: string;
  token?: string;
}

/**
 * Wrap styled spans to a width, breaking on word boundaries.
 *
 * Narrow terminals cannot afford a fixed label column, so the compact layout
 * flows instead: segments stay together, words move to the next line, and each
 * word is styled independently so ANSI codes never straddle a break.
 */
function wrapSpans(
  fg: ThemeLike["fg"],
  indent: string,
  spans: Span[],
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  const indentWidth = visibleWidth(indent);
  let current = indent;
  let width = indentWidth;

  const push = () => {
    lines.push(current);
    current = indent;
    width = indentWidth;
  };

  for (const span of spans) {
    const words = span.text.split(" ").filter((word) => word.length > 0);
    for (let index = 0; index < words.length; index++) {
      const raw = words[index] as string;
      // A single word wider than the line is clipped with an ellipsis instead
      // of being cut by the box border.
      const word =
        indentWidth + visibleWidth(raw) > maxWidth
          ? truncateToWidth(raw, Math.max(1, maxWidth - indentWidth), "…")
          : raw;
      const wordWidth = visibleWidth(word);
      const separator = width > indentWidth ? " " : "";
      if (width + separator.length + wordWidth > maxWidth && width > indentWidth) {
        push();
        current += span.token ? fg(span.token, word) : word;
        width += wordWidth;
        continue;
      }
      const piece = separator + word;
      current += span.token ? fg(span.token, piece) : piece;
      width += separator.length + wordWidth;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Narrow layout: wraps the same numbers into sentences instead of truncating a
 * value column, which is what a 30-column terminal needs.
 */
function narrowStatsRows(
  view: StatsViewModel,
  fg: ThemeLike["fg"],
  maxWidth: number,
  cacheDiscounted: boolean,
  billed: boolean,
): string[] {
  const rows: string[] = ["", ` ${fg("accent", "⚡ Prefix cache")}`, ""];
  const indent = "  ";
  const push = (spans: Span[]) => {
    rows.push(...wrapSpans(fg, indent, spans, maxWidth));
  };

  if (view.session.turns === 0) {
    push([{ text: "No cache data yet.", token: "dim" }]);
  } else {
    const totals = view.session;
    push([
      { text: "Hit", token: "dim" },
      { text: formatPercent(hitRateOf(totals)), token: "accent" },
      { text: "·", token: "dim" },
      { text: formatTokens(totals.cacheRead), token: "accent" },
      { text: "reused", token: "dim" },
    ]);
    push([
      { text: `${formatTokens(totals.input)} fresh · ${totals.turns} turns`, token: "dim" },
    ]);
    if (totals.cacheWrite > 0) {
      push([
        { text: `${formatTokens(totals.cacheWrite)} written to cache`, token: "dim" },
      ]);
    }
    push([
      { text: "Saved", token: "dim" },
      { text: compactSavings(totals, cacheDiscounted, billed), token: "accent" },
    ]);
    const hint = lastBreakHint(fg, view.history, true);
    if (hint) rows.push(hint);
  }

  const aggregate = view.aggregate;
  if (aggregate && aggregate.sessionCount > 1) {
    rows.push("");
    const totals = aggregate.totals;
    push([
      { text: `All ${aggregate.sessionCount}`, token: "dim" },
      { text: "·", token: "dim" },
      { text: formatPercent(hitRateOf(totals)), token: "accent" },
      { text: "·", token: "dim" },
      { text: `${formatTokens(totals.cacheRead)} reused`, token: "dim" },
    ]);
    push([{ text: `${totals.turns} turns`, token: "dim" }]);
    push([
      { text: "Saved", token: "dim" },
      {
        text: compactSavings(totals, aggregate.cacheDiscounted, aggregate.billed),
        token: "accent",
      },
    ]);
  }

  rows.push("");
  push([{ text: shortModel(view.models), token: "text" }]);
  push([{ text: `Pin ${pinText(view.pin)}`, token: "dim" }]);
  push([{ text: `Footer ${view.statusLine ? "on" : "off"}`, token: "dim" }]);
  rows.push("");
  rows.push(` ${fg("dim", "g graph · esc")}`);
  return rows;
}

/** Human label for the pin state, shared by both layouts. */
function pinText(pin: StatsViewModel["pin"]): string {
  if (!pin.enabled) return "off";
  if (pin.userRouting) return "user routing";
  return pin.upstream ?? "detecting…";
}

export function graphLines(
  history: HistoryPoint[],
  width: number,
  fg: ThemeLike["fg"],
): string[] {
  const inner = innerWidth(width, GRAPH_WIDTH);
  const rows: string[] = ["", ` ${fg("accent", "⌁ Cache hit rate per turn")}`, ""];

  if (history.length < 2) {
    rows.push(`  ${fg("dim", "Need at least 2 turns of cache data.")}`);
    rows.push(`  ${fg("dim", "Keep chatting, then try /cache-graph again.")}`);
    rows.push("");
    rows.push(` ${fg("dim", "esc close")}`);
    return box(fg, width, rows);
  }

  const sampled = sampleSeries(history, Math.max(10, inner - 6));
  const rates = sampled.map((point) => point.rate);
  const chart = sparkline(rates, graphScale(rates));
  const stats = seriesStats(rates);

  rows.push(`  ${fg("accent", chart)}`);

  const firstTurn = String(sampled[0]?.turn ?? "");
  const lastTurn = String(sampled[sampled.length - 1]?.turn ?? "");
  const axis =
    chart.length > firstTurn.length + lastTurn.length + 2
      ? firstTurn +
        " ".repeat(chart.length - firstTurn.length - lastTurn.length) +
        lastTurn
      : `${firstTurn}…${lastTurn}`;
  rows.push(`  ${fg("dim", axis)}`);
  rows.push(
    `  ${fg(
      "dim",
      `min ${formatPercent(stats.min)} · avg ${formatPercent(stats.average)} · max ${formatPercent(stats.max)} · now ${formatPercent(stats.latest)}`,
    )}`,
  );

  const breaks = detectBreaks(history).slice(-3);
  rows.push("");
  if (breaks.length === 0) {
    rows.push(`  ${fg("dim", "No cache breaks detected.")}`);
  } else {
    rows.push(`  ${fg("warning", "Cache breaks")}`);
    for (const item of breaks) {
      const promptTokens =
        item.point.cacheRead + item.point.input + item.point.cacheWrite;
      rows.push(
        `  ${fg(
          "dim",
          `turn ${String(item.point.turn).padStart(3)}  ${formatPercent(item.previousRate)} → ${formatPercent(item.point.rate)}  (${formatTokens(promptTokens)} prompt)`,
        )}`,
      );
    }
  }

  rows.push("");
  rows.push(` ${fg("dim", "s stats · esc close")}`);
  return box(fg, width, rows);
}

/** Base component: renders through a pure line builder and closes on cancel. */
abstract class Overlay {
  focused = false;
  protected readonly fg: ThemeLike["fg"];
  private readonly keys: KeyMatcher;
  private readonly done: (action: OverlayAction) => void;

  constructor(
    theme: ThemeLike,
    keys: KeyMatcher,
    done: (action: OverlayAction) => void,
  ) {
    this.fg = (token, text) => theme.fg(token, text);
    this.keys = keys;
    this.done = done;
  }

  protected abstract build(width: number): string[];

  /** Letter shortcuts; return an action to switch overlays. */
  protected onLetter(_key: string): OverlayAction {
    return undefined;
  }

  render(width: number): string[] {
    return this.build(width);
  }

  handleInput(data: string): void {
    if (
      this.keys.matches(data, "tui.select.cancel") ||
      this.keys.matches(data, "tui.select.confirm")
    ) {
      this.done(undefined);
      return;
    }
    const action = this.onLetter(data);
    if (action) this.done(action);
  }

  invalidate(): void {}
  dispose(): void {}
}

export class StatsOverlay extends Overlay {
  constructor(
    theme: ThemeLike,
    keys: KeyMatcher,
    done: (action: OverlayAction) => void,
    private readonly view: StatsViewModel,
  ) {
    super(theme, keys, done);
  }

  protected override build(width: number): string[] {
    return statsLines(this.view, width, this.fg);
  }

  protected override onLetter(key: string): OverlayAction {
    return key === "g" ? "graph" : undefined;
  }
}

export class GraphOverlay extends Overlay {
  constructor(
    theme: ThemeLike,
    keys: KeyMatcher,
    done: (action: OverlayAction) => void,
    private readonly history: HistoryPoint[],
  ) {
    super(theme, keys, done);
  }

  protected override build(width: number): string[] {
    return graphLines(this.history, width, this.fg);
  }

  protected override onLetter(key: string): OverlayAction {
    return key === "s" ? "stats" : undefined;
  }
}
