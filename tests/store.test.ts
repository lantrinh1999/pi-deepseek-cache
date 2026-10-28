import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  aggregateRecords,
  applyConfigArgs,
  cleanupOldSessions,
  deleteAllSessions,
  emptyTotals,
  loadAllSessions,
  loadConfig,
  loadSession,
  maybeCleanup,
  normalizeConfig,
  normalizeSessionRecord,
  safeSessionId,
  saveConfig,
  saveSession,
  saveSessionSync,
  sessionPath,
  type SessionRecord,
} from "../lib/store.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cache-insights-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  version: 1,
  sessionId: "abc-123",
  models: ["opencode-go/deepseek-v4.1-flash"],
  cacheDiscounted: true,
  billed: true,
  totals: {
    cacheRead: 9000,
    cacheWrite: 0,
    input: 1000,
    output: 200,
    turns: 3,
    savedUsd: 0.5,
    costUsd: 0.2,
  },
  history: [],
  startedAt: 1000,
  updatedAt: 2000,
  ...overrides,
});

describe("config", () => {
  it("falls back to defaults for missing or malformed values", () => {
    expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig({ statusLine: "yes", pinOpenRouter: 1 })).toEqual(
      DEFAULT_CONFIG,
    );
  });

  it("normalizes pinOrder and drops empty lists", () => {
    expect(normalizeConfig({ pinOrder: ["a", "b"] }).pinOrder).toEqual(["a", "b"]);
    expect(normalizeConfig({ pinOrder: [] }).pinOrder).toBeNull();
    expect(normalizeConfig({ pinOrder: "a" }).pinOrder).toBeNull();
  });

  it("round-trips through disk", () => {
    saveConfig(dir, { ...DEFAULT_CONFIG, pinOpenRouter: true, statusLine: false });
    expect(loadConfig(dir)).toMatchObject({
      pinOpenRouter: true,
      statusLine: false,
    });
    expect(loadConfig(join(dir, "missing"))).toEqual(DEFAULT_CONFIG);
  });

  it("parses key=value arguments", () => {
    const { config } = applyConfigArgs(DEFAULT_CONFIG, "statusLine=off");
    expect(config?.statusLine).toBe(false);

    const both = applyConfigArgs(DEFAULT_CONFIG, "pinOpenRouter=on pinAllowFallbacks=false");
    expect(both.config).toMatchObject({
      pinOpenRouter: true,
      pinAllowFallbacks: false,
    });

    const order = applyConfigArgs(DEFAULT_CONFIG, "pinOrder=deepinfra|parasail");
    expect(order.config?.pinOrder).toEqual(["deepinfra", "parasail"]);

    const cleared = applyConfigArgs(
      { ...DEFAULT_CONFIG, pinOrder: ["x"] },
      "pinOrder=",
    );
    expect(cleared.config?.pinOrder).toBeNull();
  });

  it("rejects unknown keys and non-boolean values", () => {
    expect(applyConfigArgs(DEFAULT_CONFIG, "nope=1").error).toMatch(/unknown key/);
    expect(applyConfigArgs(DEFAULT_CONFIG, "statusLine=maybe").error).toMatch(
      /expects on\/off/,
    );
    expect(applyConfigArgs(DEFAULT_CONFIG, "statusLine").error).toMatch(
      /key=value/,
    );
  });
});

describe("session files", () => {
  it("sanitizes session ids before using them as file names", () => {
    expect(safeSessionId("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(safeSessionId("")).toBe("unknown");
  });

  it("writes atomically and reads back", async () => {
    await saveSession(dir, record());
    const loaded = loadSession(dir, "abc-123");
    expect(loaded?.totals.cacheRead).toBe(9000);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("survives a corrupt session file", () => {
    writeFileSync(sessionPath(dir, "abc-123"), "{not json");
    expect(loadSession(dir, "abc-123")).toBeUndefined();

    saveSessionSync(dir, record());
    expect(loadSession(dir, "abc-123")?.sessionId).toBe("abc-123");
  });

  it("keeps legacy records that only had a flat totals object", () => {
    const legacy = normalizeSessionRecord({
      sessionId: "old",
      cacheRead: 5,
      input: 5,
      turns: 1,
    });
    expect(legacy?.totals.cacheRead).toBe(5);
    expect(legacy?.billed).toBe(false);
  });

  it("drops records with no session id", () => {
    expect(normalizeSessionRecord({ totals: {} })).toBeUndefined();
    expect(normalizeSessionRecord(null)).toBeUndefined();
  });
});

describe("aggregate", () => {
  it("sums totals and unions models", async () => {
    await saveSession(dir, record({ sessionId: "a", updatedAt: 2 }));
    await saveSession(
      dir,
      record({
        sessionId: "b",
        updatedAt: 3,
        models: ["deepseek/deepseek-flash"],
        billed: false,
      }),
    );

    const { records } = await loadAllSessions(dir);
    const aggregate = aggregateRecords(records);
    expect(aggregate.sessionCount).toBe(2);
    expect(aggregate.totals.cacheRead).toBe(18_000);
    expect(aggregate.totals.turns).toBe(6);
    expect(aggregate.models).toEqual([
      "deepseek/deepseek-flash",
      "opencode-go/deepseek-v4.1-flash",
    ]);
    expect(aggregate.billed).toBe(true);
  });

  it("skips unreadable files without failing the aggregate", async () => {
    await saveSession(dir, record());
    writeFileSync(join(dir, "session-broken.json"), "garbage");
    const { records, skipped } = await loadAllSessions(dir);
    expect(records).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("returns newest records first and respects the limit", async () => {
    await saveSession(dir, record({ sessionId: "old", updatedAt: 1 }));
    await saveSession(dir, record({ sessionId: "new", updatedAt: 9 }));
    const { records } = await loadAllSessions(dir, 1);
    expect(records.map((r) => r.sessionId)).toEqual(["new"]);
  });

  it("aggregates an empty store to zeros", () => {
    const aggregate = aggregateRecords([]);
    expect(aggregate.totals).toEqual(emptyTotals());
    expect(aggregate.sessionCount).toBe(0);
  });
});

describe("cleanup", () => {
  it("deletes only sessions older than the cutoff", async () => {
    await saveSession(dir, record({ sessionId: "fresh" }));
    await saveSession(dir, record({ sessionId: "stale" }));
    const stalePath = sessionPath(dir, "stale");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(stalePath, old, old);

    const deleted = cleanupOldSessions(dir, Date.now());
    expect(deleted).toBe(1);
    expect(existsSync(stalePath)).toBe(false);
    expect(loadSession(dir, "fresh")).toBeDefined();
  });

  it("throttles repeated cleanup runs with a marker", async () => {
    await saveSession(dir, record({ sessionId: "stale" }));
    const stalePath = sessionPath(dir, "stale");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(stalePath, old, old);
    const now = Date.now();

    expect(maybeCleanup(dir, now)).toBe(1);
    await saveSession(dir, record({ sessionId: "stale2" }));
    utimesSync(sessionPath(dir, "stale2"), old, old);
    expect(maybeCleanup(dir, now + 60_000)).toBe(0);
    expect(Number(readFileSync(join(dir, ".last-cleanup"), "utf8"))).toBe(now);
  });

  it("deletes every session file on reset", async () => {
    await saveSession(dir, record({ sessionId: "a" }));
    await saveSession(dir, record({ sessionId: "b" }));
    saveConfig(dir, DEFAULT_CONFIG);
    expect(deleteAllSessions(dir)).toBe(2);
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });
});
