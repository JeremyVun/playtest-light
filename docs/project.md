# Playtest Lite

A small CLI that lets AI agents find, fix and guard against UI problems in an app
that is itself being built by agents. It is the light successor to
[`../playtest`](../../playtest): same core loop, none of the platform.

## Why it exists

**Current direction (2026-10-10):** `pt` tests an already-running URL, including
localhost. App lifecycle commands and required setup config are removed;
the existing config holds optional URL/seed defaults, overridden by flags.
Seeds belong to the Playtest data. Design, owner brief and build status:
`backlog/url-targets/`. This supersedes v1's managed-app and historical-render
assumptions below; the recorded v1 results remain historical measurements.

Jeremy's team builds an app agentically. Many changes land every day, there are
no designers and little product input, so regression testing, bug finding and
design improvement all have to be automated, and it falls to the engineer to
work out how.

Playtest proved the core loop: an agent plays a written user story, its run is
recorded, later runs replay the recording without a model, and the model only
wakes when the app no longer matches. It also found its limits: it grew into a
hosted platform that is heavy to host and run, and every run produces a bundle
(screenshots, video, accessibility snapshots, network logs) that cannot be
committed or shared, so a team cannot work from the same evidence.

## North stars

In priority order:

1. **Speed.** Replays run at browser speed; a model is called only when
   something differs.
2. **Real value for hill climbing and issue finding.** Every feature must help
   find a real bug, fix one, or make the UI measurably better. Nothing exists
   just to report or trend.
3. **Multiplayer and scale.** Many people and many agents, on many machines and
   in CI, share the same stories and baselines without sharing a server or a
   store.

## The core idea: artifacts are derived, not stored

Stories, baselines and seed fixtures are small text files kept with the test
project. Screenshots and videos are generated against a supplied URL and stay
in disposable local output. Reproducing a historical picture requires the
matching app version and data to be made available externally; a local test
repository commit does not identify a remote deployment.

## Decided

Current cleanup brief, verbatim:

> in the interest of keeping this tool light, i need a code review. look for code duplication, dead code, performance issues, unecessary complications and simplification opportunities.

> fix them all. keep going until you don't find anymore

Work plan: separate wait polling from report assertions; remove the obsolete model
execution/daemon path; share post-action observations; index locators once; bound
diff memory; paginate history without rescanning prior pages. Preserve cache-aware
decisions, deterministic replay and Ctrl+C cleanup. Verify the fixes with browser
and model tests, repeat the performance probes, then review for further concrete
defects and simplifications. No new CLI options or runtime dependencies.

Cleanup results (2026-10-10): the CLI now has one Codex execution path, using
isolated app-server decisions; the unused shared-daemon transport, unbounded
thread API and obsolete `spike-codex.ts` benchmark are removed. References to that
benchmark in the v1 build plan describe historical work; `tools/spike-context.ts`
remains the cache comparison probe. Wait predicates are read-only; only explicit
assertions are added to the report. Post-action evidence is reused by the actor
and replay, and the actor remembers the same fresh snapshot sent to each decision.

Local synthetic measurements: indexing 10,000 controls fell from about 713 ms to
2.1 ms; a 10,000-line replacement no longer allocates a 400 MB diff matrix
(the exact matrix is capped at 4 MB, with a coarse valid diff above that size).
A 5 KB history page from 10,000 events now opens the file once and takes about
0.2–0.7 ms, versus 10,000 opens and about 131 ms. These are local probe timings,
not performance guarantees. Unicode pagination, frozen memory versions, wait
cancellation and assertion placement have regression coverage. Typechecking now
also rejects unused imports and locals.

Verification: 125 standard tests passed (the live test is opt-in), strict
TypeScript checks passed, and the separate real Sol decision test passed. A
20-second slow-chat fixture completed recording plus two deterministic replays
with exactly three submissions and three actor decisions; its 50 ms heartbeat
had a maximum gap of 56 ms. The generated evidence contained no failed polling
assertions. Final review also fixed stale actor observations, an empty `script:`
selector falling through to Codex, and app-server pipe/exit error handling.

