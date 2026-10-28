import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  GraphOverlay,
  STATS_WIDTH,
  StatsOverlay,
  fitSections,
  graphLines,
  statsLines,
  type OverlayAction,
  type StatsViewModel,
} from "../lib/render.ts";
import type { HistoryPoint, Totals } from "../lib/store.ts";

/** Plain theme: keeps assertions readable. */
const plain = (_token: string, text: string) => text;
/** ANSI theme: proves the width math survives escape sequences. */
const ansi = (token: string, text: string) =>
  `\x1b[${token === "accent" ? 36 : token === "warning" ? 33 : 90}m${text}\x1b[0m`;

const totals = (overrides: Partial<Totals> = {}): Totals => ({
  cacheRead: 900_000,
  cacheWrite: 0,
  input: 20_000,
  output: 5000,
  turns: 12,
  savedUsd: 0.27,
  costUsd: 0.06,
  ...overrides,
});

const history: HistoryPoint[] = [
  { turn: 1, rate: 0.2, cacheRead: 1000, cacheWrite: 0, input: 4000, at: 1 },
  { turn: 2, rate: 0.95, cacheRead: 9500, cacheWrite: 0, input: 500, at: 2 },
  { turn: 3, rate: 0.94, cacheRead: 9400, cacheWrite: 0, input: 600, at: 3 },
  // The newest turn is the break, so the stats overlay warns about it.
  { turn: 4, rate: 0.05, cacheRead: 250, cacheWrite: 0, input: 4750, at: 4 },
];

const view = (overrides: Partial<StatsViewModel> = {}): StatsViewModel => ({
  session: totals(),
  models: ["opencode-go/deepseek-v4.1-flash"],
  cacheDiscounted: true,
  billed: true,
  history,
  aggregate: undefined,
  pin: { enabled: false },
  statusLine: true,
  ...overrides,
});

const body = (lines: string[]) =>
  lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

function assertBoxIntegrity(lines: string[], themeLabel: string) {
  expect(lines.length).toBeGreaterThan(2);
  const stripped = lines.map(strip);
  expect(stripped[0]!.startsWith("╭")).toBe(true);
  expect(stripped[stripped.length - 1]!.startsWith("╰")).toBe(true);
  const widths = new Set(lines.map((line) => visibleWidth(line)));
  expect(widths.size, `${themeLabel}: all rows share one width`).toBe(1);
  for (const line of stripped) {
    expect(line.startsWith("│") || line.startsWith("╭") || line.startsWith("╰")).toBe(true);
    expect(line.endsWith("│") || line.endsWith("╮") || line.endsWith("╯")).toBe(true);
  }
}

