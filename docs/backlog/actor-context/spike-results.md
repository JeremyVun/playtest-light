# Actor-context spike results, 2026-10-10

Historical research, preserved verbatim below. The current design is
[design.md](design.md); its contracts supersede the proposals and gates here.
These are synthetic 20-decision measurements on the recorded Codex versions,
not proof of long-session reliability, constant context size or current pricing.
Observed cache misses were attributed to backend behaviour in the spike;
that attribution does not establish a universal miss rate or cause.

## Spike results (phase 1)

Measured 2026-10-10 with `tools/spike-context.ts` (Codex CLI 0.160.0,
`gpt-6.1-sol`, a private stdio app-server). Each session is 20 synthetic
decisions: base instructions with the story (8.7k characters, 2,065
tokens), the real act, done and give_up tools, a steps log that grows by
one line per decision, and a 1.3–2.5k-character page that differs every
decision. The model answers each decision with one `act` call and the turn
is cut there.

**Gate: failed.** No way of driving Codex keeps everything but the newest
log line and page cached on every decision:

1. Codex's backend reuses a cached prefix only up to a checkpoint, not up
   to any shared 128-token block (below), so a log after the base
   instructions is never cached unless it rides in the base instructions.
2. Codex puts `~/.codex/AGENTS.md` (925 tokens here) after the base
   instructions on every turn, so whenever anything earlier changes per
   decision it is uncached. No config key removes it.
3. 1 to 4 decisions in 19 miss the cache entirely, in every strategy that
   keeps one cache key, on both transports: backend routing, not something
   the client sends.

### The measurements

Medium effort, decisions 2–20, p50 unless marked. "Expected" is the
newest log line, the page and up to two 128-token blocks; the gate counts
decisions whose uncached input is within that. Latencies drift by 1–3 s
with backend load, so compare rows from the same run: A is the full
matrix (the http and ws sessions ran at the same time), B the warm
strategy, C revert and forklog side by side.

| run | strategy | transport | turn → call ms (p50/p90) | cut + restore ms | input | cached | uncached | expected | gate | gate without AGENTS.md | full misses |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | revert | http | 4,292 / 6,592 | 1,103 | 6,178 | 4,352 | 1,891 | 592 | 0/19 | – | 2/19 |
| A | revert | ws | 5,798 / 6,807 | 868 | 6,180 | 4,352 | 1,828 | 594 | 0/19 | – | 2/19 |
| A | fresh | http | 4,785 / 8,067 | 73 to start | 6,180 | 0 | 6,118 | 594 | 0/19 | – | 16/19 |
| A | fresh | ws | 5,267 / 9,180 | 73 to start | 6,180 | 0 | 6,161 | 594 | 0/19 | – | 18/19 |
| A | fork | http | 5,556 / 9,382 | 10 to fork | 6,242 | 4,352 | 1,955 | 609 | 0/19 | – | 3/19 |
| A | accumulate (v1) | http | 5,384 / 7,368 | – | 13,623 | 11,776 | 1,141 | – | – | – | 1/19 |
| A | accumulate (v1) | ws | 4,839 / 5,984 | – | 13,241 | 11,520 | 979 | – | – | – | 1/19 |
| B | warm | http | 4,896 / 6,790 | 1,291, then a 4,064 warm turn | 6,181 | 5,376 | 764 | 595 | 18/19 | – | 1/19 |
| C | revert | http | 5,422 / 7,700 | 689 | 6,180 | 4,352 | 1,976 | 594 | 0/19 | 5/19 | 4/19 |
| C | forklog | http | 5,060 / 6,413 | 9 to fork | 6,241 | 4,480 (4,352 → 4,736) | 1,742 | 608 | 0/19 | 15/19 | 4/19 |

- **revert**: one persisted thread; each turn is cut at its call and
  reverted. **fresh**: a new ephemeral thread per decision. **fork**: an
  ephemeral fork per decision from a one-turn source thread. **forklog**:
  fork, with the steps log in the fork's base instructions and only the
  page in the turn. **warm**: revert, plus a throwaway turn after each
  decision whose message ends at the log. **accumulate**: v1's way, one
  turn whose act results carry the pages; input grows from 6.0k to 19.4k
  tokens by decision 20.
- Every cut strategy spent exactly one model response per decision (warm
  two); accumulate 1.05. Output was 50–160 tokens, reasoning mostly 0.
- Revert's restore time grows through the session (see Hazards), so its
  p50 hides 1–2 s at the end. Fork cut at once (run B) took 4,467 / 7,141
  ms to the call, but then its usage is lost.