- **URL targets.** Localhost and deployed apps are the same input. pt does not
  build apps, manage processes, start containers or provision databases.
- **Small CLI.** init, run, explore, accept and view. run records missing
  baselines and replays existing ones. --record requests a replacement. No
  up/down/status or environment registry. The executable is `pt`. Root help
  lists commands only; pt help <command> lists exactly that command’s options
  and examples. Exploration plan selection and prior findings are automatic,
  with no random-seed/fresh CLI flags. JSON mode never opens desktop apps;
  --view still captures every step and returns the report path.
- **Optional configuration.** One playtest/config.json supplies URL and optional
  seed command defaults. Flags override them; config and Git are not required.
- **Seeds are test data.** Scripts and fixtures live alongside stories. A seed
  command restores starting state before each story and replay. Without it,
  reports describe existing data rather than claiming it was reset.
- **Browser and model.** Raw CDP to pinned chrome-headless-shell; automatic
  browser startup/cleanup per command. Sol through Codex app-server, with a
  scripted backend for tests. Record/explore now use bounded working memory,
  retrievable run evidence and append-only context between checkpoint replacements
  to preserve cache reuse. A private Codex home keeps actor sessions separate.
  See `backlog/actor-context/` for implementation and measured checks. The broad
  comparative endurance/cache/cost gates remain open.
- **Long responses.** The actor can await a UI condition while the harness event
  loop stays responsive. No model call stays open during the wait; timeouts return
  control without resubmitting. Conditions and maximum waits replay with the
  baseline. There is no overall time limit or `--minutes` flag; Ctrl+C stops the
  run and cleans up its browser. See `backlog/async-waits/`.
- **Actor-owned completion.** The independent grader is deferred by the owner:
  its predecessor was finicky to tune. The actor uses observed UI outcomes to
  decide completion; deterministic checks and replay remain. Reconsider a grader
  only if measured false completions justify the extra complexity.
- **Baselines.** One stable text baseline beside each story. Version 2 records
  target URL and seeded status, not inferred app commits. Accessibility drift
  remains the oracle; matching-platform screenshot fingerprints warn only.
- **CLI only.** No hosted platform, server, database or viewer service. Run
  output remains disposable and is pruned automatically.
- **Local run evidence.** Static HTML with step screenshots, actions, checks,
  issues, snapshots, text diffs and findings. Original execution and verification
  are separate phases. --view captures every replay step and opens the report;
  pt view opens existing output. --video uses the same captured frames.
  Normal runs open on story Results, with failures first and direct navigation
  to the failed step or final checks. Steps, Findings and Debug are separate
  views; raw snapshots live in Debug. The keyboard-accessible filmstrip shows
  full browser-action duration, with settling separately identified. Text boxes
  have small copy icons. No expandables or accordions.
- **Findings are automatic.** Every exploration writes all findings to
  playtest/findings/<run-id>/ as Markdown and JSON, outside disposable .runs.
  Reproduced means observed again, not approved product intent. No issue state
  or adopt command. Draft stories are included but not enrolled automatically.
  accept only saves verified regression baselines.

Run/view design and Jeremy's brief: `backlog/run-view/`.

- **Battle-test the sample app first.** Adapt to the work app after the core
  loop proves useful. Work-app auth and secret handling remain future work.

## Run/view verification (2026-10-10)

99 automated tests pass; one opt-in model test is skipped. The static HTML runs
under file:// and passes browser checks at 1280px and 420px, including hostile
app text, missing screenshots and finding-to-step navigation. Normal runs also
cover Results → failed step → Debug → copy, passing final checks, and error/not-run
rows. Fresh seven-story runs: 6.53 s clean; 8.61 s with every step captured and
two expected stale-list failures. Step durations include the browser action and
settling but exclude evidence capture. Historical five 20-step runs took
1.82–1.92 seconds including browser startup.
A separate actual Sol exploration found and reproduced both planted defects
(stale-list and console-error); findings were saved automatically. The actor's
completion remains its responsibility; the independent grader is deferred.