describe("statsLines", () => {
  it("keeps a rectangular box at every viewport width", () => {
    for (const width of [24, 40, STATS_WIDTH + 2, 100]) {
      assertBoxIntegrity(statsLines(view(), width, plain), `plain w=${width}`);
      assertBoxIntegrity(statsLines(view(), width, ansi), `ansi w=${width}`);
    }
  });

  it("shows the session numbers", () => {
    const text = body(statsLines(view(), 64, plain));
    expect(text).toMatch(/Hit rate\s+97\.8%/);
    expect(text).toMatch(/Reused\s+900K tokens/);
    expect(text).toMatch(/Fresh input\s+20K tokens/);
    expect(text).toMatch(/Turns\s+12/);
    expect(text).toMatch(/Saved\s+\$0\.270 at list price/);
  });

  it("hides the cache-write row when nothing was written", () => {
    expect(body(statsLines(view(), 64, plain))).not.toMatch(/Cache writes/);
    const withWrites = view({ session: totals({ cacheWrite: 4000 }) });
    expect(body(statsLines(withWrites, 64, plain))).toMatch(
      /Cache writes\s+4K tokens/,
    );
  });

  it("explains why savings are absent instead of printing $0.00", () => {
    const undiscounted = view({
      cacheDiscounted: false,
      session: totals({ savedUsd: 0 }),
    });
    expect(body(statsLines(undiscounted, 64, plain))).toMatch(
      /no cache discount/,
    );

    const unmetered = view({ billed: false, session: totals({ savedUsd: 0 }) });
    expect(body(statsLines(unmetered, 64, plain))).toMatch(/not metered/);
  });

  it("prompts before the first message", () => {
    const empty = view({ session: totals({ turns: 0 }) });
    const text = body(statsLines(empty, 64, plain));
    expect(text).toMatch(/No cache data yet/);
    expect(text).not.toMatch(/Hit rate/);
  });

  it("shows the aggregate only when other sessions exist", () => {
    const single = view({
      aggregate: {
        sessionCount: 1,
        totals: totals(),
        cacheDiscounted: true,
        billed: true,
        skipped: 0,
      },
    });
    expect(body(statsLines(single, 64, plain))).not.toMatch(/all sessions/);

    const multi = view({
      aggregate: {
        sessionCount: 7,
        totals: totals({ cacheRead: 1_500_000, turns: 40, savedUsd: 1.2 }),
        cacheDiscounted: true,
        billed: true,
        skipped: 2,
      },
    });
    const text = body(statsLines(multi, 64, plain));
    expect(text).toMatch(/all sessions · 7/);
    expect(text).toMatch(/1\.5M tokens/);
    expect(text).toMatch(/2 unreadable session file/);
  });

  it("reports the OpenRouter pin state", () => {
    expect(body(statsLines(view(), 64, plain))).toMatch(/OpenRouter pin\s+off/);
    expect(
      body(
        statsLines(view({ pin: { enabled: true, upstream: "deepinfra" } }), 64, plain),
      ),
    ).toMatch(/OpenRouter pin\s+deepinfra/);
    expect(
      body(
        statsLines(view({ pin: { enabled: true, upstream: "x", userRouting: true } }), 64, plain),
      ),
    ).toMatch(/user routing/);
    expect(
      body(statsLines(view({ pin: { enabled: true } }), 64, plain)),
    ).toMatch(/detecting/);
  });

  it("flags the turn that just broke the prefix cache", () => {
    const text = body(statsLines(view(), 64, plain));
    expect(text).toMatch(/turn 4: 5\.0% of 5K prompt/);
  });

  it("switches to a wrapped layout on narrow terminals", () => {
    const narrowView = view({
      session: totals({ cacheWrite: 4096 }),
      aggregate: {
        sessionCount: 7,
        totals: totals({ cacheRead: 1_500_000, turns: 40, savedUsd: 1.2 }),
        cacheDiscounted: true,
        billed: true,
        skipped: 0,
      },
    });
    const lines = statsLines(narrowView, 30, plain);
    const text = body(lines);
    assertBoxIntegrity(lines, "narrow stats");
    // No value column to truncate: numbers move into the sentence instead.
    // cacheWrite counts toward the denominator: 900K/924.1K = 97.4%.
    expect(text).toMatch(/Hit 97\.4% · 900K reused/);
    expect(text).toMatch(/20K fresh · 12 turns/);
    expect(text).toMatch(/4\.1K written to cache/);
    expect(text).toMatch(/Saved \$0\.270 list/);
    expect(text).toMatch(/All 7 · 98\.7% · 1\.5M/);
    expect(text).toMatch(/reused/);
    expect(text).toMatch(/deepseek-v4\.1-flash/);
    expect(text).toMatch(/↘ turn 4: 5\.0%/);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it("lists multiple models, one per row", () => {
    const text = body(
      statsLines(view({ models: ["a/one", "b/two", "c/three"] }), 64, plain),
    );
    expect(text).toMatch(/Models\s+3 in this session/);
    expect(text).toMatch(/a\/one/);
    expect(text).toMatch(/b\/two/);
    expect(text).toMatch(/c\/three/);
  });

  it("shows every tracked number in full detail", () => {
    const compact = body(statsLines(view(), 64, plain));
    expect(compact).not.toMatch(/Output/);
    expect(compact).not.toMatch(/Cost paid/);

    const full = body(statsLines(view({ detail: "full" }), 64, plain));
    expect(full).toMatch(/Output\s+5K tokens/);
    expect(full).toMatch(/Cost paid\s+\$0\.060/);
    expect(full).toMatch(/Saved\s+\$0\.270 at list price/);
    assertBoxIntegrity(statsLines(view({ detail: "full" }), 64, ansi), "full");
  });

  it("lists every model in full detail and caps the list", () => {
    const models = Array.from({ length: 9 }, (_, index) => `p/model-${index}`);
    const full = body(
      statsLines(view({ detail: "full", models }), 64, plain),
    );
    expect(full).toMatch(/p\/model-5/);
    expect(full).toMatch(/\+3 more/);
  });
});

describe("graphLines", () => {
  it("asks for more data instead of drawing an empty chart", () => {
    const text = body(graphLines(history.slice(0, 1), 64, plain));
    expect(text).toMatch(/Need at least 2 turns/);
    assertBoxIntegrity(graphLines([], 64, plain), "empty graph");
  });

  it("draws a chart and a break list", () => {
    const lines = graphLines(history, 64, plain);
    const text = body(lines);
    expect(text).toMatch(/min /);
    expect(text).toMatch(/avg /);
    expect(text).toMatch(/now 5\.0%/);
    expect(text).toMatch(/Cache breaks/);
    expect(text).toMatch(/turn\s+4/);
    assertBoxIntegrity(lines, "graph");
    // The sparkline row carries block characters.
    expect(text).toMatch(/[▁▂▃▄▅▆▇█]{2,}/);
  });

  it("adds a per-turn table in full detail", () => {
    const compact = body(graphLines(history, 64, plain));
    expect(compact).not.toMatch(/turn\s+hit\s+reused\s+fresh/);

    const full = graphLines(history, 64, plain, { detail: "full" });
    const text = body(full);
    expect(text).toMatch(/turn\s+hit\s+reused\s+fresh/);
    expect(text).toMatch(/\b4\s+5\.0%/);
    assertBoxIntegrity(full, "full graph");
  });

  it("says so when nothing broke", () => {
    const steady: HistoryPoint[] = [0.9, 0.92, 0.95].map((rate, index) => ({
      turn: index + 1,
      rate,
      cacheRead: 9000,
      cacheWrite: 0,
      input: 1000,
      at: index,
    }));
    expect(body(graphLines(steady, 64, plain))).toMatch(/No cache breaks/);
  });

  it("stays rectangular on a narrow terminal", () => {
    assertBoxIntegrity(graphLines(history, 28, ansi), "narrow graph");
  });

  it("survives a single point without dividing by zero", () => {
    assertBoxIntegrity(graphLines(history.slice(0, 1), 28, ansi), "one point");
  });
});

describe("height fitting", () => {
  it("drops low-priority rows first", () => {
    const kept = fitSections(
      [
        { priority: 100, lines: ["title"] },
        { priority: 30, lines: ["chrome-1", "chrome-2"] },
        { priority: 90, lines: ["total"] },
        { priority: 40, lines: ["aggregate"] },
      ],
      3,
    );
    expect(kept).toContain("title");
    expect(kept).toContain("total");
    expect(kept).not.toContain("chrome-1");
  });

  it("keeps the box intact when the terminal is short", () => {
    const full = view({ detail: "full" });
    for (const rows of [12, 18, 24]) {
      const lines = statsLines(full, 64, plain, rows);
      expect(lines.length).toBeLessThanOrEqual(rows);
      assertBoxIntegrity(lines, `stats maxRows=${rows}`);
      expect(body(lines)).toMatch(/Prefix cache/);
    }
  });

  it("trims the graph table before the chart", () => {
    const lines = graphLines(history, 64, plain, {
      detail: "full",
      maxRows: 14,
    });
    expect(lines.length).toBeLessThanOrEqual(14);
    const text = body(lines);
    expect(text).toMatch(/Cache hit rate per turn/);
    expect(text).not.toMatch(/turn\s+hit\s+reused\s+fresh/);
    assertBoxIntegrity(lines, "trimmed graph");
  });
});

describe("overlay input", () => {
  const keys = {
    matches: (data: string, key: string) =>
      (key === "tui.select.cancel" && data === "\u001b") ||
      (key === "tui.select.confirm" && data === "\r"),
  };

  const collect = () => {
    const actions: OverlayAction[] = [];
    return {
      actions,
      done: (action: OverlayAction) => actions.push(action),
    };
  };

  it("closes the stats overlay on escape and enter", () => {
    const sink = collect();
    const overlay = new StatsOverlay({ fg: plain }, keys, sink.done, view());
    overlay.handleInput("\u001b");
    overlay.handleInput("\r");
    expect(sink.actions).toEqual([undefined, undefined]);
  });

  it("switches from stats to the graph with g", () => {
    const sink = collect();
    const overlay = new StatsOverlay({ fg: plain }, keys, sink.done, view());
    overlay.handleInput("x");
    overlay.handleInput("g");
    expect(sink.actions).toEqual(["graph"]);
  });

  it("switches from the graph back to stats with s", () => {
    const sink = collect();
    const overlay = new GraphOverlay({ fg: plain }, keys, sink.done, history);
    overlay.handleInput("s");
    expect(sink.actions).toEqual(["stats"]);
  });

  it("renders the width it is given", () => {
    const overlay = new StatsOverlay({ fg: plain }, keys, () => {}, view());
    const narrow = overlay.render(30);
    const wide = overlay.render(70);
    expect(visibleWidth(narrow[0]!)).toBeLessThan(visibleWidth(wide[0]!));
    assertBoxIntegrity(narrow, "component narrow");
    assertBoxIntegrity(wide, "component wide");
  });
});
