# Playtest Lite v1

The first working version of the CLI: boot an app from committed setup, record
a golden-path story with Sol, accept it, replay it as a smoke test with no
model, explore the app on autopilot for bugs and pain points, and rebuild
screenshots and video for any story at any commit. Built and battle-tested
against `fixtures/sample-app/`.

Read `docs/project.md` first; this document settles the parts of it v1 needs
and does not repeat the reasoning there.

## Jeremy's brief for v1, verbatim (2026-10-09)

> Create the first version of playtest-lite. Any questions, feel free to ask at
> any time. Make sure you understand the high level constraints. I need this to
> be fast, light, effective. It should be something that can easily bootstrap
> and run from a fresh git clone of a project app. Two valuable use cases i see
> for this tool,
>
> (a) define a golden path user story can be recorded, accepted, and replayed
> easily as a set of smoke tests
> (b) autopilot stress test the app and find pain points, bugs, that can then
> be used to hill climb the design and functionality of the app.

## Rulings (2026-10-09)

- **Process:** design here, then build in this session with Opus subagents.
  Milestone 1's spikes become the measurement step of the first build phases;
  their numbers go into `project.md` and the speed target into `roadmap.md`.
- **v1 scope:** `up`/`down`, `record`, `accept`, `check`, `explore`, and
  `render` both at the current checkout and at `<story>@<commit>`. Heal and
  triage, `fix`, `critique` and the pinned rendering image are later.
- **Pixels:** `check` fails on accessibility-tree drift, story checks and
  mechanical checks. Each step's baseline carries a small perceptual hash;
  it is compared only when the platform and Chrome version match the
  recording's, and visual drift alone is a warning.

## Constraints every phase holds to

- **Zero runtime dependencies.** Node 26 runs the TypeScript directly (type
  stripping), so only erasable syntax: no `enum`, `namespace`, parameter
  properties or decorators. `typescript` and `@types/node` are dev
  dependencies for `npm run typecheck` only. Imports are lazy: `playtest
  --help` must not load the browser or model code.
- **Raw CDP** over Node's built-in `WebSocket` to `chrome-headless-shell`, a
  pinned version downloaded on first use. Never the installed Google Chrome.
  Always `--use-mock-keychain`.
- **Model through Codex app-server** with client-defined (dynamic) tools,
  replacement base instructions and ephemeral threads. Default model
  `gpt-6.1-sol`. The model sits behind one interface; a scripted backend
  replays canned tool calls so every command is testable without Codex.
- **Nothing heavy is committed.** Stories, baselines and config are small
  text; run output goes to a gitignored folder that is pruned automatically.
- **CLI output is for agents first:** short, plain lines; `--json` on every
  command that reports. Exit codes: `0` pass, `1` test failure or drift,
  `2` environment or harness failure (never counted as a test failure).
- Comments are rare and short: one line of why where the reason is not
  obvious, never narrating what code does.

## What lives in an app's repository

```
<app>/playtest/
  config.json                    committed: how to set up, start and reset the app
  stories/<name>.md              committed: a story in prose
  stories/<name>.baseline.json   committed: the accepted recording
  .gitignore                     committed: ignores .runs/
  .runs/                         disposable: run output, state, worktrees
```

The harness finds the project by walking up from the working directory to the
first `playtest/config.json` (or `--project <dir>`). The app's git repository
is `git rev-parse --show-toplevel` run from there, and the app's path inside
it is recorded so a worktree at another commit maps to the same place. This
covers both the sample app (a subdirectory of this repository) and an app that
is its own repository.

### `config.json`

