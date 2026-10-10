# Playtest Lite v1: build plan

Builds `design.md`. The seams are the types in `src/types.ts` (the contract
every phase builds against; a phase that needs it changed says so in its
report rather than editing it) and the command dispatch in `src/cli.ts`
(each command is `src/commands/<name>.ts` exporting `run(args): Promise<number>`).

Already done (phase 0): `package.json` (bin `playtest` → `bin/playtest.ts`,
zero runtime deps), `tsconfig.json`, `src/cli.ts`, `src/types.ts`, and
`DB_PATH` support in the sample app so several instances can run at once.

Gates for every phase: `npm run typecheck` clean, `npm test` green, and the
phase's own live probe against the sample app. Sample-app instances started
by a phase use that phase's own port range and `DB_PATH` so phases running
side by side never share a server or database. Never touch `package.json`,
`src/types.ts` or `src/cli.ts` in a parallel phase.

## Wave 1, in parallel

### Phase 1: browser layer. **Done** (2c83836). Warm 20-step replay 1.6 s (settle is 77%; a 20 ms quiet window gives 1.0 s and stayed deterministic, 10 ms did not).

Owns `src/browser/`, `tests/browser*.test.ts`, `tools/spike-replay.ts`.
Ports 5320–5329.

- Chrome install (pinned `chrome-headless-shell`, Chrome for Testing
  download, `~/.cache/playtest-lite/chrome/`), `launchBrowser():
  Promise<BrowserProcess>` (detached, survives our process),
  `connectBrowser(wsUrl): Promise<Browser>`, CDP client, and `Page` exactly
  as in `src/types.ts`: snapshot, actions with hit-tested clicks, settle,
  telemetry, layout checks per new path and width, checks, fingerprint,
  screenshots.
- Spike 2: `tools/spike-replay.ts`, a hand-written 20-step sample-app story
  replayed through this layer, timed by phase (app reset, browser start,
  context creation, per-step action, settle, snapshot, layout checks,
  fingerprint). Run it five times warm; record the numbers in the report.
- Probe: with `BUGS=overlap` at 420 wide, clicking "New project" fails as
  covered by "Feedback"; `BUGS=clipped` reports content overflow on
  `/projects`; `BUGS=console-error` reports the console error; snapshots are
  identical across two runs of the same steps; fingerprints identical across
  two runs.

### Phase 2: project, environment and app lifecycle. **Done** (fd19513).

Owns `src/project.ts`, `src/env/`, `src/commands/{init,up,down,status}.ts`,
`tests/env*.test.ts`, `tests/project*.test.ts`,
`fixtures/sample-app/playtest/config.json` and `.gitignore`. Ports 5330–5339.

- `findProject`, config load with validation that names the file and key,
  story parsing (frontmatter, title, prose, `Done when`), `listStories`.
- Setup steps with input hashing, the copy-on-write output cache, the app
  process (`ensureApp(project, { env, checkoutDir?, port? }):
  Promise<AppHandle>`, restart on changed inputs or env, ready probe,
  reset), `stopApp`, the state file (`.runs/state.json`, with a free-form
  `browser` entry the run layer fills), run directories and pruning,
  `gitHead`, and `ensureWorktree(project, commit)` returning the app
  directory inside a worktree at that commit, with day-old worktrees
  removed via `git worktree remove`.
- `init`, `up` (app only for now; phase 4 adds the browser), `down`,
  `status`.
- Probe: from a fresh `git clone` of this repository into a temp dir,
  `playtest up` in `fixtures/sample-app` runs setup and serves the app; a
  second `up` is a no-op in under 300 ms; editing `src/` re-runs only the
  build; a worktree at `HEAD~1` comes up with `node_modules` cloned, and the
  time is reported.

### Phase 3: model layer. **Done** (51dd2b9). Shared daemon over its Unix socket; thread start 70 ms; about 2–2.5 s per model response.

Owns `src/model/`, `tests/model*.test.ts`, `tools/spike-codex.ts`.

- `openModel(config): Model` choosing the Codex app-server backend or the
  scripted backend (`PLAYTEST_MODEL=script:<file>`).
- Codex backend over the app-server protocol (generate the TypeScript
  bindings with `codex app-server generate-ts` for reference; do not
  vendor them): shared daemon, ephemeral thread, replacement base
  instructions, dynamic tools, model and effort from config.
- Spike 1: `tools/spike-codex.ts` measures thread start, first tool call
  latency, a five-call round trip, and whether tool-call notifications
  arrive before the model's turn finishes. Record the numbers in the report.
- Probe: a real Sol thread calls a dummy tool three times and the outputs
  reach it; the scripted backend drives the same handler identically.

## Wave 2

### Phase 4: record, accept, check. **Done** (596cfb2). Recording with Sol about 22 s per story; warm check 0.75–0.9 s per story, command to exit.

Owns `src/run/{session,actor,baseline,replay,report}.ts`,
`src/commands/{record,accept,check}.ts`, browser wiring into `up`/`down`/
`status`, `fixtures/sample-app/playtest/stories/`, tests.

- The browser entry in state; reuse or launch on every command.
- The `act` / `done` / `give_up` tools with batching, expectations and the
  irreversible-click stop; snapshot deltas; the recorder prompt.
- Record → determinism replay → pending baseline in `.runs/`; `accept`;
  baseline writer with stable key order and diff-friendly lines.
- `check` exactly as the design says, with report.md, report.json, the
  terminal summary and exit codes.
- Two sample-app stories recorded with real Sol (sign in and add a task;
  browse projects and open one) and accepted.
- Probe: `check` clean three times; `BUGS=stale-list` and `BUGS=save-500`
  each fail the add-task story with a readable report; `VARIANT=rename-cta`
  shows as drift.

## Wave 3, in parallel

### Phase 5: explore and adopt. **Done** (6d300b4). All bugs on: 5 of 7 found unprompted in about 2.7 min; the other two are masked by save-500 and clipped and are found when run apart.

Owns `src/run/explore.ts`, `src/run/findings.ts`,
`src/commands/{explore,adopt}.ts`, tests.

### Phase 6: render. **Done** (971fc43). 0.8 s at the working tree; before/after across a commit 1.4–2.3 s once its worktree exists.

Owns `src/run/render.ts`, `src/commands/render.ts`, tests. Needs a
throwaway branch in its own worktree with a committed change to render
across; never commits to `main` for this.

## Wave 4

### Phase 7: battle test. **Done.** 7a (607abbf, slow-step re-runs 707e557) and 7b (1a1f434). Scores in `project.md`, speed in `roadmap.md`.

Owns new stories, fixes anywhere, and the results: the speed numbers and
target in `roadmap.md`, spike results and the answer-key scores in
`project.md`, and `README.md` for the tool. Runs every measure in the
design's "Verification" section and fixes what fails.
