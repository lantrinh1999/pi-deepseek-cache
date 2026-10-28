/**
 * pi-cache-insights — prefix-cache telemetry for pi.
 *
 * What it does
 *   - Per-session and cross-session cache telemetry: hit rate, reused tokens,
 *     cache writes, turns, and the cost those hits avoided.
 *   - Per-turn hit-rate history, with `/cache-graph` plotting the trend and
 *     flagging turns where the prefix cache broke.
 *   - Optional OpenRouter upstream pinning, because OpenRouter load-balances a
 *     model across upstreams that each keep a separate KV cache.
 *
 * What it deliberately does not do
 *   - It never rewrites the system prompt. pi >= 0.85 builds a structured prompt
 *     with a `<cwd>` section and no embedded date, so the old
 *     "freeze Current date/CWD" trick is a no-op and would only add risk.
 *   - It never intercepts compaction. pi's compaction handles split turns, file
 *     tracking and custom instructions; an extension summary would lose them.
 *   - It never estimates prices from a hardcoded table. Savings are derived from
 *     the model's own catalog cost and pi's billed usage, so they stay correct
 *     per provider and across price changes.
 *
 * Data lives in `~/.pi/agent/extensions/cache-insights/`, one file per session,
 * so concurrent sessions never race and a corrupt file costs one session only.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import {
  formatPercent,
  formatTokens,
  formatUsd,
  hitRate,
  usageDelta,
  type ModelCost,
} from "../lib/pricing.ts";
import {
  DEFAULT_CONFIG,
  MAX_HISTORY_POINTS,
  STORE_DIRNAME,
  aggregateRecords,
  applyConfigArgs,
  deleteAllSessions,
  emptyTotals,
  loadAllSessions,
  loadConfig,
  loadSession,
  maybeCleanup,
  saveConfig,
  saveSession,
  saveSessionSync,
  sessionPath,
  type Config,
  type HistoryPoint,
  type SessionRecord,
  type Totals,
} from "../lib/store.ts";
import {
  fetchEndpoints,
  mergePinLookup,
  pickUpstream,
  pinEntryFresh,
  providerRouting,
  type PinCacheEntry,
} from "../lib/pin.ts";
import { detectBreaks } from "../lib/graph.ts";
import {
  GraphOverlay,
  StatsOverlay,
  type KeyMatcher,
  type OverlayAction,
  type StatsViewModel,
} from "../lib/render.ts";

const STATUS_KEY = "cache-insights";
const SAVE_DEBOUNCE_MS = 800;
const OVERLAY_OPTIONS = {
  overlay: true as const,
  overlayOptions: { width: 64, maxHeight: "85%" as const, margin: 1 },
};

/** A cache break is flagged when a turn's rate falls to at most half of the last. */
const BREAK_RATIO = 0.5;
const BREAK_MIN_PROMPT_TOKENS = 2000;

