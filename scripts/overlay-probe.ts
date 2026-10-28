/**
 * Renders both overlays with pi's real theme and writes the raw lines to
 * `PI_CACHE_OVERLAY_OUT`.
 *
 * Unit tests use a stub theme, which cannot catch a mistyped theme token or a
 * width mismatch between our padding and pi's `visibleWidth`. This probe closes
 * that gap from inside a running pi process.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { graphLines, statsLines, type StatsViewModel } from "../lib/render.ts";
import type { HistoryPoint } from "../lib/store.ts";

const history: HistoryPoint[] = [
  { turn: 1, rate: 0.12, cacheRead: 600, cacheWrite: 0, input: 4400, at: 1 },
  { turn: 2, rate: 0.94, cacheRead: 9400, cacheWrite: 0, input: 600, at: 2 },
  { turn: 3, rate: 0.97, cacheRead: 9700, cacheWrite: 0, input: 300, at: 3 },
  { turn: 4, rate: 0.31, cacheRead: 1550, cacheWrite: 0, input: 3450, at: 4 },
];

const view: StatsViewModel = {
  session: {
    cacheRead: 900_000,
    cacheWrite: 4096,
    input: 20_000,
    output: 5000,
    turns: 12,
    savedUsd: 0.27,
    costUsd: 0.06,
  },
  models: ["openrouter/deepseek/deepseek-v4.1-flash"],
  cacheDiscounted: true,
  billed: true,
  history,
  aggregate: {
    sessionCount: 7,
    totals: {
      cacheRead: 1_500_000,
      cacheWrite: 0,
      input: 90_000,
      output: 20_000,
      turns: 40,
      savedUsd: 1.2,
      costUsd: 0.4,
    },
    cacheDiscounted: true,
    billed: true,
    skipped: 0,
  },
  pin: { enabled: true, upstream: "deepinfra" },
  statusLine: true,
};

export default function (pi: ExtensionAPI) {
  const out = process.env.PI_CACHE_OVERLAY_OUT;
  if (!out) return;

  pi.on("session_start", async (_event, ctx) => {
    const fg = (token: string, text: string) =>
      ctx.ui.theme.fg(token as Parameters<typeof ctx.ui.theme.fg>[0], text);
    writeFileSync(
      out,
      JSON.stringify({
        stats: statsLines(view, 64, fg),
        graph: graphLines(history, 64, fg),
        narrow: statsLines(view, 30, fg),
      }),
    );
  });
}
