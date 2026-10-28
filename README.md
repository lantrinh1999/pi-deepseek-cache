# pi-cache-insights

Prefix-cache telemetry for [pi](https://github.com/badlogic/pi-mono). It answers
three questions with numbers you can verify:

- **How much of my prompt is being served from cache?** Per session and per turn.
- **How much did those cache hits save?** In dollars at list price, or in reused
  tokens for plans that are not metered.
- **When did the cache break?** `/cache-graph` plots the per-turn hit rate and
  points at the turns where the prefix changed.

```
⚡ Prefix cache
  Hit rate       97.4%
  Reused         900K tokens
  Fresh input    20K tokens
  Cache writes   4.1K tokens
  Turns          12
  Saved          $0.270 at list price
  ↘ turn 4: 5.0% of 5K prompt — prefix likely changed

─── all sessions · 7
  Hit rate       94.3%
  Reused         1.5M tokens
  Fresh input    90K tokens
  Turns          40
  Saved          $1.20 at list price
```

> This is a fork of
> [`rohaquinlop/pi-deepseek-cache`](https://github.com/rohaquinlop/pi-deepseek-cache),
> rewritten for pi 1.x. The original was built for pi 0.79 and had drifted:
> it rewrote parts of the system prompt that no longer exist, estimated prices
> from a hardcoded table, and crashed its compaction hook on a removed API. See
> [What changed](#what-changed).

## Install

```bash
pi install git:github.com/lantrinh1999/pi-deepseek-cache
```

Or from a local checkout:

```bash
pi install ./path/to/pi-deepseek-cache
```

Nothing to configure: the extension activates for every model and starts
collecting on the first turn. It works for any provider that reports prompt
cache usage — DeepSeek, Xiaomi MiMo, Anthropic, OpenAI, OpenRouter, gateways,
and any OpenAI-compatible endpoint that returns `prompt_cache_hit_tokens` or
`cached_tokens`.

## Commands

| Command | What it does |
|---|---|
| `/cache-stats` | Overlay with this session's hit rate, reused tokens, cache writes, turns, cost saved, and an aggregate across stored sessions. `g` switches to the graph, `esc` closes. |
| `/cache-graph` | Per-turn hit rate sparkline with min/avg/max, plus the turns where the cache broke. `s` switches back to stats. |
| `/cache-reset` | Forget this session. `/cache-reset all` deletes every stored session (with a confirmation dialog). |
| `/cache-config` | Print current settings, or change them: `/cache-config statusLine=off pinOpenRouter=on`. |

The footer shows a compact `⚡ 97.4%` line for the current session. It turns
into `⚡ 12.0% ↓` when the last turn lost the prefix cache.

## Settings

`/cache-config key=value` writes to `config.json` in the data directory:

| Key | Default | Meaning |
|---|---|---|
| `statusLine` | `on` | Show the `⚡` hit-rate line in pi's footer. |
| `pinOpenRouter` | `off` | Pin OpenRouter requests to one cache-capable upstream (see below). |
| `pinAllowFallbacks` | `on` | Let OpenRouter fall back when the pinned upstream fails. Set `off` only for strict pinning. |
| `pinOrder` | `(auto)` | Comma- or pipe-separated upstream slugs to prefer, e.g. `pinOrder=deepinfra|parasail`. Auto = cheapest cache-capable upstream. |

Environment:

- `PI_CACHE_INSIGHTS_DIR` — override the data directory (used by the smoke test).

## How the numbers are computed

pi prices every assistant message itself and exposes the result as
`message.usage.cost`. The extension never guesses prices:

```
saved = (cacheRead + cacheWrite + input) × model.cost.input
        − (usage.cost.input + usage.cost.cacheRead + usage.cost.cacheWrite)
```

The first term is the counterfactual: what those prompt tokens cost as fresh
input. The second is what pi actually billed for the input side, so any cache
write premium (Anthropic charges 1.25× input) is included automatically. The
result is clamped at zero and only reported for models that have a cache
discount (`cost.input > cost.cacheRead`).

Consequences worth knowing:

- **Prices follow the provider.** The same model on OpenRouter, a gateway, and
  the first-party API can cost three different amounts; each session is priced
  with the model entry pi used for that turn.
- **Price changes don't rewrite history.** Each session stores the savings it
  produced, so the aggregate stays historically accurate.
- **Non-metered plans report tokens, not money.** If pi prices a model at zero
  (free tiers, bundled token plans), the overlay shows reused tokens and says
  `not metered` instead of inventing dollars.
- **Subscriptions show list price.** For subscription-backed providers pi still
  computes cost at catalog prices; the label says `at list price` so the number
  is read as value received, not as an invoice.

## What it deliberately does not do

Two behaviours from the original extension were removed on purpose:

**It never rewrites your system prompt.** pi ≥ 0.85 builds a structured prompt
with `<cwd>` as its own section and no `Current date:` line, and only re-sends
sections that changed. The old trick of freezing `Current date` /
`Current working directory` therefore matches nothing — it was a no-op that
added a prompt-mutation hook for no benefit.

**It never intercepts compaction.** pi's compaction handles split turns, custom
instructions (`/compact <focus>`), read/modified file tracking, and the
overflow-recovery path. An extension summary replaces all of that with one
prompt. The original tried and, on pi 1.x, threw on a removed registry API and
fell back to the default anyway.

## OpenRouter pinning (optional)

OpenRouter load-balances each model across upstream providers, and each upstream
keeps its own KV cache — requests landing on different upstreams get almost no
cache hits. With `pinOpenRouter=on`, the first request for a model queries
`/api/v1/models/<slug>/endpoints` and adds OpenRouter's routing object to every
subsequent request:

```json
{ "provider": { "order": ["<upstream>"], "allow_fallbacks": true } }
```

Details that matter in practice:

- Only endpoints that publish an `input_cache_read` price are considered, since
  the others cannot serve cache hits.
- The cheapest active upstream wins unless `pinOrder` names your preferred ones.
  Cheapest is not always best: it can be a small third-party host. Use
  `pinOrder` when you care.
- `allow_fallbacks` stays on by default, so a dead upstream degrades to a cache
  miss instead of a failed request.
- Lookups are cached for 6 hours (30 minutes after a failure), and a failed
  refresh keeps the last known-good upstream.
- A request that already carries routing — your own `provider` preferences in
  `models.json` — is left untouched. The overlay reports `user routing`.
- pi 1.x already sends OpenRouter session-affinity headers, which keeps most
  sessions on one upstream without pinning. Treat this as a stricter option,
  not a requirement.

## Data and privacy

Everything is local:

```
~/.pi/agent/extensions/cache-insights/
  session-<id>.json   # one file per session: totals, models, per-turn history
  config.json         # settings above
  .last-cleanup       # cleanup throttle marker
```

- One file per session, so concurrent sessions never race.
- Writes are debounced (800 ms) and atomic (temp file + rename).
- Resuming a session continues its record instead of zeroing it.
- Session files older than 30 days are deleted, at most once a day.
- No prompts, messages, or tool output are ever written — only counters,
  model ids, and per-turn rates.
- A corrupt session file is skipped, never fatal.

## What changed from the original

| Area | Original | Here |
|---|---|---|
| Prompt rewriting | Froze `Current date` / `Current working directory` | Removed: pi 1.x has no such lines |
| Prefix diagnostics | Hashed `messages.slice(0, -1)`, so the "break" counter grew every turn | Per-turn hit rate; breaks are detected by the actual collapse in hit rate, and only flagged when it is real |
| Pricing | Hardcoded table per model family, overriding pi's real prices | `message.usage.cost` + `model.cost`, per provider, with no invented money for non-metered plans |
| Compaction | Intercepted and crashed on `modelRegistry.listProviders()` (removed in pi 1.x) | Not intercepted; pi's compaction keeps split turns and file tracking |
| Resume / reload | Counters reset on every `session_start` | Record is loaded and continued |
| OpenRouter pin | Always on, `allow_fallbacks: false` | Opt-in, fallbacks on by default, respects explicit routing, `pinOrder` override |
| Overlays | Fixed 58/60-column boxes, values truncated at narrow widths | Responsive box plus a wrapped compact layout below 40 columns |
| Persistence | Single shared aggregate file for some data, non-atomic writes | Per-session files, atomic writes, resume-safe, corrupt-file tolerant |
| Type-safety | `complete` imported from the pi-ai root (only resolves through pi's compat alias), `listProviders` typed as missing | `tsc --noEmit` clean against pi 1.4.0 types |

## Development

```bash
npm install
npm run check                 # typecheck + 91 unit tests
npm run smoke                 # end-to-end against your installed pi
```

`npm run smoke` spawns `pi` three times in a temp directory: a first turn, a
resumed turn (verifies counters accumulate), and an overlay probe that renders
both overlays with pi's real theme and asserts the boxes stay rectangular. It
needs an authenticated model and never touches your real telemetry.

Unit tests cover the cost math (including cache-write premiums and zero-priced
plans), config parsing, store round-trips, corrupt and legacy records, cleanup
throttling, upstream selection and pin cache TTLs, sparkline/sampling/break
detection, and overlay layout at 24–100 columns.

Design notes live in the file headers: `lib/pricing.ts` (cost math),
`lib/store.ts` (persistence), `lib/pin.ts` (OpenRouter), `lib/graph.ts` (chart
helpers), `lib/render.ts` (overlays), and `extensions/index.ts` (wiring).

## License

MIT. Original work © Robin Quintero; fork © lantrinh1999. See [LICENSE](LICENSE).