- Low effort gave the same picture: revert 4,662 ms to the call, 4,352
  cached; warm 5,376 cached, 17/19.
- History is really gone: a marker shown at decision 5 was never visible
  at decision 6 in any cut strategy; accumulate saw it.
- Totals over 20 decisions (input / cached, thousands): revert 124 / 63–74,
  forklog 125 / 68–80, warm 124 / 97 plus 107 / 89 for the warm turns,
  accumulate 279 / 237, fresh 124 / 9.

### What makes the cache hold or break

- Codex sends, in order: its code-mode tool docs with our tool
  declarations (one item), our base instructions verbatim, `AGENTS.md` as a
  user message, then the turn. Request bodies captured through a stand-in
  local provider show nothing before our message changes between
  decisions except the `AGENTS.md` item's id (re-created on every turn
  after a revert to empty history); per-turn metadata such as turn ids and
  timestamps travels outside the prompt. Codex does not vary the prefix.
- The backend (`chatgpt.com/backend-api/codex/responses`, 24-hour
  retention, `prompt_cache_key` = the thread id; forks send their source's
  key) serves a cached prefix only up to a checkpoint: (a) the end of the
  base instructions, rounded down to 128 tokens; (b) one 128-token block
  short of the end of an earlier request's whole prompt. Per-item
  attribution from Codex's trace log shows it exactly: revert caches the
  tools and the instructions (4,352) and nothing of `AGENTS.md`, the log or
  the page; a request whose predecessor ended within a block of the shared
  prefix caches everything up to there. Item ids do not matter; pinning
  `AGENTS.md`, injecting the log as items with fixed ids, and putting it in
  collaboration-mode developer text all left the cache at checkpoint (a).
- So: **forklog** moves checkpoint (a) along with the log and caches
  everything we send but the newest line and the page; `AGENTS.md` stays
  uncached. **warm** leaves a checkpoint (b) at the end of the log, at the
  price of a second model response per decision (about 4 s, 5 output
  tokens): over 20 decisions 44k uncached tokens against revert's 50k, but
  2.5 times the cached ones and twice the model calls, so not worth it.
  **fresh** threads get a new `prompt_cache_key` each and mostly miss.
