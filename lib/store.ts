/**
 * Persistence for cache telemetry.
 *
 * One JSON file per session (`session-<id>.json`) — concurrent pi sessions
 * never contend for the same file, and a corrupt file can only cost one
 * session's history. Writes are debounced by the caller and atomic here
 * (temp file + rename), so a crash mid-write cannot truncate a good record.
 *
 * Every function takes the store directory instead of reading `homedir()`
 * itself, which keeps the module unit-testable against a temp dir.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const STORE_DIRNAME = "cache-insights";

export const SESSION_FILE_PREFIX = "session-";
export const SESSION_FILE_SUFFIX = ".json";
export const CONFIG_FILE = "config.json";
export const CLEANUP_MARKER = ".last-cleanup";

/** Session files older than this are deleted on the next cleanup pass. */
export const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Retain at most this many history points per session (oldest dropped). */
export const MAX_HISTORY_POINTS = 240;
/** Never read more than this many session files for one aggregate. */
export const MAX_AGGREGATE_SESSIONS = 400;

export interface HistoryPoint {
  turn: number;
  rate: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  at: number;
}

export interface Totals {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  turns: number;
  savedUsd: number;
  costUsd: number;
}

export interface SessionRecord {
  version: 1;
  sessionId: string;
  /** Model ids (`provider/model`) that produced this session's messages. */
  models: string[];
  /** True once any message had a cache discount, so savings are meaningful. */
  cacheDiscounted: boolean;
  /** True once any message was priced above zero, so `savedUsd` is money. */
  billed: boolean;
  totals: Totals;
  history: HistoryPoint[];
  startedAt: number;
  updatedAt: number;
}

export interface Aggregate {
  sessionCount: number;
  totals: Totals;
  cacheDiscounted: boolean;
  billed: boolean;
  models: string[];
}

export function emptyTotals(): Totals {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    turns: 0,
    savedUsd: 0,
    costUsd: 0,
  };
}

// ─── Config ────────────────────────────────────────────────────

export interface Config {
  /** Show the per-session hit rate in pi's footer. */
  statusLine: boolean;
  /** Pin OpenRouter requests to one cache-capable upstream. */
  pinOpenRouter: boolean;
  /** Let OpenRouter fall back when the pinned upstream fails. */
  pinAllowFallbacks: boolean;
  /** Force upstream order for the pin (OpenRouter `tag` prefixes), or null. */
  pinOrder: string[] | null;
}

export const DEFAULT_CONFIG: Config = {
  statusLine: true,
  pinOpenRouter: false,
  pinAllowFallbacks: true,
  pinOrder: null,
};

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Tolerant config read: unknown files and bad values fall back silently. */
export function normalizeConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
  const source = raw as Record<string, unknown>;
  const order = source.pinOrder;
  return {
    statusLine: asBool(source.statusLine, DEFAULT_CONFIG.statusLine),
    pinOpenRouter: asBool(source.pinOpenRouter, DEFAULT_CONFIG.pinOpenRouter),
    pinAllowFallbacks: asBool(
      source.pinAllowFallbacks,
      DEFAULT_CONFIG.pinAllowFallbacks,
    ),
    pinOrder:
      Array.isArray(order) && order.every((v) => typeof v === "string")
        ? order.length > 0
          ? (order as string[])
          : null
        : DEFAULT_CONFIG.pinOrder,
  };
}

export interface ConfigUpdate {
  config?: Config;
  error?: string;
}

const CONFIG_KEYS = new Set([
  "statusline",
  "pinopenrouter",
  "pinallowfallbacks",
  "pinorder",
]);

/**
 * Apply `key=value` pairs typed after `/cache-config`.
 * Keys are case-insensitive; boolean values accept on/off, true/false, 1/0.
 */
