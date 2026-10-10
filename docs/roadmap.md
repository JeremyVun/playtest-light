# Roadmap

v1 is built and battle-tested against `fixtures/sample-app/` (design in
`docs/backlog/v1/`, scores in `project.md`). The plan is to keep testing it
there until the core proposition is strong (light, fast, and finding real
problems) before adapting it to the work app. Each milestone should be usable
on its own before the next starts.

## Current update (2026-10-10)

URL targets and optional seed commands are built. `pt` no longer manages app
processes or historical worktrees. Start the app independently; test localhost
and deployed URLs the same way. Minimal defaults live in the existing config;
flags can supply everything for a run. Details and verification:
`backlog/url-targets/`.

Seven stories were rerecorded with Sol and all pass. The 20-step replay now
includes browser startup and cleanup: ten runs, median 1.83 s, p90 1.85 s.
The complete seven-story check took 6.4 s. V1's measurements below are retained
as historical comparisons, not a description of the current startup path.

Historical screenshot reconstruction in milestone 4 is deliberately withdrawn:
run evidence captures the supplied URL. Supplying old app versions is external to pt.
The CLI is now init/run/explore/accept/view. All exploration findings are saved
outside disposable output; no adopt/issue-acceptance workflow. Every run has a
static local HTML viewer; screenshot capture and video belong to the run.
Details: `backlog/run-view/`. Actor-context is implemented with scoped live
verification; its comparative endurance/cost gates remain open. The independent
grader is deferred: completion stays with the actor, avoiding the tuning cost
experienced in the previous project. Async condition-based waits are implemented
for slow/streaming responses without holding model calls open; see
`backlog/async-waits/` for the contract and verification.

## How we know it works

The sample app is the answer key. `BUGS=` plants seven known defects and
`VARIANT=` makes three intended changes (see its README).

- **Speed:** a replay of a 20-step story, browser warm, from command to
  result. **Target: under 2 s at p90 warm, under 2.5 s with the app and
  browser stopped first** (setup already done). Measured in v1 on an Apple
  Silicon Mac, `playtest check busy-morning` (20 steps), 10 runs: median
  1.75 s, p90 1.8 s warm; 1.9 s cold. By phase, medians from
  `tools/measure-check.ts`:

  | Phase | ms |
  |---|---|
  | Node start (`node -e 0`) | 27 |
  | CLI start to command (`--help` is 58 ms in all) | about 30 |
  | Imports, project, config, baseline, run folder | 11 |
  | App ensure and browser connect, in parallel (cold: 95 and 140) | 18 |
  | Reset and new browser context, in parallel | 27 |
  | Open the start page | 89 |
  | 20 steps: action | 131 |
  | 20 steps: settle (50 ms quiet window) | 1098 |
  | 20 steps: layout checks on new pages | 25 |
  | 20 steps: accessibility snapshot | 58 |
  | 20 steps: screenshot fingerprint | 143 |
  | Compare, final checks, close, report | 9 |

  Settle is 63% of the run. With `PLAYTEST_QUIET_MS=20` the same check takes
  1.17 s median, and the full suite stayed identical over 10 runs and caught
  the same bugs, so 1.2 s is the next target once the work app shows 20 ms
  is safe there too.
- **Regression:** `check` flags every planted bug that a committed story
  passes through, and flags nothing on a clean run, run after run. Met in v1:
  all seven bugs flagged, no flakes.
- **Triage:** all three variants are sorted as intended and the planted
  regressions are not. Not built yet; in v1 each variant shows as drift in
  exactly the stories it touches.
- **Bug finding:** how many of the seven planted bugs `explore` finds
  unprompted, with how many false findings. v1: 5 of 7 with all on (the
  other two are masked by bugs that hide them), every bug in groups that do
  not mask each other, no false findings; scores in `project.md`.

## Milestones

Status after v1: 1 to 4 done; 5 not started (an intended change means
recording the story again); 6 partly done (exploration and automatic findings, no `fix`);
7 to 9 not started.

1. **Spikes.** Two throwaway measurements in `tools/`, results into
   `project.md`:
   1. A Codex app-server thread calls one of our own tools that clicks through
      raw CDP in the sample app. Measure the round trip, and whether tool calls
      arrive early enough to start actions while the model is still writing.
   2. A hand-written 20-step raw-CDP replay of a sample-app story, timed by
      phase: app boot and reset, browser start, per-step settle, actions,
      accessibility snapshot, screenshot.
2. **Design.** A backlog item settling the open choices in `project.md`:
   baseline format, environment setup file, pinned rendering image, command
   set, and what to lift from `../playtest` versus rewrite. It must also say
   how the harness finds the app's own repository and commit (the sample app
   shares this repository; the work app will not), and how sample-app changes
   are made as real commits so `render` has history to rebuild.
3. **Deterministic replay.** Environment up from the committed setup, `record`
   a story, `check` replays it with no model and reports drift in the
   accessibility snapshot and screenshot fingerprint, plus the mechanical
   checks. Proves speed and determinism.
4. **Derived evidence.** `render` rebuilds before/after screenshots and video
   for any story at any commit from a temporary checkout. Proves nothing needs
   storing.
5. **Heal and triage.** On drift, the model heals the path and sorts the
   difference into intended, regression or flaky; healed baselines are
   proposed in the same pull request as the code.
6. **Explore and fix.** Explorer agents produce reproduced findings that become
   stories; `fix` hands a failing story to a coding agent.
7. **Design hill climbing.** Design brief and reference screens, `critique`
   with pairwise judging, and the daily before/after digest. The sample app
   has no measure of design quality yet; this milestone has to add one.
8. **Scale.** Parallel replays, running only the stories a change touches, and
   the optional shared image cache if regeneration proves slow.
9. **The work app.** A Node front end with a Python backend: bringing any
   commit up with seeded data from committed setup, then the same measures as
   above.
