# Playtest Lite

`pt` tests an already-running web app through a real browser. Give it a URL,
including localhost. A model records written stories or explores for bugs;
subsequent checks replay the actions with no model.

## Install

Requires Node 26+ on macOS or Linux:

```sh
git clone https://github.com/JeremyVun/playtest-light.git
cd playtest-light
npm link
pt --help
```

Or install into a project with `npm i -D github:JeremyVun/playtest-light`
and use `npx pt`. Recording and exploration require the Codex CLI. Sign in once
to pt's private Codex home:

```sh
CODEX_HOME="$HOME/.playtest-lite/codex" codex login
```

This keeps Playtest's model sessions separate from your coding sessions.
Replaying a saved baseline does not call a model. A pinned `chrome-headless-shell`
is downloaded on first use; `pt` never uses your installed Chrome. The browser
starts and stops automatically for each command. Video requires `ffmpeg`.

## Start with a URL

```sh
pt explore http://localhost:3000
pt explore https://staging.example.com --goal "Try creating and editing a project"
```

No config, application source, Git checkout or initialization is required.
The URL's path, query and fragment are the initial exploration location.
Run reports go into `playtest/.runs/` in the current directory, or the nearest
existing Playtest data directory. These outputs are disposable; the newest
20 runs are kept. Add `playtest/.runs/` to your ignore rules when using Git;
`pt init` writes that rule for you.

## Stories and regression checks

Write `playtest/stories/checkout.md`, then:

```sh
pt run checkout --url http://localhost:3000 --accept
pt run --url http://localhost:3000
pt run checkout --url http://localhost:3000 --view
```

A story is plain Markdown, with optional front matter:

```md
---
start: /login
---
# Add a task

Sign in with the test account. Open Northern Onboarding and add a task
called "Write launch email".

## Done when
- the task "Write launch email" appears in the project's task list
```

`start` defaults to `/`; `viewport: [420, 800]` can override the browser size.
Completion criteria describe the final page. `run` plays stories with no baseline
and verifies them with two no-model replays before offering a baseline.
`--accept` saves that baseline beside the story. Without it, inspect the HTML
report, then use `pt accept checkout`.

For stories with baselines, `run` replays without a model and reports page drift,
failed criteria, new mechanical issues and slow steps. It never replaces a
failing baseline automatically. To record an intended change, use
`pt run checkout --record`, review it, then accept it. `--record --accept`
explicitly records and saves a replacement in one invocation.

Explicit Markdown paths also work:

```sh
pt run ./cases/checkout.md --url http://localhost:3000 --accept
pt run ./cases/checkout.md --url http://localhost:3000
```

Their baselines stay beside those files. Names without a path resolve under
`playtest/stories/`. With no story arguments, `run` uses that directory.

## Optional seed command

Test fixtures and seed scripts belong with the Playtest data. The app can be
started however you normally start it; `pt` does not build it, launch it,
start containers or provision databases.

```sh
pt run --url http://localhost:3000 --seed "node playtest/seed.js"
```

The command must restore the starting data and exit successfully. It runs
locally before every story and confirmation replay, including slow-step retries.
It receives `PLAYTEST_URL` and inherits your shell's environment. This supports
SQL, a test reset endpoint, or any other local setup without a database adapter.
The timeout is 60 seconds; a failure stops the run with exit code 2. Its output
is captured so it cannot corrupt JSON stdout. Use environment variables for
connection credentials rather than embedding them in command strings.

Without a seed, `pt` uses the existing data. Recording and finding confirmation
still replay normally, but reports identify that the data was not reset.
Changes left by earlier actions can prevent a replay from reproducing.

## Optional defaults

Keep repeated options in the existing `playtest/config.json`:

```json
{
  "url": "http://localhost:3000",
  "seed": "node playtest/seed.js"
}
```

Or generate it with:

```sh
pt init --url http://localhost:3000 --seed "node playtest/seed.js"
```

Then `pt run` is enough. Flags override config:

```sh
pt run --seed "node playtest/seed-empty.js"
pt run --url https://staging.example.com --no-seed
```