## URL-target verification (2026-10-10)

Root and sample app typechecks pass; the sample app builds. All seven golden
stories were recorded again with actual Sol, each verified by no-model replays,
then accepted. A full check against the separately started app passes in 6.4 s.
The 20-step story takes 1.83 s median and 1.85 s p90 over ten command-to-exit
runs, including browser startup and cleanup.

Automated tests cover no-config/no-Git URL runs, direct story files, seed
precedence and working directory, failing and timed-out commands, JSON output,
path/query/fragment preservation, current-URL render/video and regression
findings. The final suite has 92 passing tests and one opt-in live-model test skipped.
A separately started server with stale-list and console-error fails the expected
add-task check. Current-URL rendering produced eight PNGs and an MP4.
Detailed probes are in the URL-target build plan.
The v1 scores below remain historical; this refactor did not repeat the entire
unprompted exploration matrix.

## Earlier proposals and v1 measurements

Founding proposals and v1 measurements, retained as history. Current decisions
above supersede app startup, worktree, baseline-commit and warm-browser proposals
in this section. Other unbuilt ideas remain proposals.

- **Where the time goes.** The expected costs, largest first: model turns, app
  boot and seeding, browser cold start, waiting for the page to settle after
  each step, screenshots. Measured in v1 (see "v1 battle test" below): model
  turns dominate recording; in a replay, waiting for the page to settle is
  about two thirds of the time, then screenshot fingerprints. Browser start
  (140 ms) and app start from cached setup (about 100 ms) are small. Likely remedies: replay with no model, cloning a
  seeded database template instead of re-seeding, a warm browser daemon with a
  fresh context per story, an event-driven settle with tight limits, and small
  viewport captures only at checkpoints. A structure-only replay in a browser
  that never draws could serve every change, with full renders kept for
  checkpoints and before/after.
- **TypeScript on Node, behind a warm daemon.** The runtime's start-up is paid
  once by the daemon and is small beside the browser, the app and the model;
  TypeScript keeps `../playtest`'s code within reach. Python is the worse
  choice: its browser libraries drive a bundled Node process anyway. Go (a
  single binary, no runtime) stays the alternative if installation becomes the
  pain. Stories are data, so the team's own languages do not constrain the
  choice. Measured on Node 26 (2026-10-09): bare start 29 ms; type stripping
  adds about 30 ms on a cold start and nothing with `NODE_COMPILE_CACHE`;
  playtest's `--help` takes 370 ms (196 ms cached), mostly eager imports of
  playwright-core and ajv, so imports stay lazy. Measured in v1: `node -e 0`
  takes 27 ms and Playtest Lite's `--help` 58 ms, with no daemon of our own.
  Node will not strip types for files under `node_modules`, so an install that
  copies the package (tarball, git URL, registry) runs through a small load
  hook in `bin/playtest.js` that strips them with `module.stripTypeScriptTypes`.