- WebSocket versus HTTP: an interrupt or a revert drops Codex's WebSocket,
  and the next turn reconnects and sends a warm-up first, about 1–1.5 s.
  A custom model provider with the same endpoint and sign-in over HTTP
  (`model_providers.<id> = { name = "OpenAI", wire_api = "responses",
  requires_openai_auth = true, supports_websockets = false }` in the
  thread's config, plus `modelProvider`) avoids it; caching is identical.

### What Codex adds that we cannot remove

- Code-mode tool docs: 1,604 tokens; our three tools add 802. Cached.
- `~/.codex/AGENTS.md`: 925 tokens, every turn, after the base
  instructions. `project_doc_max_bytes = 0` and five guessed keys do not
  remove it. A private `CODEX_HOME` does (checked against the stand-in
  provider) but needs its own `codex login` and cannot use the shared
  daemon.
- About 5 tokens of framing per message. No Codex system prompt (the base
  instructions replace it) and no environment or permissions context (the
  v1 lockdown).
- An interrupt appends a `<turn_aborted>` message (about 50 tokens); revert
  removes it and forks are thrown away.

### Why v1 saw 3,200 cached on some identical requests and 0 on others

Every v1 spike scenario ran on a new thread, so a new `prompt_cache_key`:
the first response of each thread missed (reproduced: three fresh threads
with identical prefixes, 0 cached each). Later responses in the same turn
extend the previous request, so they hit checkpoint (b), all but the last
block or two of the previous input (reproduced: 2,432 of 2,664). The
exact 3,200 / 6,700 figures cannot be reproduced on Codex 0.160.0, whose
fixed overhead with one tool is now 2.6k tokens.

### Hazards

- `thread/revert` needs a persisted thread (ephemeral threads are refused),
  which writes a rollout under `~/.codex/sessions` and shows in the Codex
  app's thread list until `thread/delete`. Revert time grows by about 65 ms
  per reverted turn: 1–2 s at decision 20, 4 s at decision 60.
- `thread/fork` needs a source with a rollout, which exists only after a
  first turn; fork time grows with that rollout (10 ms with one turn, 0.9 s
  with 60), so the source must stay at one turn. Forks take none of the
  source's `thread/start` config (lockdown, provider, instructions): pass
  them again.
- Usage: `rawResponse/completed` and `thread/tokenUsage/updated` (`last`)
  agree exactly. Raw events exist only on `thread/start`; without them
  usage arrives when the turn ends. The tool call can arrive before its
  response completes, so the cut holds the tool reply until the usage
  arrives (forks: about 1 s) and only then interrupts; that also means no
  follow-up response can start.

### What this leaves for Jeremy to decide

1. **forklog over HTTP**, the best Codex allows: about 5 s per decision at
   medium, a flat 6.2k-token context, everything we send cached except the
   newest line and page; `AGENTS.md` (925 tokens here) uncached on every
   decision, and the random misses.
2. **forklog plus a private `CODEX_HOME`** without `AGENTS.md` should
   meet the gate on every decision the backend does not randomly miss
   (inferred from the "gate without AGENTS.md" column, not run), at the
   cost of a separate Codex sign-in for playtest and no shared daemon.
3. **The direct Responses API backend.** Unmeasured: whether its cache
   checkpoints behave the same is not known.

## Order with the grader item

This item goes first: the grader item rewrites `done` and findings on top of
the actor loop this item rewrites. `docs/backlog/grader/` builds after it.

## Rejected

- **Codex's own compaction (`thread/compact/start`).** A model-written
  summary: slow, lossy, and not ours to shape.
- **Keeping one thread and only shrinking each result.** Smaller, but it
  still grows with every decision and keeps stale pages the model may act
  on.
- **A direct Responses API backend now.** Full control, but it needs an API
  key billed to the team's credits, which the team does not have; it stays
  behind the model interface for later.

## Ruling after the spike (2026-10-10)

Jeremy chose: give playtest its own Codex home (`CODEX_HOME`, default
`~/.playtest-lite/codex`, its own sign-in) so `~/.codex/AGENTS.md` is never
injected, then measure forklog over HTTP against the cache gate again before
building. Forklog as is and the direct Responses API stay the fallbacks.

## Spike results, own Codex home (phase 1b)

Measured 2026-10-10 with `tools/spike-context.ts --codex-home
~/.playtest-lite/codex` (Codex CLI 0.160.0, `gpt-6.1-sol`, a private stdio
app-server, the same synthetic 20-decision sessions as phase 1). Forklog
over HTTP unless marked.

**Gate: passed on the phase-1 measure, apart from the backend's random
misses (15% of decisions).** Over seven forklog runs on HTTP, 113 of 133
decisions were served from the cache, and 110 of those left uncached no
more than the newest log line, the page and two 128-token blocks (the
allowance phase 1 used); the other 3 were served an older checkpoint, three
blocks short. 20 decisions (15%) were random misses. To the exact block it
passes on only 15 of the 113: the backend checkpoints the instructions about
one block before their end, so about 128 tokens of the log above the newest
line stay uncached on most decisions. Nothing client-side moves either
(below).

### What the prompt contains now

From requests captured through a stand-in provider (`--capture`) and the
per-item token counts in the trace:

| part | tokens | cached on a hit |
|---|---|---|
| Codex's tools item: code-mode `exec` with its docs and our `act`, `done` and `give_up` declarations, plus Codex's `wait` and `request_user_input_async` | 2,406 | all |
| our base instructions verbatim, then "Steps so far" | 2,076 at decision 1, 2,464 at decision 20 | up to about one block before the end |
| the turn: budget left and the current page | 419–804, p50 about 520 | none |

Nothing else: no `AGENTS.md`, no environment or permissions text, no skills,
apps, plugins or MCP tools, no notify hook. The default home sends the same
three items plus `AGENTS.md` (925 tokens) after the instructions. Outside
the prompt only one header differs (`x-codex-beta-features` also carries the
default home's `prevent_idle_sleep`). Every fork sends the source thread's id
as `prompt_cache_key`, so a session has one key.

One fix was needed. `thread/fork` takes no `environments`, so each fork got
the default environment and with it an `apply_patch` section in its tools
(61 tokens) that the source thread, started with `environments: []`, did not
have, so decision 2 shared only the start of the tools item with decision 1.
Sending `environments: []` on every `turn/start` makes every decision's tools
identical. Phase 1's fork runs had the same flaw.

The home needs no `config.toml`: the lockdown, the HTTP provider and the
effort go per thread as before. Codex fills a new home by itself: curated
remote plugins (28 MB) and bundled system skills on first start, and a log
database that grows with use (16 MB after this spike). None of it reaches the
prompt. `codex -c features.plugins=false -c features.remote_plugin=false
app-server` stops the plugin download without a config file.

### The measurements

Decisions 2–20, p50 unless marked. "turn → call" runs from `turn/start` to
the `act` call reaching the harness; the fork before it takes 6–7 ms, and a
fork's cut (the call held 1 s, then the interrupt) runs after it while the
harness acts. "Expected" is the newest log line and the page, rounded to the
cache's 128-token blocks; on HTTP it is exact, from the trace's per-item
counts (WebSocket and daemon rows use the character estimate). The gate
column counts, out of the decisions served from cache, those whose uncached
input is within expected, one block over and two blocks over. A miss is a
decision served none of the instructions: nothing, or only the tools.

| run | setting | turn → call ms p50 / p90 | input | cached | uncached on hits | expected | gate exact / 1 block / 2 blocks | misses |
|---|---|---|---|---|---|---|---|---|
| 1 | medium | 4,286 / 7,334 | 5,257 | 4,352 | 743 | 649 | 3 / 13 / 15 of 15 | 4/19 |
| 2 | medium | 4,382 / 6,121 | 5,255 | 4,480 | 756 | 646 | 3 / 12 / 16 of 16 | 3/19 |
| 3 | medium | 4,134 / 5,326 | 5,256 | 4,352 | 776 | 648 | 2 / 12 / 15 of 15 | 4/19 |
| 4 | medium, 3 s between decisions | 4,926 / 7,232 | 5,254 | 4,480 | 773 | 645 | 1 / 16 / 16 of 17 | 2/19 |
| 5 | low | 4,312 / 5,615 | 5,256 | 4,480 | 775 | 647 | 2 / 13 / 16 of 16 | 3/19 |
| 6 | medium, priority tier | 3,500 / 4,846 | 5,257 | 4,480 | 758 | 648 | 3 / 17 / 18 of 18 | 1/19 |
| 7 | medium, private daemon | 4,574 / 5,507 | 5,255 | 4,480 | 775 | 646 | 1 / 12 / 14 of 16 | 3/19 |
| – | medium, WebSocket | 5,327 / 7,274 | 5,256 | 4,480 | 774 | 646 | 2 / 11 / 15 of 16 | 3/19 |
| – | revert, medium | 4,494 / 6,696 | 5,256 | 4,352 | 969 | 647 | 1 / 5 / 9 of 18 | 1/19 |
| – | accumulate (v1), medium | 4,948 / 5,902 | 12,634, from 5.1k to 18.4k | 10,880 | 921 | – | – | 2/19 |
| – | forktrail, medium | 4,623 / 8,675 | 5,321 | 2,176 | 3,174 | – | 0 of 18 | – |

Per decision, runs 1–3 (pass: exact; +n: n blocks over; MISS):

```
1: pass +1 MISS +1 +1 +1 pass +2 MISS MISS pass MISS +1 +2 +1 +1 +1 +1 +1
2: pass +1 +1 MISS MISS +1 pass +2 MISS +1 +2 +1 +2 +1 +2 +1 +1 +1 pass
3: MISS +1 +1 +1 MISS +1 pass MISS +2 +1 +2 +1 +1 +2 MISS +1 +1 +1 pass
```

- Against phase 1's forklog in the default home (input 6,241, uncached
  1,742), each decision sends 985 fewer tokens and leaves less than half as
  many uncached when the cache hits.
- Totals over 20 decisions (input / cached / uncached, thousands): forklog
  105 / 67–81 / 24–38, depending on its misses (each costs about 4.4k);
  revert 105 / 78 / 27 in this run, with one miss; accumulate 240 / 194 / 46.
  Revert leaves the whole log uncached, about 25 tokens a line, so its
  uncached input is about 1k at decision 20 and 2k at decision 60, where
  forklog's stays near 760.
- Every decision spent one model response (accumulate 1.05). The marker
  check still holds: no cut strategy saw decision 5's marker at decision 6.

### What the cache does

- The backend caches the instructions at a checkpoint about one 128-token
  block before their end: 49 of 61 hits matched the block boundary at or
  before (end of the instructions + about 6) minus one block; the rest got
  an older checkpoint, one or two blocks further back. Decision n shares its
  prefix with decision n−1 up to the end of n−1's log, so the cache stops
  about a block short of that, and the cached count climbs a block at a
  time: 4,352, 4,480, 4,608, 4,736 over 20 decisions.
- **forktrail** tested putting the instructions' last sections (common
  mistakes, the app, the story; about 470 tokens) after the log, so the
  checkpoint would land past the shared prefix and the cache might match up
  to it block by block. It does not: every decision cached only the tools
  (2,176). The backend serves only whole checkpoints, so nothing may follow
  the log in the instructions, and no layout removes the one-block lag.