A saved seed is tied to its saved URL. Changing the URL disables the saved seed;
a seed explicitly passed with `--seed` runs against the chosen target.
`--no-seed` disables seeding, and cannot be combined with `--seed`.
Configured seed commands run from the directory containing `playtest/`.
Commands passed as flags run from your invocation directory.

`--project <dir>` selects a test-data project. Browser defaults can optionally
be overridden with `browser.viewport`, `browser.widths`, `browser.clock` and
`browser.settleCapMs`; model defaults with `model.name` and `model.effort`.
Default browser settings are 1280×800, layout checks at 420 and 1280 pixels,
and a 5000 ms settle cap. The default actor is `gpt-6.1-sol`.
There are no named environments or separate environment files.

Long recordings and explorations keep a bounded working context: the original
task, unfinished work, useful facts, recent outcomes and the current page.
Older evidence stays on disk and the actor can retrieve it. Recent events append
to a stable prefix until its space fills, so ordinary decisions can reuse the
model's prompt cache. Cache hits still depend on the backend.

For debugging, each recording or exploration saves `context-header.json`
(fixed instructions and tools), `context.jsonl` (the exact context for each
decision), and `trajectory.jsonl` (full events and observations). The run JSON
includes token usage, cached tokens, unknown usage and checkpoint counts.
These files belong to disposable run output; replay does not need them.

## Long-running responses

The actor can pause for an observable UI condition, such as Send becoming enabled
after a chatbot response finishes. The harness waits asynchronously: other work
can continue, and no model calls run while waiting. The actor can also do other
work in the app before choosing to wait.

There is no overall time limit to configure. Press Ctrl+C to stop a run, including
while the actor is waiting; pt closes its browser and removes its temporary profile.

The internal `wait_for` tool accepts up to eight conditions and `timeoutSeconds`
(default 60; up to 24 hours). The actor chooses how long to wait; a twenty-minute
wait needs no extra CLI flag. Conditions can check text, elements,
field values and enabled/disabled controls. The condition must hold on two
observations at least 250 ms apart. Prefer a completion signal over the first
streamed text or a spinner disappearing alone.

Timeout returns the current page to the actor without resubmitting. Navigation
or closing the page cancels the wait. Successful waits are saved in the baseline
and replayed as conditions, so replay adapts to response speed. Recording still
performs two verification replays, which can each wait for the app again.
Wait duration appears in the step filmstrip and is reported separately from
model time and network settling. There are no extra CLI commands or monitors.

## Commands

| Command | Purpose |
|---|---|
| `pt init --url <url>` | Save minimal defaults and an example story. |
| `pt run [story...]` | Replay baselines, or record stories that have none. |
| `pt accept <story>` | Save a verified pending baseline. |
| `pt explore [url] [--goal text]` | Discover problems and save all findings. |
| `pt view [path]` | Open a saved local HTML report; defaults to the latest. |

Use `pt run --help` or `pt help run` for the options accepted by that command.
Top-level `pt help` lists only commands. Options belong after the command;
unsupported options are errors. For example, `pt accept` saves a recording
already on disk, so it takes no URL, seed, recording or capture options.

`pt run --help` explains recording, baseline saving and screenshots.
`pt explore --help` explains goals and action/time limits. Exploration varies
its plan and considers previous findings automatically. No command prompts
for input. `--json` provides machine-readable output; `pt view --json` returns
the report path without opening a browser.

## Findings

Every exploration saves **all** findings, including those that did not reproduce,
in `playtest/findings/<run-id>/findings.json` and `findings.md`. These are small
text files and are not pruned with disposable run output. Keep, commit or hand
them to your own issue workflow as needed. pt has no issue acceptance or
resolution state, and no `adopt` command.

Each finding includes expected and observed behaviour, reproduction steps,
evidence, whether it reproduced, any weak evidence, and a draft story. A
reproduced condition is not proof that the model understood your product intent.
Existing stories and `--goal` give exploration context; findings without that
context can be suggestions. Copy a draft into `stories/` when you want a
regression test. Findings are not automatically added to your regression suite.

## Local run view