```json
{
  "app": {
    "dir": "..",
    "setup": [
      { "run": "npm ci", "inputs": ["package-lock.json"], "outputs": ["node_modules"] },
      { "run": "npm run seed", "inputs": ["server/seed.ts", "server/schema.ts"] },
      { "run": "npm run build", "inputs": ["src", "index.html", "vite.config.ts"] }
    ],
    "start": { "run": "npm start", "inputs": ["server"] },
    "env": { "TEST_MODE": "1", "TEST_NOW": "2026-04-01T12:00:00Z", "PORT": "{port}" },
    "port": 5310,
    "ready": "/api/bootstrap",
    "reset": { "post": "/__test/reset" }
  },
  "browser": { "viewport": [1280, 800], "widths": [420, 1280], "clock": "2026-04-01T12:00:00Z" },
  "model": { "name": "gpt-6.1-sol", "effort": "medium" }
}
```

- `setup` steps run in order in `app.dir`. A step is skipped when the hash of
  its `inputs` (file contents under those paths) and its command match the
  last successful run in that checkout. A step with `outputs` is cached by
  that key in `~/.cache/playtest-lite/outputs/<key>/`; on a hit the outputs
  are copy-on-write cloned (`cp -cR` on macOS, `cp --reflink=auto` on Linux)
  instead of running the command. This is what makes a worktree at an old
  commit come up in seconds: `node_modules` is cloned, only the build runs.
- `start` is a long-running command. `{port}` in env or the command is
  replaced by the port in use. The app is ready when `GET <ready>` answers
  below 500. It is restarted when its inputs hash, its env, or any setup step
  changed since it started.
- The port is `PLAYTEST_PORT`, else `app.port`, else the next free one;
  worktree apps start one above. The sample app's `DB_PATH` lives under
  `.runs/`, so every checkout and worktree has its own database.
- `reset` is either `{ "post": "<path>" }` or `{ "run": "<command>" }`. It runs
  before every story replay and every record or explore session.
- `--env K=V` on `up`, `check`, `record`, `explore` and `render` overrides
  env for that invocation (and restarts the app if it differs). This is how
  the battle test plants `BUGS=` and `VARIANT=` without committing.
- `browser.clock` freezes `Date` in the page (script injected before any page
  script). Animations and transitions are always disabled by an injected
  stylesheet, and the caret hidden.
- `init` writes this file from what it can detect (`package.json` scripts),
  plus `stories/`, `.gitignore`, and an example story, and prints what it
  could not guess.

### Stories

```md
---
start: /login
---
# Add a task to a project

Sign in as admin@example.test with password admin-pass-1. Open the project
"Website relaunch" and add a task called "Write launch email".

## Done when
- the task "Write launch email" is in the project's task list
```

Frontmatter is optional (`start`, default `/`; `viewport`). The prose is
handed to the model. The `Done when` bullets are what the model must turn into
deterministic checks before it may finish (below).

### Baselines

One JSON file per story, written with a fixed key order and one array element
per line where it helps diffs, so a pull request shows what changed in the UI.

```json
{
  "version": 1,
  "story": "add-task",
  "commit": "d26fa60…",
  "dirty": false,
  "platform": "darwin-arm64",
  "chrome": "151.0.7922.47",
  "harness": "0.1.0",
  "viewport": [1280, 800],
  "start": "/login",
  "steps": [
    {
      "action": { "type": "fill", "target": { "role": "textbox", "name": "Email" }, "value": "admin@example.test" },
      "url": "/login",
      "snapshot": ["heading \"Sign in\" level=1", "textbox \"Email\" value=\"admin@example.test\"", "…"],
      "fingerprint": "9f3a…",
      "settleMs": 41,
      "issues": []
    }
  ],
  "checks": [ { "type": "text", "value": "Write launch email" }, { "type": "url", "value": "/projects/prj-001" } ]
}
```

- `snapshot` is the normalized accessibility snapshot after the step: no
  element references, no focus, whitespace collapsed. It is the drift oracle.
  If the builder measures a 20-step baseline over about 100 KB, steps store
  only lines that differ from the previous step (and the format says so).