- Misses come in two kinds, nothing cached or only the tools. They hit 15%
  of forklog decisions here, and revert 1/19 and accumulate 2/19 in this
  spike, 1–4/19 for every strategy in phase 1. Forks already share one
  `prompt_cache_key`, and Codex offers no way to set it. Decisions 3 s apart
  (2/19), the priority tier (1/19) and one long-lived thread (revert, 1/19)
  were not clearly better with samples this small. Nothing client-side was
  found that reduces them.

### Where the time goes

Forklog, medium, HTTP, decisions 2–20 of runs 1–3, p50, from the trace's
timestamps:

| phase | ms | what it is |
|---|---|---|
| prepare | 286 | Codex, from `turn/start` until the request leaves. The first request of every turn waits about 280 ms in Codex's world-state build (revert too); not the plugins, bundled skills, shell snapshot or code-mode host, each tested |
| headers | 678 | the request until its response headers |
| first output | 1,927 | the response's start until the model's first output item: prefill and time to first token. Reasoning tokens were 0 on 54 of 57 decisions |
| write | 1,254 | the model writing the `act` program: 22 ms per output token, 58 tokens p50, 100–160 for long batches |
| exec | 2 | code mode running the program until the call reaches the harness |

- Low effort changes nothing (4,312 ms against 4,134–4,382): the model does
  not reason on these decisions at either effort.
