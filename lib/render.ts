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
import type { DetailLevel, HistoryPoint, Totals } from "./store.ts";

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
  /** `full` shows output tokens, cost paid, every model, and the per-turn table. */
  detail?: DetailLevel;
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
  detail?: DetailLevel;
}

function totalsRows(
  fg: ThemeLike["fg"],
  totals: Totals,
  options: TotalsRowOptions,
): string[] {
  const { cacheDiscounted, billed, labelWidth = 15, detail } = options;
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
  if (detail === "full") {
    rows.push(kv(fg, "Output", `${formatTokens(totals.output)} tokens`, labelWidth));
  }
  rows.push(kv(fg, "Turns", String(totals.turns), labelWidth));
  if (detail === "full" && billed) {
    rows.push(kv(fg, "Cost paid", formatUsd(totals.costUsd), labelWidth));
  }
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

interface Section {
  lines: string[];
  /** Lower values are dropped first when the terminal is short. Never-dropped
   *  sections use `KEEP`. */
  priority: number;
  /** Drop the whole block at once instead of shedding row by row. */
  atomic?: boolean;
}

const KEEP = 100;
const PRIORITY_CHROME = 30;
const PRIORITY_AGGREGATE = 60;
const PRIORITY_MODELS = 50;
const PRIORITY_HINT = 70;
const PRIORITY_TOTALS = 90;

/**
 * Drop whole rows, lowest priority first, until the box fits the terminal.
 * Rows are independent, so a partially trimmed section still reads correctly —
 * unlike clipping, which would eat the bottom border.
 */
export function fitSections(sections: Section[], budget: number): string[] {
  const kept = sections.map((section) => ({
    priority: section.priority,
    atomic: section.atomic === true,
    lines: [...section.lines],
  }));
  const total = () =>
    kept.reduce((sum, section) => sum + section.lines.length, 0);

  while (total() > budget) {
    let dropIndex = -1;
    let dropPriority = Number.POSITIVE_INFINITY;
    for (let index = 0; index < kept.length; index += 1) {
      const section = kept[index];
      if (!section || section.priority >= KEEP) continue;
      if (section.priority < dropPriority) {
        dropPriority = section.priority;
        dropIndex = index;
      }
    }
    if (dropIndex === -1) break;
    const section = kept[dropIndex];
    if (!section) break;
    if (section.atomic) {
      kept.splice(dropIndex, 1);
      continue;
    }
    section.lines.pop();
    // A trimmed section must not leave dangling blank rows behind.
    while (
      section.lines.length > 0 &&
      (section.lines[section.lines.length - 1] ?? "").trim() === ""
    ) {
      section.lines.pop();
    }
    if (section.lines.length === 0) kept.splice(dropIndex, 1);
  }
  return kept
    .filter((section) => section.lines.some((line) => line.trim() !== ""))
    .flatMap((section) => section.lines);
}

export function statsLines(
  view: StatsViewModel,
  width: number,
  fg: ThemeLike["fg"],
  maxRows?: number,
): string[] {
  const inner = innerWidth(width, STATS_WIDTH);
  const sections =
    inner < 40
      ? narrowStatsSections(view, fg, inner, view.cacheDiscounted, view.billed)
      : wideStatsSections(view, fg, inner);
  // Two border rows plus one row of breathing space.
  const budget = maxRows ? Math.max(6, maxRows - 3) : Number.POSITIVE_INFINITY;
  return box(fg, width, fitSections(sections, budget));
}

/** Full layout: aligned label/value rows, used when there is room. */
function wideStatsSections(
  view: StatsViewModel,
  fg: ThemeLike["fg"],
  inner: number,
): Section[] {
  const sections: Section[] = [
    {
      priority: KEEP,
      lines: ["", ` ${fg("accent", "⚡ Prefix cache")}`, ""],
    },
  ];

  if (view.session.turns === 0) {
    sections.push({
      priority: PRIORITY_TOTALS,
      lines: [`  ${fg("dim", "No cache data yet — send a message first.")}`],
    });
  } else {
    sections.push({
      priority: PRIORITY_TOTALS,
      lines: totalsRows(fg, view.session, {
        cacheDiscounted: view.cacheDiscounted,
        billed: view.billed,
        detail: view.detail,
      }),
    });
    const hint = lastBreakHint(fg, view.history, inner < 58);
    if (hint) sections.push({ priority: PRIORITY_HINT, lines: [hint] });
  }

  const aggregate = view.aggregate;
  if (aggregate && aggregate.sessionCount > 1) {
    const lines = [
      "",
      sectionTitle(fg, `all sessions · ${aggregate.sessionCount}`),
      ...totalsRows(fg, aggregate.totals, {
        cacheDiscounted: aggregate.cacheDiscounted,
        billed: aggregate.billed,
        detail: view.detail,
      }),
    ];
    if (aggregate.skipped > 0) {
      lines.push(
        `  ${fg("dim", `${aggregate.skipped} unreadable session file(s) skipped`)}`,
      );
    }
    sections.push({ priority: PRIORITY_AGGREGATE, lines });
  }

  if (view.models.length === 1) {
    const id = view.models[0] as string;
    // Drop the provider prefix when the full id would be truncated anyway.
    const label = 2 + 15 + id.length <= inner ? id : shortModel(view.models);
    sections.push({
      priority: PRIORITY_MODELS,
      lines: ["", plainKv(fg, "Model", fg("text", label))],
    });
  } else if (view.models.length > 1) {
    const lines = [
      "",
      plainKv(fg, "Models", fg("text", `${view.models.length} in this session`)),
    ];
    const shown = view.detail === "full" ? view.models : view.models.slice(0, 3);
    for (const model of shown.slice(0, 6)) {
      lines.push(`  ${fg("dim", model)}`);
    }
    if (view.models.length > 6) {
      lines.push(`  ${fg("dim", `+${view.models.length - 6} more`)}`);
    }
    sections.push({ priority: PRIORITY_MODELS, lines, atomic: true });
  }

  sections.push({
    priority: PRIORITY_CHROME,
    lines: [
      "",
      plainKv(fg, "OpenRouter pin", fg("text", pinText(view.pin))),
      plainKv(fg, "Footer line", fg("text", view.statusLine ? "on" : "off")),
    ],
  });

  sections.push({
    priority: KEEP,
    lines: ["", ` ${fg("dim", "g graph · esc close")}`],
  });

  return sections;
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
function narrowStatsSections(
  view: StatsViewModel,
  fg: ThemeLike["fg"],
  maxWidth: number,
  cacheDiscounted: boolean,
  billed: boolean,
): Section[] {
  const indent = "  ";
  const wrap = (spans: Span[]) => wrapSpans(fg, indent, spans, maxWidth);
  const sections: Section[] = [
    {
      priority: KEEP,
      lines: ["", ` ${fg("accent", "⚡ Prefix cache")}`, ""],
    },
  ];

  if (view.session.turns === 0) {
    sections.push({
      priority: PRIORITY_TOTALS,
      lines: wrap([{ text: "No cache data yet.", token: "dim" }]),
    });
  } else {
    const totals = view.session;
    const lines = wrap([
      { text: "Hit", token: "dim" },
      { text: formatPercent(hitRateOf(totals)), token: "accent" },
      { text: "·", token: "dim" },
      { text: formatTokens(totals.cacheRead), token: "accent" },
      { text: "reused", token: "dim" },
    ]);
    lines.push(
      ...wrap([
        {
          text: `${formatTokens(totals.input)} fresh · ${totals.turns} turns`,
          token: "dim",
        },
      ]),
    );
    if (view.detail === "full") {
      lines.push(
        ...wrap([
          {
            text: `${formatTokens(totals.output)} output · cost ${formatUsd(totals.costUsd)}`,
            token: "dim",
          },
        ]),
      );
    }
    if (totals.cacheWrite > 0) {
      lines.push(
        ...wrap([
          {
            text: `${formatTokens(totals.cacheWrite)} written to cache`,
            token: "dim",
          },
        ]),
      );
    }
    lines.push(
      ...wrap([
        { text: "Saved", token: "dim" },
        { text: compactSavings(totals, cacheDiscounted, billed), token: "accent" },
      ]),
    );
    sections.push({ priority: PRIORITY_TOTALS, lines });

    const hint = lastBreakHint(fg, view.history, true);
    if (hint) sections.push({ priority: PRIORITY_HINT, lines: [hint] });
  }

  const aggregate = view.aggregate;
  if (aggregate && aggregate.sessionCount > 1) {
    const totals = aggregate.totals;
    sections.push({
      priority: PRIORITY_AGGREGATE,
      lines: [
        "",
        ...wrap([
          { text: `All ${aggregate.sessionCount}`, token: "dim" },
          { text: "·", token: "dim" },
          { text: formatPercent(hitRateOf(totals)), token: "accent" },
          { text: "·", token: "dim" },
          { text: `${formatTokens(totals.cacheRead)} reused`, token: "dim" },
        ]),
        ...wrap([{ text: `${totals.turns} turns`, token: "dim" }]),
        ...wrap([
          { text: "Saved", token: "dim" },
          {
            text: compactSavings(
              totals,
              aggregate.cacheDiscounted,
              aggregate.billed,
            ),
            token: "accent",
          },
        ]),
      ],
    });
  }

  sections.push({
    priority: PRIORITY_MODELS,
    atomic: true,
    lines: [
      "",
      ...wrap([{ text: shortModel(view.models), token: "text" }]),
      ...wrap([{ text: `Pin ${pinText(view.pin)}`, token: "dim" }]),
      ...wrap([{ text: `Footer ${view.statusLine ? "on" : "off"}`, token: "dim" }]),
    ],
  });

  sections.push({
    priority: KEEP,
    lines: ["", ` ${fg("dim", "g graph · esc")}`],
  });

  return sections;
}

/** Human label for the pin state, shared by both layouts. */
function pinText(pin: StatsViewModel["pin"]): string {
  if (!pin.enabled) return "off";
  if (pin.userRouting) return "user routing";
  return pin.upstream ?? "detecting…";
}

/** Last N turns as a table, used by `detail=full`. */
function turnTable(
  history: HistoryPoint[],
  fg: ThemeLike["fg"],
  rows: number,
): string[] {
  const tail = history.slice(-rows);
  if (tail.length === 0) return [];
  const line = (cells: string[], color: string | undefined) =>
    `  ${cells
      .map((cell, index) => {
        const text = index === 0 ? cell.padStart(4) : cell.padStart(8);
        return color ? fg(color, text) : text;
      })
      .join("")}`;
  const out: string[] = [
    line(["turn", "hit", "reused", "fresh"], "dim"),
  ];
  for (const point of tail) {
    out.push(
      line(
        [
          String(point.turn),
          formatPercent(point.rate),
          formatTokens(point.cacheRead),
          formatTokens(point.input),
        ],
        undefined,
      ),
    );
  }
  return out;
}

export function graphLines(
  history: HistoryPoint[],
  width: number,
  fg: ThemeLike["fg"],
  options: { detail?: DetailLevel; maxRows?: number } = {},
): string[] {
  const inner = innerWidth(width, GRAPH_WIDTH);
  const sections: Section[] = [
    {
      priority: KEEP,
      lines: ["", ` ${fg("accent", "⌁ Cache hit rate per turn")}`, ""],
    },
  ];

  if (history.length < 2) {
    sections.push({
      priority: PRIORITY_TOTALS,
      lines: [
        `  ${fg("dim", "Need at least 2 turns of cache data.")}`,
        `  ${fg("dim", "Keep chatting, then try /cache-graph again.")}`,
      ],
    });
    sections.push({
      priority: KEEP,
      lines: ["", ` ${fg("dim", "esc close")}`],
    });
    return box(
      fg,
      width,
      fitSections(sections, options.maxRows ? Math.max(6, options.maxRows - 3) : Number.POSITIVE_INFINITY),
    );
  }

  const sampled = sampleSeries(history, Math.max(10, inner - 6));
  const rates = sampled.map((point) => point.rate);
  const chart = sparkline(rates, graphScale(rates));
  const stats = seriesStats(rates);

  const firstTurn = String(sampled[0]?.turn ?? "");
  const lastTurn = String(sampled[sampled.length - 1]?.turn ?? "");
  const axis =
    chart.length > firstTurn.length + lastTurn.length + 2
      ? firstTurn +
        " ".repeat(chart.length - firstTurn.length - lastTurn.length) +
        lastTurn
      : `${firstTurn}…${lastTurn}`;

  sections.push({
    priority: KEEP,
    lines: [
      `  ${fg("accent", chart)}`,
      `  ${fg("dim", axis)}`,
      `  ${fg(
        "dim",
        `min ${formatPercent(stats.min)} · avg ${formatPercent(stats.average)} · max ${formatPercent(stats.max)} · now ${formatPercent(stats.latest)}`,
      )}`,
    ],
  });

  const breaks = detectBreaks(history).slice(
    options.detail === "full" ? -8 : -3,
  );
  const breakLines =
    breaks.length === 0
      ? [`  ${fg("dim", "No cache breaks detected.")}`]
      : [
          `  ${fg("warning", "Cache breaks")}`,
          ...breaks.map((item) => {
            const promptTokens =
              item.point.cacheRead + item.point.input + item.point.cacheWrite;
            return `  ${fg(
              "dim",
              `turn ${String(item.point.turn).padStart(3)}  ${formatPercent(item.previousRate)} → ${formatPercent(item.point.rate)}  (${formatTokens(promptTokens)} prompt)`,
            )}`;
          }),
        ];
  sections.push({
    priority: PRIORITY_HINT,
    atomic: true,
    lines: ["", ...breakLines],
  });

  if (options.detail === "full") {
    sections.push({
      priority: PRIORITY_CHROME,
      atomic: true,
      lines: ["", ...turnTable(history, fg, 8)],
    });
  }

  sections.push({
    priority: KEEP,
    lines: ["", ` ${fg("dim", "s stats · esc close")}`],
  });

  const budget = options.maxRows
    ? Math.max(6, options.maxRows - 3)
    : Number.POSITIVE_INFINITY;
  return box(fg, width, fitSections(sections, budget));
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
    private readonly maxRows?: number,
  ) {
    super(theme, keys, done);
  }

  protected override build(width: number): string[] {
    return statsLines(this.view, width, this.fg, this.maxRows);
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
    private readonly detail: DetailLevel = "compact",
    private readonly maxRows?: number,
  ) {
    super(theme, keys, done);
  }

  protected override build(width: number): string[] {
    return graphLines(this.history, width, this.fg, {
      detail: this.detail,
      maxRows: this.maxRows,
    });
  }

  protected override onLetter(key: string): OverlayAction {
    return key === "s" ? "stats" : undefined;
  }
}