- `issues` are the mechanical issues present at record time. They are
  accepted with the baseline, so `check` reports only new ones (the sample
  app's `prj-031` returns 500 on purpose).
- `commit` is the app repository's HEAD at record time. `dirty` is true when
  the app directory had uncommitted changes; `accept` warns, since `render`
  at that commit will not reproduce it exactly.

## The browser layer

- **Install:** `PLAYTEST_CHROME` if set, else the pinned `chrome-headless-shell`
  version in `~/.cache/playtest-lite/chrome/<version>/`, downloaded from the
  Chrome for Testing JSON endpoints and unzipped with the system `unzip` on
  first use. One version is pinned in the harness so every machine renders
  with the same engine.
- **Warm processes:** `up` starts the app and the browser and leaves both
  running; state (pids, ports, the browser's WebSocket URL, input hashes, env)
  is in `.runs/state.json`. Every command reuses them when healthy and starts
  them when not. `down` stops both. The browser is the daemon; there is no
  daemon of our own.
- **Per story:** a fresh browser context (`Target.createBrowserContext`), one
  page, device metrics set to the viewport, the clock and no-animation scripts
  injected, and Page, Runtime, Network and Log events enabled.
- **Snapshot:** built from `Accessibility.getFullAXTree`, pruned to nodes that
  matter (named landmarks, headings with level, links, buttons, form fields
  with value and state, list items, text, dialogs, alerts and status). The
  model's form adds a short reference to each actionable node (`[e12]`); the
  normalized form drops references.
- **Actions:** `click`, `fill`, `select`, `press`, `hover`, `navigate`,
  `back`, `scroll`. Targets are a reference from the current snapshot or a
  durable locator `{ role, name, nth? }`; every executed action is stored with
  its durable locator, never a reference. Clicks scroll the element into view
  and hit-test its centre with `elementFromPoint`: if something else is on
  top, the click fails as covered and names the covering element. `fill`
  focuses, selects the existing text and inserts the new text so frameworks
  see real input events.
- **Settle:** after an action, wait until no request has been in flight for
  50 ms and two animation frames have passed, capped at 5 s (configurable).
  `settleMs` is recorded per step.
- **Telemetry and mechanical checks, every step, no model:** console errors
  and uncaught exceptions; requests that failed or returned 4xx/5xx; and, on
  each distinct URL path at each width in `browser.widths`, one injected
  script that reports horizontal page overflow, elements whose content
  overflows their box, interactive elements covered by another element, and
  broken images. Each issue has a stable key (kind, URL path, width, element
  description) so baselines can accept it and `check` can tell new from old.
- **Screenshot fingerprint:** a scaled-down capture (`Page.captureScreenshot`
  with a clip scale) decoded with `node:zlib`, reduced to a 64-bit difference
  hash plus a coarse grey grid, stored as hex. Compared by distance with a
  threshold the builder sets from measured noise.

## The model layer

One interface: start a thread with our instructions and tools, send a
message, receive tool calls, answer them, until the model ends its turn.

- **Codex app-server backend:** connects to the shared local app-server daemon
  (starting it if needed), starts an ephemeral thread with replacement base
  instructions and only our tools, and answers each tool call by running it.
  The phase that builds it measures the round trip and whether tool calls
  arrive while the model is still writing (milestone 1, spike 1).
- **Scripted backend:** `PLAYTEST_MODEL=script:<file>` replays a JSON list of
  tool calls. Tests and the battle test's harness checks use it.
- **Batched actions with predictions** (Jeremy's idea). The model's main tool
  is `act`: a list of one or more actions, each with an optional `expect`
  (`url` contains, `text` visible, element `{role, name}` present or absent,
  field value). The harness runs them in order and stops at the first action
  that fails or whose expectation is not met, and after any click on a button
  whose name looks irreversible (delete, remove, pay, confirm, submit, upgrade,
  sign out) unless that action carries an `expect`. It returns what ran, where
  and why it stopped, any mechanical issues, and the new snapshot, sent as the
  lines that changed when that is shorter than the whole.
- **Finishing a recording:** `done` takes a summary and `checks`, one or more
  deterministic checks (`text`, `url`, `element`, `absent`) that must cover
  the story's `Done when` bullets. The harness evaluates them immediately and
  rejects `done` if any fails. `give_up` ends the run with a reason.
- **Explorer tools:** `act` and `report_finding` (title, kind `bug | ux |
  a11y | perf | copy`, severity, what was expected, what happened, the steps
  it concerns, and checks that demonstrate it), and `done`.

## Commands

| Command | What it does |
|---|---|
| `playtest init` | Scaffold `playtest/` in the current app. |
| `playtest up [--env K=V]`, `down`, `status` | Bring the app and browser up from committed setup, stop them, show state. |
| `playtest record <story> [--accept]` | Reset, let the model play the story, then replay the result once with no model to prove it is deterministic. The run becomes a pending baseline; `--accept` accepts it. |
| `playtest accept <story>` | Promote the latest passing pending baseline into `stories/`. |
| `playtest check [story…]` | Replay each baseline with no model and report drift, failed checks, new mechanical issues, steps more than three times and 500 ms slower than baseline, and (same platform only) visual drift as a warning. |
| `playtest explore [--goal text] [--steps N] [--minutes N] [--seed N] [--fresh]` | Autopilot. Writes findings and pain points; see below. |
| `playtest adopt <finding>` | Copy an explore finding's draft story into `stories/`. |
| `playtest render <story>[@<commit>] [--before <commit>] [--video]` | Rebuild full screenshots (and a video when `ffmpeg` is on the path) by replaying the story's baseline at that commit; `--before` adds side-by-side before/after stills. |

`record` and `explore` need Codex; `check`, `render`, `up` never call a model.

### `check` in detail

For each story: reset, fresh context, open `start`, then each step: resolve
the locator (stop the story if it no longer resolves), run the action,
settle, compare. A story fails on a snapshot that differs (shown as a short
unified diff), a final check that fails, a new mechanical issue, or a perf
slowdown. Replay continues past a snapshot difference while targets still
resolve, so one run shows every drift. When slow steps are a story's only
failure, the story is replayed from a reset up to its last slow step, at most
twice; a step fails only if it is slow every time, and the report lists the
re-run timings and the steps they cleared. The summary names the first differing
step per story and prints the `render … --before` command that shows it.

Output goes to `.runs/<run-id>/` (report.md, report.json); run folders older
than the newest 20 are pruned at the start of every command.

### `explore` in detail

Explore is for use case (b): find what to fix and what to improve.

1. Reset, open the app, and start an explorer thread with a persona prompt:
   a capable but impatient user who tries the app's main tasks, then edge
   cases (empty and long input, invalid values, back and reload, narrow
   widths, error paths). `--goal` focuses it.
2. Mechanical issues are findings automatically, with no model.
3. Every finding the model reports is confirmed by replaying the session's
   recorded actions from a reset up to that step, with no model, and
   evaluating the finding's check. Findings that do not reproduce are listed
   apart as unconfirmed.
4. **Pain points** come from the trajectory: failed actions, unmet
   predictions, revisited pages, back-tracking and the model's own `ux` and
   `copy` notes, ranked by how much of the session they cost.
5. The run writes `findings.md` (for people and coding agents: each finding
   with evidence, the replay command and a draft story whose `Done when`
   states the correct behaviour) and `findings.json`. `adopt` turns a draft
   into a story, which will fail `check` until the bug is fixed and the story
   recorded.

### `render` in detail

- At the current checkout: replay the baseline with full-page screenshots
  per step into `.runs/<id>/render/`, a `video.mp4` from the stills when
  `ffmpeg` exists, and an `index.html` flip-book always. Print the paths.
- At `<commit>`: `git worktree add --detach` into `.runs/worktrees/<commit>/`
  (reused until pruned), run setup there (outputs cloned from cache), start
  that app on a free port, replay the story's baseline as it was at that
  commit, stop the app. Worktrees unused for a day are removed with
  `git worktree remove`.
- `--before <commit>` renders both sides and composes side-by-side stills
  by laying the two images out in an HTML page and screenshotting it with
  the same browser. `--before baseline` means the baseline's own `commit`
  (`parseArgs` options cannot have an optional value). When the paths
  diverge, the stills pair by step until one side ends and the rest are
  marked with where and why that side stopped.
- **What each side replays.** Both sides replay the *before* baseline's
  actions, so the after side is exactly what `check` replays and the pair
  answers "what did check see beside what was accepted". The before
  baseline is the one recorded at that commit (the current baseline when
  its `commit` is that commit: it is usually committed a commit later, so
  the file at the recorded commit is older or missing), else the file as
  committed at that commit, else the current one. `--env` applies to the
  after side only, as it does in `check`, and `check`'s hint carries its
  `--env` so the command it prints shows what it saw.
- Each side reports its drift from the replayed baseline: on the after side
  that is check's drift; on the before side any drift means the picture is
  not what was accepted (a dirty recording, or an app that does not boot
  the same way).
## How sample-app history is made for `render`

The sample app's bugs and variants are env switches. A change in committed
setup is a real change at that commit, so the battle test makes history by
committing a different `app.env` (for example `VARIANT=rename-cta`) or a real
code edit on a throwaway branch in its own worktree, then renders across it.
Nothing is committed to `main` for this.

## Found while building (wave 1, 2026-10-09)

- **Sol uses tools through code mode.** Its catalog sets `code_mode_only`:
  the model writes a short JavaScript program calling `tools.act(...)` etc.,
  which Codex runs 1–2 ms after the program is written. Calls inside one
  program run one at a time with no model round trip between them, so the
  batching idea comes almost free; a program can also branch on results. The
  model sees only what the program prints with `text(...)`, so tool
  descriptions and prompts must tell it to print results, snapshots first.
  Exposing tools directly instead cost one 2.5 s response per call.
- **Model cost:** about 2–2.5 s per model response at low or medium effort,
  plus about 1 s on a thread's first turn; one user message can drive a whole
  session (the turn ends when the model replies with text). Thread start on
  the shared daemon is 65–85 ms.
- **Codex injects `~/.codex/AGENTS.md`** as a user message and there is no
  switch to stop it, so recorder and explorer prompts tell the model to ignore
  instructions about coding work.
- **Replay speed:** a warm 20-step replay takes 1.6 s, 77% of it the 50 ms
  settle quiet window; 20 ms gave 1.0 s and stayed deterministic over six
  runs, 10 ms did not. 50 ms stays the default (`PLAYTEST_QUIET_MS`
  overrides) until the work app is measured.
- **A frozen `Date`** never lets `Date.now`-based debounces fire. Fine for the
  sample app; the work app may need a clock that ticks forward from the
  pinned instant.
- **Roles are Chrome's,** exactly as the snapshot shows them (`searchbox`,
  not `textbox`; "New project" in the sample app is a link).

## Found while building (phase 4, 2026-10-09)

- **The baseline comes from a replay, not from the recording.** Between
  model responses seconds pass, so timers fire that a replay at browser
  speed never waits for (the sample app's toasts vanish after 4 s). `record`
  therefore keeps only the model's successful actions (with durable
  locators) and its `done` checks, replays them once with no model to
  capture snapshots, fingerprints, settle times and issues, then replays the
  result as `check` does to prove it deterministic. Two replays cost about
  1.4 s beside 20 s of model time.
- **Baseline size:** spike 2's 20-step story makes a 48 KB baseline (945
  snapshot lines), so every step stores its full snapshot. Step keys are
  `action, url, settleMs, fingerprint, issues, snapshot`, snapshot last so
  each step's short facts sit together. `url` is path plus query string.
- **Issue timing shifts by a step** when a response lands after the next
  action, so `check` accepts an issue key seen at that step, either
  neighbour, or on opening `start`.
- **`act` with no actions** returns the full snapshot; there is no separate
  snapshot tool. `record --minutes N` sets the session cap (default 10).
- **The check summary's hint** is `playtest render <story> --before
  <baseline commit>`, since `--before` takes a value.
- **Sol batches across pages** once the prompt shows an example with
  locators for elements it has not seen yet; a wrong guess (it tried "Add
  task" for "New task") costs one response. Recording each sample story took
  5 to 6 responses and about 20 s.

## Found while building (phase 5, 2026-10-09)

- **One replay confirms every finding.** Each model finding's check is
  evaluated right after its step during a single replay of the whole session
  from a reset, which is what a separate replay to that step would see, since
  checks only read the page. Mechanical findings are confirmed when their
  issue key comes back anywhere in that replay. A whole 60-step session
  replays in a few seconds.
- **A finding's check is evaluated when it is reported** and the report is
  refused if it is false, as `done` is, unless the model cites only earlier
  steps (then it is checked by replay at the latest of them). Without the
  refusal the model could cite a step where an `absent` check holds trivially.
  Finding checks add `no-text` (the page does not show a text), the natural
  way to say "the item I just saved is not listed".
- **Narrow width is a `set_width` tool**, not a second session: one resize step
  in the session (and in its replay), so the model keeps its signed-in state.
  `resizePage` lives in the browser layer, off the `Page` interface.
- **The explorer learns accounts and main tasks from the project's stories**
  (titles and prose, capped at 1500 characters). The prompt is otherwise
  generic and never names the sample app's planted bugs.
- **Mechanical findings beyond `Actor.issues`:** a step that takes 2 s or more
  to settle is a perf finding (confirmed when slow again on replay), and a click
  that fails because another element covers its target is a bug finding,
  confirmed by its own replay that tries the click again (a click that works
  would change the page under the shared replay).
- **Mechanical findings are grouped:** one finding per issue whatever the width
  and whatever the record id in the path (URL segments with a digit count as
  ids), so `/projects/prj-001` and `/projects/prj-017` being slow is one
  finding. API requests answered 4xx are not findings (explore provokes them
  with invalid input on purpose); findings.md lists them as "also noticed".
- **The answer key's bugs mask each other** when all are on: with `save-500`
  a task is never created, so `stale-list` cannot show; with `clipped` the
  page is 996 px wide at 420, so "New project" sits outside the viewport and
  the layout check cannot see `overlap` cover it. The battle test should
  score explore per bug or in compatible groups as well as all at once.

## Found while building (phase 6, 2026-10-09)

- **Full-page stills.** The drift oracle covers the whole page, so the
  picture does too: a new task row lands below the fold. Sample-app pages
  are 800 to 950 px tall at 1280 wide, so a still reads like a screen. Video
  frames are padded onto one canvas, never scaled. Side effect: a fixed
  overlay (the dialog backdrop) covers only the first viewport height of a
  full-page capture. Tall work-app pages may need a height cap, which needs
  a `screenshot` option in `src/types.ts`.
- **Cost:** a warm single-side render of the 7-step add-task story takes
  0.7 to 0.8 s command to exit; before/after with both apps warm-ish 1.3 to
  1.8 s. A worktree app is stopped after each render (handoff rule), so the
  next one restarts it: 0.1 to 0.3 s. A cold worktree whose build output is
  cached comes up in about 0.6 s; one with a real code change runs the
  build there: 2.2 s.
- **Concurrent sides** (two apps, one browser, two contexts) are about 15 to
  25% faster than one after the other (median 2.3 s against 2.7 s over four
  runs each): the working-tree side's replay overlaps the worktree's setup.
  App starts still go one at a time so two new apps never pick the same
  free port.
- **Compose** is the largest share of a before/after render: 0.82 s for 8
  stills on one page, 0.5 to 0.6 s spread over four pages. Each still is
  the comparison page opened with `?still=N`; the same `compare/index.html`
  is the flip-book.

## Found while building (phase 7a, 2026-10-09)

- **Copied installs.** Node refuses to strip types under `node_modules`, so
  `npm i -D <path>` (a symlink) worked and a tarball or git install did not.
  The bin is now `bin/playtest.js`, which registers a load hook that strips
  our `.ts` files with `module.stripTypeScriptTypes` only when it runs from
  `node_modules`. `package.json` lists `files`, so a pack no longer carries
  `.claude/worktrees`, fixtures and tests.
- **CI runs `npm ci` before it can run us,** so setup's own `npm ci` repeated
  it. A step that has never run in a checkout is now taken as done when all
  its outputs exist and are newer than all its inputs (make's rule).
- **Setup progress** prints on stderr for every command, not only `up`; a
  first `check` was silent for the length of the install.
- **`init` reads the server's sources** (start and seed inputs) for the
  environment variables it reads, its default port and a test-only reset
  route, guesses `dist` or `.next` as build output, and prints the next
  steps. For the sample app only `TEST_MODE`, `TEST_NOW` and `browser.clock`
  were left to edit by hand.
- **Noise in check's report.** Drift that repeats unchanged on later steps
  (a new nav link) is shown once with its steps, and a new issue is reported
  once per story, at its first step.
- **Full-page stills** stretch the viewport to the page's height for the
  capture, so a dialog's backdrop covers the whole page.
- **Speed:** settle is 63% of a warm 20-step check; the fingerprint is next
  at 8%. Numbers and target in `roadmap.md`.
- **Slow steps flake under disk load, not CPU load.** 32 busy processes on 12
  cores moved settle times by at most 64 ms; adding two loops writing 1 GB
  and syncing made 5 of 5 clean checks fail (19 of 35 stories, steps up to
  2.3 s against 50 to 70 ms baselines, mostly the sign-in and save writes).
  With up to two re-runs the same load gave 5 of 5 clean passes; 3 of the 18
  cleared steps were slow on the first re-run too, so one re-run was not
  enough. The 500 ms floor stays: half the load spikes exceeded 1 s, so a
  higher floor would cost sensitivity without removing the flake. A real
  regression costs two extra partial replays (`BUGS=slow`: 3 s per slow step
  each time).

## Found while building (phase 7b, 2026-10-09)

Explore scored against the answer key, defaults (60 actions, 8 minutes,
Sol at medium), one run per row. Before is the v1 tip (9759a89), after is
this phase. **False**: the claim is untrue or calls correct behaviour a bug.
**Debatable**: real and reproducible, not planted, and a product owner could
call it intended (filters lost on "← All projects", duplicate project keys
accepted, the Feedback placeholder doing nothing, `prj-031`'s seeded error
state). **Dup**: a confirmed finding restating another one's defect.

| `BUGS=` | Before: time, responses, steps | confirmed | planted | false | debatable | dup | After: time, responses, steps | confirmed (weak) | planted | false | debatable | dup |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all seven | 175 s, 27, 58 | 12 | 5/7 | 0 | 1 | 5 | 174 s, 27, 59 | 8 (1) | 5/7 | 0 | 2 | 0 |
| overlap, console-error, slow | 189 s, 26, 58 | 9 | 3/3 | 0 | 3 | 3 | 198 s, 27, 57 | 6 (1) | 3/3 | 0 | 2 | 1 |
| clipped, stale-list, dead-link | 118 s, 26, 57 | 6 | 3/3 | 0 | 0 | 3 | 126 s, 24, 59 | 4 | 3/3 | 0 | 1 | 0 |
| save-500 | 119 s, 26, 57 | 4 | 1/1 | 0 | 0 | 2 | 127 s, 25, 58 | 3 | 1/1 | 0 | 1 | 0 |
| none | 116 s, 26, 58 | 1 | | 0 | 1 | 0 | 118 s, 24, 58 | 0 | | 0 | 0 | 0 |
| none, the next run | 115 s, 27, 58 | 0 | | 0 | 0 | 0 | 105 s, 20, 58 | 0 | | 0 | 0 | 0 |

- **Groups.** `clipped` makes `/projects` 996 px wide at 420, so "New
  project" is off screen; `save-500` means no task is created for
  `stale-list` to hide; and `dead-link`'s extra nav link moves "New
  project" out from under Feedback, so `overlap` never happens (a first
  group with `overlap` and `dead-link` found 3 of 4). So `overlap` runs
  without `clipped` and `dead-link`, `stale-list` without `save-500`. All
  seven at once: `overlap` and `stale-list` cannot be found, by anyone.
- **One defect, one finding.** A model finding takes in the harness
  findings it explains: a 5xx on the same page within a step of a step it
  cites (its bug), a slow step likewise (its perf finding), or a layout
  issue about an element its text names. Harness layout findings about the
  same element on the same page merge too. The merged finding keeps the
  model's checks and story, gains the issues, and is confirmed if either
  side reproduces. Duplicates fell from 13 to 1 over the comparable runs;
  rebuilding the before sessions with the new findings code (no model)
  removes the same ones, so the drop is the merge, not the model. The one
  left: `/projects/does-not-exist` slow beside `/projects/:id` slow (same
  endpoint; the path has no digit, so it is not taken for an id).
- **Weak evidence.** Each check is evaluated on replay also just before the
  latest step the finding cites; when every check already held there, the
  finding is confirmed but marked weak, ranked last and labelled in the
  table. Refusing them would also drop real "did not take effect" bugs (a
  saved task missing from the list is missing before saving too), so
  `report_finding` now takes several `checks` and the prompt asks to pair a
  "not there" check with one that shows the step took effect. A check that
  no longer holds because a toast timed out is accepted when the snapshot
  the last act showed held it, and replayed right after that step. Result:
  "Feedback button does nothing" is weak in every run that reports it
  (before and after); `stale-list` is now reported with `text "Task
  created"` beside `no-text`, strong, where before its lone `no-text` would
  be weak. Reporting again under the same title replaces the report.
- **Variety.** `--seed N` picks one of four plans (main tasks first, beyond
  the stories, phone first, errors first); the default seed is the number
  of earlier explore runs in `.runs/` with the same `--env` and goal, so
  consecutive runs rotate, and `--seed` repeats one. The model is also told
  what the last three such runs reported and which pages they spent steps
  on; `--fresh` ignores them. On this 11-page app every session already
  reaches every page, so the gain is small: the second of two clean runs
  shared 34 of its 42 distinct actions with the first (before: 36 of 41)
  and took another account and project; seeds 2 and 3 found only
  `prj-031`'s seeded error state. Distinct confirmed findings over two clean
  runs: 1 before (debatable), 0 after.
- **Remaining.** Debatable findings (filters lost on "← All projects")
  still confirm with strong checks; only judgment can sort them. Slow pages
  with ids that have no digit are not grouped. The narrow-width layout
  check skips controls scrolled off to the side, which `clipped` exploits.

## Rejected

- **Playwright or puppeteer:** heavy, and the brief rules them out.
- **A daemon of our own:** the warm app and warm browser are already the
  daemons; Node starts in about 30 ms.
- **YAML stories and config:** needs a parser dependency; Markdown with a
  tiny frontmatter reader and JSON cover it.
- **Storing screenshots in baselines:** contradicts the core idea; the
  fingerprint and the snapshot are enough to detect drift, and `render`
  rebuilds the pictures.
- **Heal in v1:** an intended change means `record` again until heal lands.

## Verification: the answer key

The battle test (last phase) writes golden-path stories for the sample app
that between them pass through every planted bug, then measures:

- **Regression:** `check` with each `BUGS=` switch flags it; three clean runs
  in a row flag nothing.
- **Intended changes:** each `VARIANT=` shows up as drift in the stories it
  touches (sorting it as intended is heal and triage, later).
- **Bug finding:** `explore` with all bugs on, how many of the seven it finds
  unprompted and how many false findings.
- **Speed:** a 20-step replay with app and browser warm, command to result,
  broken down by phase; the measured number becomes the target in the
  roadmap.
- **Bootstrap:** from a fresh clone of this repository, `playtest check` in
  `fixtures/sample-app` brings everything up and passes with no other step
  than installing the tool.
- **render@commit:** before/after stills across a committed change.