export default function (pi: ExtensionAPI) {
  // `PI_CACHE_INSIGHTS_DIR` keeps the smoke test (and anyone who wants a custom
  // location) out of the real store.
  const storeDir =
    process.env.PI_CACHE_INSIGHTS_DIR?.trim() ||
    join(homedir(), ".pi", "agent", "extensions", STORE_DIRNAME);

  // ── session state ──────────────────────────────────────────
  let config: Config = DEFAULT_CONFIG;
  let sessionId = "";
  let startedAt = 0;
  let totals: Totals = emptyTotals();
  let models = new Set<string>();
  let cacheDiscounted = false;
  let billed = false;
  let history: HistoryPoint[] = [];

  // Counters for the turn in progress, so the graph shows per-turn rates
  // instead of a cumulative average that hides breaks.
  let turnCacheRead = 0;
  let turnCacheWrite = 0;
  let turnInput = 0;

  let pendingRecord: SessionRecord | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let ctxRef: ExtensionContext | undefined;

  // ── OpenRouter pin state (shared across sessions in this process) ──
  const pinCache = new Map<string, PinCacheEntry>();
  const pinInflight = new Map<string, Promise<void>>();
  let pinnedSlug: string | undefined;
  let userRoutingSeen = false;

  // ═══════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════

  const resolveCost = (
    provider: string,
    modelId: string,
  ): ModelCost | undefined => {
    const registry = ctxRef?.modelRegistry;
    const model =
      registry?.find(provider, modelId) ??
      (ctxRef?.model?.provider === provider && ctxRef.model.id === modelId
        ? ctxRef.model
        : undefined);
    if (!model?.cost) return undefined;
    return {
      input: model.cost.input,
      cacheRead: model.cost.cacheRead,
      output: model.cost.output,
    };
  };

  const currentRecord = (): SessionRecord => ({
    version: 1,
    sessionId,
    models: [...models].sort(),
    cacheDiscounted,
    billed,
    totals: { ...totals },
    history: history.slice(-MAX_HISTORY_POINTS),
    startedAt,
    updatedAt: Date.now(),
  });

  const scheduleSave = () => {
    if (!sessionId) return;
    pendingRecord = currentRecord();
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      const record = pendingRecord;
      pendingRecord = undefined;
      if (!record) return;
      void saveSession(storeDir, record).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        ctxRef?.ui.notify(
          `cache-insights: could not save stats (${message})`,
          "warning",
        );
      });
    }, SAVE_DEBOUNCE_MS);
    // Do not keep the process alive purely for telemetry.
    saveTimer.unref?.();
  };

  const flush = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    const record =
      pendingRecord ?? (totals.turns > 0 ? currentRecord() : undefined);
    pendingRecord = undefined;
    if (record) saveSessionSync(storeDir, record);
  };

  /** Did the turn that just finished break the prefix cache? */
  const recentBreak = (): HistoryPoint | undefined => {
    const latest = history[history.length - 1];
    if (!latest) return undefined;
    const breaks = detectBreaks(history, {
      dropRatio: BREAK_RATIO,
      minPromptTokens: BREAK_MIN_PROMPT_TOKENS,
    });
    return breaks.some((item) => item.point.turn === latest.turn)
      ? latest
      : undefined;
  };

  const updateStatus = (ctx: ExtensionContext | undefined) => {
    if (!ctx?.hasUI) return;
    if (!config.statusLine || totals.turns === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const rate = hitRate(totals.cacheRead, totals.input, totals.cacheWrite);
    const broken = recentBreak();
    const text = broken
      ? `⚡ ${formatPercent(rate)} ↓`
      : `⚡ ${formatPercent(rate)}`;
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg(broken ? "warning" : "dim", text),
    );
  };

  const resetMemory = () => {
    totals = emptyTotals();
    models = new Set<string>();
    cacheDiscounted = false;
    billed = false;
    history = [];
    turnCacheRead = 0;
    turnCacheWrite = 0;
    turnInput = 0;
    startedAt = Date.now();
    pendingRecord = undefined;
  };

  const ensurePin = (modelId: string): string | undefined => {
    const order = config.pinOrder?.join("+") ?? "";
    const key = `${modelId}|${order}`;
    const entry = pinCache.get(key);
    if (pinEntryFresh(entry, Date.now())) return entry?.slug;

    if (!pinInflight.has(key)) {
      const task = fetchEndpoints(modelId)
        .then((endpoints) => pickUpstream(endpoints ?? [], config.pinOrder))
        .then((slug) => {
          pinCache.set(key, mergePinLookup(entry, slug, Date.now()));
        })
        .catch(() => {
          pinCache.set(key, mergePinLookup(entry, undefined, Date.now()));
        })
        .finally(() => {
          pinInflight.delete(key);
        });
      pinInflight.set(key, task);
    }
    // Serve the stale value (if any) while the refresh is in flight.
    return entry?.slug;
  };

  const matcher = (keybindings: KeybindingsManager): KeyMatcher => ({
    matches: (data, key) =>
      keybindings.matches(
        data,
        key as "tui.select.cancel" | "tui.select.confirm",
      ),
  });

  /**
   * `ctx.ui.custom()` only works in the TUI; RPC and print modes get the same
   * numbers as a notification instead of a silent no-op.
   */
  const isTui = (ctx: ExtensionCommandContext): boolean => ctx.mode === "tui";

  const statsSummary = (view: StatsViewModel): string => {
    const rate = hitRate(
      view.session.cacheRead,
      view.session.input,
      view.session.cacheWrite,
    );
    const parts = [
      `cache-insights: ${formatPercent(rate)} hit`,
      `${formatTokens(view.session.cacheRead)} reused`,
      `${view.session.turns} turns`,
    ];
    if (view.cacheDiscounted && view.billed) {
      parts.push(`${formatUsd(view.session.savedUsd)} saved`);
    }
    if (view.aggregate && view.aggregate.sessionCount > 1) {
      parts.push(`${view.aggregate.sessionCount} sessions total`);
    }
    return parts.join(" · ");
  };

  const buildViewModel = async (): Promise<StatsViewModel> => {
    const { records, skipped } = await loadAllSessions(storeDir);
    const aggregate = aggregateRecords(records);
    return {
      session: { ...totals },
      models: [...models].sort(),
      cacheDiscounted,
      billed,
      history: [...history],
      aggregate: {
        sessionCount: aggregate.sessionCount,
        totals: aggregate.totals,
        cacheDiscounted: aggregate.cacheDiscounted,
        billed: aggregate.billed,
        skipped,
      },
      pin: {
        enabled: config.pinOpenRouter,
        upstream: pinnedSlug,
        userRouting: userRoutingSeen,
      },
      statusLine: config.statusLine,
    };
  };

  // ═══════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    config = loadConfig(storeDir);
    sessionId = ctx.sessionManager.getSessionId();

    // Resume an existing record instead of zeroing it: pi keeps usage for the
    // whole session, so the stats should too.
    const existing = loadSession(storeDir, sessionId);
    if (existing && existing.version === 1) {
      totals = existing.totals;
      models = new Set(existing.models);
      cacheDiscounted = existing.cacheDiscounted;
      billed = existing.billed;
      history = existing.history.slice(-MAX_HISTORY_POINTS);
      startedAt = existing.startedAt || Date.now();
    } else {
      resetMemory();
    }
    turnCacheRead = 0;
    turnCacheWrite = 0;
    turnInput = 0;
    pendingRecord = undefined;

    const deleted = maybeCleanup(storeDir, Date.now());
    if (deleted > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `cache-insights: removed ${deleted} session file(s) older than 30 days`,
        "info",
      );
    }

    pinnedSlug = undefined;
    userRoutingSeen = false;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    flush();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // ═══════════════════════════════════════════════════════════
  // Telemetry
  // ═══════════════════════════════════════════════════════════

  pi.on("message_end", (event, ctx) => {
    ctxRef = ctx;
    const message = event.message;
    if (message.role !== "assistant") return;
    if (!message.usage) return;

    const delta = usageDelta(
      message.usage,
      resolveCost(message.provider, message.model),
    );

    totals.cacheRead += delta.cacheRead;
    totals.cacheWrite += delta.cacheWrite;
    totals.input += delta.input;
    totals.output += delta.output;
    totals.savedUsd += delta.savedUsd;
    totals.costUsd += delta.costUsd;
    cacheDiscounted ||= delta.cacheDiscounted;
    billed ||= delta.billed;

    turnCacheRead += delta.cacheRead;
    turnCacheWrite += delta.cacheWrite;
    turnInput += delta.input;

    if (message.provider && message.model) {
      models.add(`${message.provider}/${message.model}`);
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    ctxRef = ctx;
    const promptTokens = turnCacheRead + turnCacheWrite + turnInput;
    if (promptTokens > 0) {
      totals.turns += 1;
      history.push({
        turn: totals.turns,
        rate: hitRate(turnCacheRead, turnInput, turnCacheWrite),
        cacheRead: turnCacheRead,
        cacheWrite: turnCacheWrite,
        input: turnInput,
        at: Date.now(),
      });
      if (history.length > MAX_HISTORY_POINTS) {
        history = history.slice(-MAX_HISTORY_POINTS);
      }
    }
    turnCacheRead = 0;
    turnCacheWrite = 0;
    turnInput = 0;

    updateStatus(ctx);
    scheduleSave();
  });

  // ═══════════════════════════════════════════════════════════
  // OpenRouter pin (opt-in)
  // ═══════════════════════════════════════════════════════════

  pi.on("before_provider_request", (event, ctx) => {
    if (!config.pinOpenRouter) return;
    const model = ctx.model;
    if (!model || model.provider !== "openrouter") return;

    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) return;
    const body = payload as Record<string, unknown>;

    const slug = ensurePin(model.id);
    const routing = providerRouting(
      body.provider,
      slug,
      config.pinAllowFallbacks,
    );
    if (routing) {
      body.provider = routing;
      pinnedSlug = slug;
      userRoutingSeen = false;
      return;
    }
    if (body.provider !== undefined && body.provider !== null) {
      // Somebody already routed this request — report it, never override it.
      userRoutingSeen = true;
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Commands
  // ═══════════════════════════════════════════════════════════

  const showOverlays = async (
    ctx: ExtensionCommandContext,
    initial: "stats" | "graph",
  ) => {
    let view: "stats" | "graph" = initial;
    const statsView = await buildViewModel();

    while (true) {
      const next = await ctx.ui.custom<OverlayAction>(
        (_tui, theme: Theme, keybindings, done) => {
          const keys = matcher(keybindings);
          return view === "graph"
            ? new GraphOverlay(theme, keys, done, statsView.history)
            : new StatsOverlay(theme, keys, done, statsView);
        },
        OVERLAY_OPTIONS,
      );
      if (next === "graph" || next === "stats") {
        view = next;
        continue;
      }
      return;
    }
  };

  pi.registerCommand("cache-stats", {
    description: "Cache hit rate, reused tokens, and cost saved",
    handler: async (_args, ctx) => {
      if (!isTui(ctx)) {
        ctx.ui.notify(statsSummary(await buildViewModel()), "info");
        return;
      }
      await showOverlays(ctx, "stats");
    },
  });

  pi.registerCommand("cache-graph", {
    description: "Cache hit rate per turn, with detected cache breaks",
    handler: async (_args, ctx) => {
      const view = await buildViewModel();
      if (!isTui(ctx)) {
        const breaks = detectBreaks(view.history);
        ctx.ui.notify(
          `${statsSummary(view)} · ${breaks.length} cache break(s) · ${view.history.length} turns recorded`,
          "info",
        );
        return;
      }
      await showOverlays(ctx, "graph");
    },
  });

  pi.registerCommand("cache-reset", {
    description: "Reset cache stats (this session, or all with `all`)",
    handler: async (args, ctx) => {
      const all = args.trim().toLowerCase() === "all";
      if (all) {
        const confirmed = await ctx.ui.confirm(
          "Reset all cache stats?",
          "Deletes telemetry for every session stored in this extension.",
        );
        if (!confirmed) return;
        deleteAllSessions(storeDir);
      } else if (sessionId) {
        try {
          unlinkSync(sessionPath(storeDir, sessionId));
        } catch {
          // Nothing stored yet.
        }
      }

      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      resetMemory();
      pendingRecord = undefined;
      updateStatus(ctx);
      ctx.ui.notify(
        all ? "cache-insights: all stats cleared" : "cache-insights: session stats cleared",
        "info",
      );
    },
  });

  pi.registerCommand("cache-config", {
    description:
      "Show or change settings (statusLine, pinOpenRouter, pinAllowFallbacks, pinOrder)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          [
            `statusLine=${config.statusLine}`,
            `pinOpenRouter=${config.pinOpenRouter}`,
            `pinAllowFallbacks=${config.pinAllowFallbacks}`,
            `pinOrder=${config.pinOrder?.join(",") ?? "(auto)"}`,
            `store=${storeDir}`,
          ].join(" · "),
          "info",
        );
        return;
      }

      const { config: next, error } = applyConfigArgs(config, trimmed);
      if (error || !next) {
        ctx.ui.notify(`cache-insights: ${error ?? "invalid config"}`, "error");
        return;
      }
      config = next;
      const saved = saveConfig(storeDir, config);
      updateStatus(ctx);
      const summary = [
        `statusLine=${config.statusLine}`,
        `pinOpenRouter=${config.pinOpenRouter}`,
        `pinAllowFallbacks=${config.pinAllowFallbacks}`,
        `pinOrder=${config.pinOrder?.join(",") ?? "(auto)"}`,
      ].join(" · ");
      ctx.ui.notify(
        `cache-insights: ${summary}${saved ? "" : " (could not persist — check ~/.pi permissions)"}`,
        saved ? "info" : "warning",
      );
    },
  });
}
