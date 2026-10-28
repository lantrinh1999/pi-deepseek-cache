/**
 * End-to-end smoke test against a real `pi` installation.
 *
 * It proves the parts unit tests cannot: that pi loads the extension, that the
 * event payloads we rely on are still shaped the way we expect, that a session
 * record lands on disk, and that resuming a session accumulates instead of
 * resetting.
 *
 *   npm run smoke
 *
 * Requires an authenticated pi model. Uses a temp session dir and a temp store
 * dir, so it never touches your real telemetry.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(repoRoot, "extensions", "index.ts");
const probePath = join(repoRoot, "scripts", "overlay-probe.ts");
const piBin = process.env.PI_BIN ?? "pi";

const workDir = mkdtempSync(join(tmpdir(), "cache-insights-smoke-"));
const storeDir = join(workDir, "store");
const sessionDir = join(workDir, "sessions");
const overlayOut = join(workDir, "overlay.json");

interface Totals {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  turns: number;
  savedUsd: number;
  costUsd: number;
}

interface SessionRecordFile {
  sessionId: string;
  models: string[];
  totals: Totals;
  history: Array<{ turn: number; rate: number }>;
}

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
    return;
  }
  failures.push(message);
  console.log(`  FAIL ${message}`);
}

function runPi(args: string[], prompt: string) {
  const result = spawnSync(piBin, [...args, "-p", prompt], {
    cwd: workDir,
    encoding: "utf8",
    timeout: 240_000,
    env: {
      ...process.env,
      PI_CACHE_INSIGHTS_DIR: storeDir,
      PI_CACHE_OVERLAY_OUT: overlayOut,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { status: result.status, output };
}

function records(): SessionRecordFile[] {
  if (!existsSync(storeDir)) return [];
  return readdirSync(storeDir)
    .filter((name) => name.startsWith("session-") && name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(storeDir, name), "utf8")) as SessionRecordFile)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

function main(): void {
  console.log(`pi binary : ${piBin}`);
  console.log(`work dir  : ${workDir}`);

  try {
    console.log("\n1. first turn");
    const first = runPi(
      ["--offline", "--session-dir", sessionDir, "-e", extensionPath],
      "Reply with exactly: ok",
    );
    check(first.status === 0, `pi exited 0 (got ${String(first.status)})`);
    check(
      !/extension (error|failed)|Error loading extension/i.test(first.output),
      "no extension load error in output",
    );

    const sessionFiles = existsSync(sessionDir)
      ? readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"))
      : [];
    check(sessionFiles.length === 1, "pi wrote one session transcript");

    const afterFirst = records();
    check(afterFirst.length === 1, "extension wrote one session record");
    const record = afterFirst[0];
    if (!record) return;

    check(record.totals.turns >= 1, `turn counter advanced (${record.totals.turns})`);
    check(
      record.totals.cacheRead + record.totals.input > 0,
      `prompt tokens recorded (${record.totals.cacheRead + record.totals.input})`,
    );
    check(record.models.length >= 1, `model recorded (${record.models.join(", ")})`);
    check(record.history.length >= 1, "history point recorded");
    const point = record.history[record.history.length - 1];
    check(
      point !== undefined && point.rate >= 0 && point.rate <= 1,
      `hit rate in range (${point ? (point.rate * 100).toFixed(1) : "n/a"}%)`,
    );

    console.log("\n2. resumed turn");
    const transcript = join(sessionDir, sessionFiles[0] as string);
    const second = runPi(
      ["--offline", "--session", transcript, "-e", extensionPath],
      "Reply with exactly: done",
    );
    check(second.status === 0, `pi exited 0 on resume (got ${String(second.status)})`);

    const afterSecond = records();
    const resumed = afterSecond.find((item) => item.sessionId === record.sessionId);
    check(resumed !== undefined, "session record survived the resume");
    if (resumed) {
      check(
        resumed.totals.turns > record.totals.turns,
        `resume accumulated turns instead of resetting (${record.totals.turns} → ${resumed.totals.turns})`,
      );
      check(resumed.history.length >= 2, "history grew across the resume");
      console.log(
        `\n  session ${resumed.sessionId}: ${resumed.totals.turns} turns · ` +
          `${resumed.totals.cacheRead} cached / ${resumed.totals.input} fresh tokens`,
      );
    }

    console.log("\n3. overlays rendered with pi's real theme");
    const overlayRun = runPi(
      [
        "--offline",
        "--no-session",
        "-e",
        extensionPath,
        "-e",
        probePath,
      ],
      "Reply with exactly: ok",
    );
    check(overlayRun.status === 0, `pi exited 0 for the overlay probe`);
    const captured = existsSync(overlayOut)
      ? (JSON.parse(readFileSync(overlayOut, "utf8")) as { [key: string]: string[] })
      : undefined;
    check(captured !== undefined, "overlay probe produced output");

    if (captured) {
      for (const [name, lines] of Object.entries(captured)) {
        check(lines.length > 3, `${name}: has ${lines.length} rendered rows`);
        const widths = new Set(lines.map((line) => visibleWidth(line)));
        check(widths.size === 1, `${name}: every row has the same width`);
        const stripped = lines.map(stripAnsi);
        check(
          stripped.every(
            (line) =>
              line.startsWith("│") ||
              line.startsWith("╭") ||
              line.startsWith("╰"),
          ),
          `${name}: every row starts with a box border`,
        );
        check(
          stripped.every(
            (line) =>
              line.endsWith("│") ||
              line.endsWith("╮") ||
              line.endsWith("╯"),
          ),
          `${name}: every row closes its box border`,
        );
        check(
          stripAnsi(lines.join("\n")).includes("Prefix cache") ||
            stripAnsi(lines.join("\n")).includes("hit rate"),
          `${name}: contains overlay content`,
        );
      }
      check(
        captured.narrow !== undefined &&
          visibleWidth(captured.narrow[0] ?? "") < 40,
        "narrow viewport shrinks the box",
      );
      if (process.env.PI_CACHE_SMOKE_VERBOSE) {
        for (const [name, lines] of Object.entries(captured)) {
          console.log(`\n  --- ${name} ---`);
          console.log(lines.map((line) => `  ${stripAnsi(line)}`).join("\n"));
        }
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log("\nall smoke checks passed");
}

main();