- The priority tier (Codex's "Fast": "2x speed, increased usage") cut the
  first output to 1,308 ms and writing to 17 ms a token: 3,500 ms a decision,
  0.8 s (20%) faster.
- WebSocket is about 1 s slower per decision: every fork is a new thread,
  so a new socket and its warm-up.
- v1's 2.3–2.6 s were later responses inside one turn: no 280 ms prepare, a
  warm connection, perhaps a less loaded backend. This spike's accumulate run,
  the same shape, took 4.9 s per decision, with longer programs (94 tokens,
  2.1 s of writing) because it prints each result.
- What would bring it down: fewer output tokens (the `thought` is about 15
  of the 58 and is only logged: 0.3 s a decision; a terser action syntax
  would save more), the priority tier (it costs more usage; Jeremy's call),
  staying on HTTP. The headers wait and the first output, 2.6 s together,
  are the backend's.

### Startup

- **A private app-server spawned per run** (what the spike does): spawn to
  `initialize` 20–28 ms (1 s on the very first cold start), `thread/start`
  about 35 ms, and the run's first request usually opens a new HTTPS
  connection (headers 0.85–1.4 s against 0.65 s later). Up to about 0.7 s
  once per run.
- **A managed daemon for the private home** (`CODEX_HOME=~/.playtest-lite/codex
  codex app-server daemon start`) runs beside the default daemon without
  touching it: its socket, pid files and package all live in the private
  home, and the default daemon stayed up throughout. Connecting and
  `initialize` take 2 ms and `thread/start` 28 ms, but decisions are no
  faster (4,574 ms p50). It costs a 318 MB copy of Codex in the private home,
  a long-lived app-server and an auto-update loop that `daemon stop` leaves
  running, and updates that can change Codex's prompt layout under the
  harness unannounced (the default daemon already runs 0.162.0, the CLI
  0.160.0). Stopped and removed after measuring.
- So: spawn per run. A daemon saves under a second a run, against sessions
  of 20 or more decisions at 4–5 s each.

### Hazards found

- Forks send different tools from their source unless every `turn/start`
  sends `environments: []` (above).
- A fork's usage arrives only as its turn ends, and only if the response
  completed before the interrupt. With the call held 1 s, 1 of 171 forked
  decisions lost its usage: during an 8 s response, it completed more than a
  second after the call. Hold the reply until the batch has run, at least a
  second, and record a lost usage as unknown.
- Codex sometimes stalls before sending: prepare took 2.5 s and 6.4 s once
  each in about 170 decisions.
- The private home needs its own sign-in (`CODEX_HOME=~/.playtest-lite/codex
  codex login`); the harness must say so when it is missing.

### Recommendation

Build forklog over HTTP on the private home, with a private stdio
app-server spawned per run. It gives a flat 5.3k-token context whose
uncached part is the page, the newest log line and about one block (median
760 tokens) on 85% of decisions, at about 4.3 s a decision; the other 15%
are the backend's misses at full price. Offer the priority tier for speed
if Jeremy wants it, and cut the actor's output tokens in phase 3. The direct
Responses API stays the fallback, unmeasured.