export function applyConfigArgs(current: Config, args: string): ConfigUpdate {
  const next: Config = { ...current, pinOrder: current.pinOrder };
  const parts = args
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { config: next };

  const parseBool = (value: string): boolean | undefined => {
    const v = value.toLowerCase();
    if (["on", "true", "yes", "1", "enable", "enabled"].includes(v)) return true;
    if (["off", "false", "no", "0", "disable", "disabled"].includes(v))
      return false;
    return undefined;
  };

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) return { error: `expected key=value, got "${part}"` };
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (!CONFIG_KEYS.has(key)) {
      return {
        error: `unknown key "${key}" (use statusLine, pinOpenRouter, pinAllowFallbacks, pinOrder)`,
      };
    }
    if (key === "pinorder") {
      const items = value
        .split(/[|+]/)
        .map((v) => v.trim())
        .filter(Boolean);
      next.pinOrder = items.length > 0 ? items : null;
      continue;
    }
    const parsed = parseBool(value);
    if (parsed === undefined) {
      return { error: `key "${key}" expects on/off, got "${value}"` };
    }
    if (key === "statusline") next.statusLine = parsed;
    if (key === "pinopenrouter") next.pinOpenRouter = parsed;
    if (key === "pinallowfallbacks") next.pinAllowFallbacks = parsed;
  }
  return { config: next };
}