Every run and exploration writes `index.html` alongside its JSON/Markdown report.
Open it with `pt view`, or run with `--view` to open it on completion. It works
as a local file, with no server, frontend build or external dependencies.

Normal runs open on Results: each story's outcome, duration and checks, with
failures first. Select a failed story to inspect the failing step, or a passed
story to see its final checks. Steps shows screenshots, actions, URLs, checks,
issues and a brief baseline difference. Inspect step data opens the raw action,
accessibility snapshot and text diff in Debug.

Recordings and explorations include screenshots from the original execution
and separately labelled verification replays, including failed actions.
Findings shows expected/observed behaviour beside reproduction screenshots,
with links to the matching steps and draft stories. Results, Steps, Findings
and Debug appear only where relevant. There are no expandables or accordions.

Fit image shows the whole capture; Fit width and Actual size let you read tall
pages without shrinking their text. Phone views start at Fit width.

The filmstrip shows each browser action's duration (ms or seconds), including
settling but excluding model thinking and evidence capture. Exact milliseconds
and the separate settling measurement are in the tooltip and step detail.
A dash means no action duration was recorded. Each text box has a small copy
icon for pasting its exact report, snapshot, diff or draft story into an agent
session.

The token bar shows peak context, total input/output tokens and the cached input
share. Context means the full input to one model decision, including instructions
and tools; it is not the model's maximum capacity. Metrics appear once in the run
summary. Batches count once in the totals. Exact decision usage remains in
`evidence.json`. A `+` marks partial totals; a dash means usage is unavailable.
Baseline replays use no model.

Tab moves between controls, Left/Right moves between steps, and Home/End goes
to the first/last step. Tabs and filmstrip items expose their selection and
labels to assistive technology. Screenshots can also be opened at full size.

Normal baseline replays keep text evidence and capture failure screenshots.
Steps without screenshots show a compact card with the action and checks;
raw page text remains available in Debug. Phases without images use compact
filmstrip cards.
`pt run checkout --view` captures every step. `--video` also captures every step
and makes an MP4 from those same screenshots; it does not replay the app again.
Screenshots unavailable for a step are identified in the viewer. `pt view --json`
returns the HTML path without opening a browser.

## Agent output and evidence

`--json` writes structured results to stdout, including input and infrastructure
errors. Progress messages never mix into JSON stdout. `--json` does not open
a browser, even with `--view`; screenshots and the HTML report are still
created and their paths are returned. For example:

```sh
pt run checkout --url http://localhost:3000 --view --json
```

Exit codes are 0 for success, 1 for a failed story, and 2 for invalid
input or infrastructure failure. Exploration reports
findings without making their existence a command failure.

Commit stories, seed scripts and baselines. Baselines contain target URL,
whether data was seeded, browser/platform metadata, actions, normalized page
snapshots, small screenshot fingerprints and completion checks. Fingerprint
changes are warnings and are compared only on matching platforms and Chrome.
Screenshots, videos and run reports stay in disposable local output. Findings
are saved separately and survive pruning.

A target URL does not identify a deployed code version. Screenshots capture
what is served during this run. Reproducing old pictures requires supplying
the matching app version and data yourself.

## Try the sample app

In one terminal:

```sh
cd fixtures/sample-app
npm install
npm run seed
npm run build
TEST_MODE=1 TEST_NOW=2026-04-01T12:00:00Z npm start
```

In another, from `fixtures/sample-app`:

```sh
pt run
pt explore
pt run add-task --view
```

The sample config supplies its URL, seed command and frozen browser clock.
To plant bugs, restart the server with `BUGS=stale-list` (see the sample
[README](fixtures/sample-app/README.md)); these are app environment variables,
not `pt` options.

## Development

```sh
npm install
npm run typecheck
npm test
```

`tools/measure-check.ts` measures command-to-exit replay time against a server
you start separately. `tools/capture-view.ts` captures a local HTML view for
visual debugging. `PLAYTEST_QUIET_MS` adjusts the network quiet window
(default 50 ms); `PLAYTEST_CHROME` chooses an explicit Chrome binary;
`PLAYTEST_FFMPEG` chooses ffmpeg. The scripted model and model transport
settings used by development tools remain supported.