- **Batched actions with predictions** (Jeremy's idea; the details are
  Claude's). Instead of one action per model turn,
  the model sends a short run of actions, each with a cheap expectation of what
  should be true afterwards (a URL, a heading, a field's value). The harness
  runs them without the model and stops at the first unmet expectation,
  returning the state there. The model wakes only when surprised, the same rule
  replay follows. Actions on the current page use its element references;
  actions meant for a later page name elements by role and label. The harness
  forces a stop after anything irreversible (submit, pay, delete) unless its
  outcome is predicted, sends the next snapshot as a change from the last one,
  and starts each action as soon as it streams from the model. Measured in v1:
  Sol calls tools by writing a short program (Codex's code mode), so one
  response runs a whole batch with no model round trip between actions.
  Recording a sample-app story took 4 to 7 responses and 18 to 35 s; the
  20-step story took 7 responses.
- **Which model judges design.** Visual critique and pairwise judging may need a
  different model from the Sol actor, both for visual judgment and so the
  proposer cannot learn the judge's preferences.
- **Determinism is the load-bearing requirement** (Jeremy agreed). Rebuilding an old screenshot
  only works if an old commit boots and renders the same way: seeded data, a
  frozen clock, animations off, external services mocked.
- **A pinned rendering image.** Fonts and anti-aliasing differ between macOS
  and Linux, so replays that compare pixels run inside one pinned
  container image. That keeps every laptop and CI in agreement.
- **Baselines carry a screenshot fingerprint** (a perceptual hash of a few
  bytes per step) beside the normalized accessibility snapshot, so visual drift
  is detected without storing images. Built in v1 as a warning only, compared
  when platform and Chrome match. In the battle test it flagged `clipped`,
  `save-500` and `new-field`, always alongside a failure the accessibility
  tree or the mechanical checks had already caught, and never on a clean run.
- **Merge-friendly baselines.** One file per story with stable line order; on a
  conflict, re-record from the merged code instead of picking a side.
- **Baseline changes ride in the same pull request as the code change**, with a
  readable summary of what changed in the UI, so the reviewer sees the effect
  beside the cause.
- **An optional shared cache, never a store.** If regeneration gets slow at
  scale, a plain bucket can cache rendered images keyed by commit, story and
  step. A miss regenerates; losing the cache costs nothing.
- **Commands map to outcomes:** `check` (replay, report drift: regression),
  `explore` (agents wander; a finding counts only once a replay reproduces it,
  and then becomes a story: bug finding), `fix <story>` (a failing story is a
  coding agent's target), `critique <screen>` (design hill climbing), `render`
  (rebuild before/after images or video for any commit).
- **When replay drifts, the model first sorts the difference:** intended (it
  matches the change description), regression, or flaky.
- **Mechanical checks need no model:** console errors, failed requests,
  overlapping or clipped elements, horizontal overflow, broken images, layout
  shift and accessibility violations, at several viewport widths, on every
  replay. Built in v1 except layout shift and accessibility violations. They
  alone caught `console-error`, `clipped` and the slow task list, and they
  named `overlap` (a covered button at 420 px) where the tree only showed an
  extra button.
- **Design hill climbing judges against references, pairwise.** A short design
  brief plus a few reference screens stand in for the missing designer; a
  critic proposes specific changes, a coding agent builds each, and a judge (a
  different model from the proposer) picks between current and candidate
  screenshots, including hover, loading, empty and error states. Winners reach
  a person in a short daily digest of before/after stills.

## v1 battle test (2026-10-09)

Measured against `fixtures/sample-app/` with seven committed golden-path
stories: add a task, browse projects as a member, a 20-step busy morning,
change the display name, create a project, a member's permissions, and
upgrade the plan with the test card.

**Clean runs.** `check` passed every time: 3 runs of the first six stories,
then 13 runs of all seven with the default 50 ms settle window, 10 runs of all
seven with 20 ms, and the fresh-clone runs below. No flakes.

**Regression: each planted bug alone.** Every bug was flagged by at least
one story. "drift" is a difference in the accessibility tree, "issue" a new
mechanical issue, "slow" a step more than three times and 500 ms slower than
its baseline, "check" a final check that failed, "stop" a step whose target
was gone.

| Bug | add-task | browse-projects | busy-morning | change-display-name | create-project | member-permissions | upgrade-plan |
|---|---|---|---|---|---|---|---|
| `overlap` | drift, issue | drift, issue | drift, issue | drift, issue | drift, issue | drift, issue | drift, issue |
| `clipped` | issue | issue | issue | issue | issue | issue | issue |
| `console-error` | issue | issue | issue | issue | issue | issue | issue |
| `save-500` | drift, check, issue | pass | drift, stop, issue | pass | pass | pass | pass |
| `stale-list` | drift, check | pass | drift, stop | pass | pass | pass | pass |
| `dead-link` | drift | drift | drift | drift | drift | drift | drift |
| `slow` | slow | slow | slow | pass | slow | slow | pass |

Every "pass" is a story that never goes through the bug: no task is created,
or no project page is opened. The table was the same with a 20 ms settle
window.

**Intended changes: each variant alone.** Each showed as drift in exactly the
stories that pass through it, and nowhere else.

| Variant | Flagged | Passed |
|---|---|---|
| `rename-cta` | add-task and busy-morning (drift, then stop: no "New task" button); browse-projects, create-project, member-permissions (drift on the project page) | change-display-name, upgrade-plan |
| `reorder-nav` | all seven (drift on every page with the nav) | none |
| `new-field` | add-task and busy-morning (drift in the task form) | the other five |

**Speed.** A warm `check` of the 20-step story takes 1.75 s median, 1.8 s
p90, from command to exit; 1.9 s with the app and browser stopped first.
Breakdown and target in `roadmap.md`.

**Bootstrap.** From a fresh clone of this repository, `playtest check` in
`fixtures/sample-app` set everything up and passed all seven stories in 8 s
(10 s with an empty setup cache). A copy of the sample app as its own
repository went from `npm install` to a passing `check` with two hand edits to
the generated config; the sequence is in `README.md`.

**Bug finding: `explore`, unprompted** (default budget of 60 actions, Sol
at medium; about 2 minutes and 25 model responses per session). Every
finding counts only after a replay with no model reproduces it.

| `BUGS=` | Confirmed findings | Planted bugs found | False | Debatable |
|---|---|---|---|---|
| all seven | 8 (1 on weak evidence) | 5 of 7 | 0 | 2 |
| `overlap,console-error,slow` | 6 (1 weak) | 3 of 3 | 0 | 2 |
| `clipped,stale-list,dead-link` | 4 | 3 of 3 | 0 | 1 |
| `save-500` | 3 | 1 of 1 | 0 | 1 |
| none, two runs | 0 and 0 | – | 0 | 0 |

With all seven on, two bugs cannot be found by anyone: `save-500` stops tasks
being created, which hides `stale-list`, and `clipped` (or `dead-link`) moves
"New project" out from under the Feedback button, which hides `overlap`. In
groups that do not mask each other, every planted bug was found. "Debatable"
is real, reproducible behaviour that was not planted, such as the filters
lost on "← All projects".

## Playtest mechanisms: where each stands (2026-10-10)

v1 dropped two of Playtest's load-bearing mechanisms without saying so: the
harness-built actor context and the actor/grader split. Jeremy caught both.
This is the full audit; a design that drops or changes any row must say why.

| Playtest mechanism | v1 | Plan |
|---|---|---|
| Harness-built context: stable prefix, compact action log, current page, cache-aware | Implemented; bounded checkpoints and exact retrieval | `docs/backlog/actor-context/`; comparative gates open |
| Compact page: echo removal, caps | Implemented: byte/ref limits, viewport/dialog priority and exact omitted-text inspection; baseline normalizer unchanged | actor-context |
| Unchanged-page, repeated-action and expectation-mismatch signals | Implemented; unchanged page is not proof of a failed save | actor-context |
| Actor/grader split; deterministic gate apart from judgement | Actor owns completion; independent grader deferred by owner due tuning cost | `docs/backlog/grader/` is a deferred proposal |
| Action, expectation, observation and explicit memory recorded per step | Implemented; hidden reasoning is not needed or requested | actor-context |
| Personas (tester, exploratory, adversarial) and their comparison | Partly: one explorer persona with rotating plans | not planned |
| Heal with re-anchoring | Not built | milestone 5 |
| Network invariants (no 5xx, schema, OpenAPI) | Partly: failed requests only | not planned |
| Per-action performance (responsiveness, long tasks, web vitals) | Partly: action duration and settle time; no long tasks or web vitals | not planned |
| Pins: harness, prompts, models, settle rule | Partly: harness, Chrome, platform | not planned |
| Secrets (`$secret:` references) and a leak scan before accepting | Missing: credentials in plain text in stories and baselines | needed before the work app |
| Vision mode for the actor | Missing | deferred separately; not part of actor-context |
| Findings remembered across runs | Partly: explore sees its last three runs | no store, by decision |

## Carried over from Playtest

Record, act and heal; replay with no model calls; heal that re-anchors once the
path converges again; normalized accessibility snapshots as the drift oracle;
the clock pin; per-step telemetry (console errors, failed requests,
responsiveness). See `../playtest/docs/playtest-design.md` for how these work
there.

## Left behind

The hosted platform (control plane, runners, web console, Postgres and S3), the
trajectory viewer as a service, run bundles as durable evidence, and run
history dashboards. Git history and CI pass/fail are the history.

## Jeremy's brief, verbatim

From the conversation of 2026-10-09 that started the project:

> listen there's actually a use case at work where we're building out an app
> agentically so alot of changes are going in every day and it's incredibly
> difficult to do regression, as well as design hill climbing. I think we're at
> a point where it's stable enough to create some kind of visual regression.
> But i'm wary of doing something heavy like playtest.

> well, that's what playtest does, as the model you'd see a compressed
> accessibility tree (and optionally screenshots) every turn, then you choose an
> option, the tool call translates back into a playwright action, and teh whole
> thing is saved as a reproducible trajectory. Then you can replay the
> trajectory and inject an LLM again when there's a discrepency between what was
> seen before and what is being seen now.

> yea whats heavy about playtest is it went ahead and became a whole hosted
> platform thing. It was initially just a CLI. the other heavy part i think is
> the recorded bundles and management of the playtest stories and artifacts.
> the stories can be git committed, but the artifacts of each run? no...

> i dont know, the team is all about pushing the frontier of what it means to
> develop agentically. We have no designers for that reason, and not much
> product input. Thats why it's up to me as the engineer to figure out this
> problem. how to leverage AI to hill climb a UI. Not just regression honestly,
> but automated bug finding and fixing.

> yea im thinking i want to create a "playtest lite" if that makes sense. the
> original playtest was a really fun experiment and learning excercise for me to
> push the boundaries, and i think i found those boundaries already (it's very
> heavy to host and run). North stars for a lite version are 1) speed 2) actual
> performance value with re: to the hill climbing, issue finding etc. 3) how to
> solve the issue of multi player and scaleability. playtest stories can be
> checked in, maybe even baselines too. but run bundles? The screenshots used
> for visual regressions? they can't be shared. Video recordings can be
> generated locally and shared in teams chats though i guess.

> oh ofcourse!! we just need to check in the baselines and associate it with a
> code commit, then the screenshots can be derived! [...] and yes, you're
> totally right about the seeded data. I guess "playtest lite" still needs some
> way of setting up the environment, that can be checked in once as part of the
> commit too..

> yea, it needs to be super fast, that is what is going to make it feel good.
> playwright is great, but it's honestly so heavy... thats why i was wondering
> about claude in chrome - surely there are faster ways to interact with a
> browser. maybe headless even.

> yea, btw, the model that will be using it will be gpt class models. We'll
> probably go with 6.1 sol

> one problem i saw with playtest was that if you literally go turn by turn,
> it's very slow to complete. one button press, screenshot / accessibility tree
> next page, feed it into model, etc etc. repeat. Do you think we can speed
> things up with optimistic actions? e.g. have the model perform two actions at
> once instead of one?

> We use both python and js. Problme with js i think is node being so heavy.
> python is not much better though is it?

> wont the ts transpilation add latency? how is raw cdp delivered? brew? node
> package?

> let's go with raw cdp then. the other issue obviously is how we invoke the
> model. would codex sdk be too heavy?

> it's a federated sign in through codex app. It's not subscription plan, it's
> usage credit metered. I'm fairly certain that means there's an oauth flow or
> something no?

> oh i see... yea that sounds like the play

> yea i understand that there's going to be additional work getting it wokring
> with a real work app (it's node with python backend), but i think it'd be
> valuable to build out playtest-lite first and battle test it as much as we
> can so that the core proposition is really strong, it's light, it's fast.