export function loadConfig(dir: string): Config {
  try {
    const path = join(dir, CONFIG_FILE);
    if (!existsSync(path)) return { ...DEFAULT_CONFIG };
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(dir: string, config: Config): boolean {
  try {
    writeJsonAtomicSync(join(dir, CONFIG_FILE), config);
    return true;
  } catch {
    return false;
  }
}

// ─── Paths and atomic IO ───────────────────────────────────────

/** Session ids are pi-generated UUIDs, but never trust them as file names. */
export function safeSessionId(sessionId: string): string {
  const clean = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return clean || "unknown";
}

export function sessionPath(dir: string, sessionId: string): string {
  return join(
    dir,
    `${SESSION_FILE_PREFIX}${safeSessionId(sessionId)}${SESSION_FILE_SUFFIX}`,
  );
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function tmpPathFor(path: string): string {
  return `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
}

/** Write-then-rename so readers never observe a partial file. */
export function writeJsonAtomicSync(path: string, value: unknown): void {
  const tmp = tmpPathFor(path);
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = tmpPathFor(path);
  await writeFile(tmp, JSON.stringify(value, null, 2));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

// ─── Session records ───────────────────────────────────────────

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeTotals(raw: unknown): Totals {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const pick = (key: keyof Totals) =>
    isNumber(source[key]) && (source[key] as number) >= 0
      ? (source[key] as number)
      : 0;
  return {
    cacheRead: pick("cacheRead"),
    cacheWrite: pick("cacheWrite"),
    input: pick("input"),
    output: pick("output"),
    turns: pick("turns"),
    savedUsd: pick("savedUsd"),
    costUsd: pick("costUsd"),
  };
}

export function normalizeHistory(raw: unknown): HistoryPoint[] {
  if (!Array.isArray(raw)) return [];
  const points: HistoryPoint[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    if (
      !isNumber(p.turn) ||
      !isNumber(p.rate) ||
      !isNumber(p.cacheRead) ||
      !isNumber(p.at)
    ) {
      continue;
    }
    points.push({
      turn: p.turn,
      rate: Math.min(Math.max(p.rate, 0), 1),
      cacheRead: p.cacheRead,
      cacheWrite: isNumber(p.cacheWrite) ? p.cacheWrite : 0,
      input: isNumber(p.input) ? p.input : 0,
      at: p.at,
    });
  }
  return points.slice(-MAX_HISTORY_POINTS);
}

/**
 * Validate a parsed session file. Anything unrecognisable is dropped instead of
 * poisoning an aggregate — a single stale record must never break `/cache-stats`.
 */
export function normalizeSessionRecord(
  raw: unknown,
  fallbackSessionId?: string,
): SessionRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const sessionId =
    typeof source.sessionId === "string" && source.sessionId
      ? source.sessionId
      : fallbackSessionId;
  if (!sessionId) return undefined;

  const totals = normalizeTotals(source.totals ?? source);
  const models = Array.isArray(source.models)
    ? source.models.filter((m): m is string => typeof m === "string").slice(0, 20)
    : [];

  return {
    version: 1,
    sessionId,
    models,
    cacheDiscounted: source.cacheDiscounted === true,
    billed: source.billed === true,
    totals,
    history: normalizeHistory(source.history),
    startedAt: isNumber(source.startedAt) ? source.startedAt : 0,
    updatedAt: isNumber(source.updatedAt) ? source.updatedAt : 0,
  };
}

export function loadSession(
  dir: string,
  sessionId: string,
): SessionRecord | undefined {
  try {
    const path = sessionPath(dir, sessionId);
    if (!existsSync(path)) return undefined;
    return normalizeSessionRecord(JSON.parse(readFileSync(path, "utf8")), sessionId);
  } catch {
    return undefined;
  }
}

export async function saveSession(
  dir: string,
  record: SessionRecord,
): Promise<void> {
  ensureDir(dir);
  await writeJsonAtomic(sessionPath(dir, record.sessionId), record);
}

export function saveSessionSync(dir: string, record: SessionRecord): boolean {
  try {
    ensureDir(dir);
    writeJsonAtomicSync(sessionPath(dir, record.sessionId), record);
    return true;
  } catch {
    return false;
  }
}

// ─── Aggregate across sessions ─────────────────────────────────

/** Sum records. Pure, so the arithmetic is directly testable. */
export function aggregateRecords(records: SessionRecord[]): Aggregate {
  const totals = emptyTotals();
  const models = new Set<string>();
  let cacheDiscounted = false;
  let billed = false;

  for (const record of records) {
    totals.cacheRead += record.totals.cacheRead;
    totals.cacheWrite += record.totals.cacheWrite;
    totals.input += record.totals.input;
    totals.output += record.totals.output;
    totals.turns += record.totals.turns;
    totals.savedUsd += record.totals.savedUsd;
    totals.costUsd += record.totals.costUsd;
    for (const model of record.models) models.add(model);
    cacheDiscounted ||= record.cacheDiscounted;
    billed ||= record.billed;
  }

  return {
    sessionCount: records.length,
    totals,
    cacheDiscounted,
    billed,
    models: [...models].sort(),
  };
}

function sessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter(
      (name) =>
        name.startsWith(SESSION_FILE_PREFIX) && name.endsWith(SESSION_FILE_SUFFIX),
    );
  } catch {
    return [];
  }
}

/** Read every session file, newest first, skipping unreadable ones. */
export async function loadAllSessions(
  dir: string,
  limit = MAX_AGGREGATE_SESSIONS,
): Promise<{ records: SessionRecord[]; skipped: number }> {
  const files = sessionFiles(dir);
  const records: SessionRecord[] = [];
  let skipped = 0;

  const loaded = await Promise.all(
    files.map(async (file) => {
      try {
        const raw = await readFile(join(dir, file), "utf8");
        const fallback = file
          .slice(SESSION_FILE_PREFIX.length, -SESSION_FILE_SUFFIX.length);
        return normalizeSessionRecord(JSON.parse(raw), fallback);
      } catch {
        return null;
      }
    }),
  );

  for (const record of loaded) {
    if (!record) {
      skipped += 1;
      continue;
    }
    records.push(record);
  }

  records.sort((a, b) => b.updatedAt - a.updatedAt);
  return { records: records.slice(0, limit), skipped };
}

// ─── Cleanup ───────────────────────────────────────────────────

/** Delete session files whose mtime is older than `maxAgeMs`. */
export function cleanupOldSessions(
  dir: string,
  now: number,
  maxAgeMs = MAX_SESSION_AGE_MS,
): number {
  let deleted = 0;
  const cutoff = now - maxAgeMs;
  for (const file of sessionFiles(dir)) {
    try {
      const path = join(dir, file);
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        deleted += 1;
      }
    } catch {
      // best effort per file
    }
  }
  return deleted;
}

/** Run the cleanup at most once per day, tracked by a marker file. */
export function maybeCleanup(
  dir: string,
  now: number,
  intervalMs = 24 * 60 * 60 * 1000,
): number {
  try {
    const marker = join(dir, CLEANUP_MARKER);
    if (existsSync(marker)) {
      const last = Number.parseInt(readFileSync(marker, "utf8"), 10);
      if (Number.isFinite(last) && now - last < intervalMs) return 0;
    }
    const deleted = cleanupOldSessions(dir, now);
    ensureDir(dir);
    writeFileSync(marker, String(now), "utf8");
    return deleted;
  } catch {
    return cleanupOldSessions(dir, now);
  }
}

/** Delete every session file (used by `/cache-reset all`). */
export function deleteAllSessions(dir: string): number {
  let deleted = 0;
  for (const file of sessionFiles(dir)) {
    try {
      unlinkSync(join(dir, file));
      deleted += 1;
    } catch {
      // best effort
    }
  }
  return deleted;
}
