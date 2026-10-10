# Actor and grader split

Deferred by the owner, 2026-10-10. The actor remains responsible for completion.
The earlier independent grader was finicky to tune; added cost and complexity
need demonstrated value before revisiting it. The design below is historical,
not an instruction to implement a grader.

Owner's current direction, verbatim:

> i think the models now adays are good enough that we dont need to worry about the gap between belief and actually succeeding at a goal. As long as the actor interacted with the app the same way a human user would.

Today the actor that plays a story also writes the story's assertions: at
`done` it picks checks from five fixed kinds (text, url, element, absent,
value), the harness evaluates them, and they are replayed on every `check`.
Two problems:

- **The actor grades its own homework.** It chooses checks it has just seen
  pass, in the same context that wants to finish.
- **Five fixed kinds cannot hold most intent.** "The new task appears in the
  list", "the total matches the line items", "the error tells the user what
  to fix" get squeezed into "a checkbox with this name exists", or lost.

This item replaces the actor's checks with a grader: a separate context that
judges the story's own "Done when" bullets against evidence, and whose
verdicts are cached against the pages they cite so a clean `check` still
calls no model.

## Jeremy's words (2026-10-09)

> sigh you see the issue here right? The harness shoudln't have hardcoded
> assertions. Unless im mistunderstandig you, this is not at all flexible.

> Shouldn't the grader be a separate context window? i really do think we
> should have an actor grader split

## Rulings (2026-10-09)

- **Actor and grader are split.** The grader runs in its own thread and
  never sees the actor's conversation, reasoning or claims.
- **The grader is Sol in a fresh thread** (same model and sign-in as the
  actor).
- **The grader sees pages as text plus screenshots.** Verdicts are cached on
  the page text only, so screenshots never make `check` flaky.
- **No hardcoded assertions.** The five check kinds stop being the story's
  assertions; the "Done when" bullets, in plain English, are.

## Roles

- **Actor** (recorder or explorer): plays the app. Recording ends with
  `done({ summary })`, a claim that the story is complete, with no checks.
  Exploring reports findings as claims (title, expected, actual, the steps
  it concerns), with no checks.
- **Grader**: given the story and evidence, returns a verdict per
  criterion. It does not drive the browser.
- **Harness**: replays with no model, compares pages, gathers evidence,
  validates the grader's citations, caches verdicts, decides pass or fail.

## What the grader is given

One message, no history:

- The story: title, prose, and the criteria. The criteria are the "Done
  when" bullets; a story without bullets gets one criterion, "the story as
  described was completed".
- The steps that ran, as plain actions (`click button "Save task"`). These
  are facts the harness observed, not the actor's account of them.
- The page after every step as normalized accessibility text, numbered by
  step, plus the start page.
- Mechanical issues per step (console errors, failed requests, layout).
- Screenshots (viewport size) of the last step on each distinct URL path,
  at most six, with the step number in the caption. Passed as image input
  (`localImage` in Codex's user input); the model layer grows image support
  for this.

For exploration findings it is given the same evidence up to the cited step
and one criterion per finding, phrased as the claim to verify.

## What the grader returns

A `verdict` tool call per criterion:

```json
{ "criterion": 1, "verdict": "pass", "steps": [7], "quotes": ["checkbox \"Mark \\\"Write launch email\\\" complete\""], "reason": "The new task is a row in the list after saving." }
```

- `verdict`: `pass`, `fail` or `unclear`.
- `steps`: the steps whose pages the verdict rests on.
- `quotes`: lines from those pages that support it.
- The harness checks each quote appears verbatim in a cited step's page
  text. A verdict whose quotes do not appear is rejected with the reason and
  asked again once; it is `unclear` after that. This keeps verdicts tied to
  evidence that exists.
- A verdict resting only on a screenshot (no quotable line, for example "the
  error is red") is allowed with `quotes: []` and is marked visual. Visual
  verdicts are cached on the cited pages' text like the rest; if that text
  is unchanged but the pixels moved, the fingerprint warning is what flags
  it, as today.

## The cache: why a clean check needs no model

Each verdict has a key: a hash of the criterion text and the normalized
page text of its cited steps. The baseline stores verdicts with their keys.

On `check`, after replay, the harness recomputes each verdict's key from the
replayed pages. Same key: the evidence the verdict rested on is identical,
so the verdict stands, no model. Different key: that criterion is regraded
on the new evidence. One grader call per story covers all of its stale
criteria; stories are graded concurrently.

Graded results for a page state that is not the baseline's (a drifted run)
are also cached in `.runs/grades/<key>.json`, so re-running `check` on the
same drifted app does not call the model again.

## Record

1. The actor plays the story and calls `done({ summary })`.
2. The harness replays the actions with no model to build the baseline
   (as today), then grades the baseline's evidence.
3. If any criterion is `fail` or `unclear`, the actor is told which, with
   the grader's reason (not its conversation), and continues from its live
   page. At most two rounds, then the recording fails.
4. Determinism replay as today, also confirming every verdict's key
   reproduces.
5. The pending baseline holds the verdicts, their cited steps, quotes and
   reasons. `accept` shows them; they are in the pull request diff.

## Check: three outcomes per story

| Outcome | When | Exit |
|---|---|---|
| pass | No drift, no new issues, no slow steps; verdicts reused. | 0 |
| changed | Pages drifted, but the grader passes every criterion on the new evidence. The UI changed and the story still does what it is for. | 1 |
| fail | A criterion fails or is unclear, a target is gone, a new mechanical issue, or a slow step. | 1 |

`changed` still exits 1 because the baseline is stale; the label tells the
person or agent which job it is: re-record (later: heal) for `changed`, fix
the app for `fail`. This is the first half of milestone 5's triage.

Without Codex (`check --no-grade`, or Codex unavailable) drift is reported
as now and stale criteria are marked "not regraded"; drift is then a `fail`.
CI without a model sign-in keeps working.

A story whose path breaks (a target is gone) cannot be graded past that
point; it is `fail` with the reason, until heal exists.

## Explore

`report_finding` loses `checks`. A finding is confirmed when the no-model
replay reproduces the session and the grader, given that replay's evidence
up to the cited steps, rules the claim `pass` with quotes. Harness findings
(issue keys) are confirmed by key as today. The "weak evidence" heuristic is
replaced by the grader's verdict and quotes. Merging model findings with
the harness issues they explain stays.

## Baseline format

`version: 3` (URL targets already uses version 2). `checks` is replaced by:

```json
"verdicts": [
  { "criterion": "the task \"Write launch email\" is in the project's task list",
    "verdict": "pass", "steps": [7], "quotes": ["…"], "reason": "…", "visual": false, "key": "3f9c…" }
]
```

Earlier baseline versions are refused with "record this story again"; the seven
sample stories are recorded again as part of the build.

## What goes away

- The five check kinds as story assertions and the `done` checks argument.
- `checks` on explore findings, the `no-text` kind, and the weak-evidence
  pass.
- The five kinds stay inside the harness only where they are mechanics, not
  assertions: the actor's per-action `expect` predictions that stop a batch
  early.

## How we know it works

The sample app's answer key, as in v1, plus triage:

- Clean `check` three times: all pass, zero grader calls.
- Each planted bug: `fail` in the stories that pass through it (same matrix
  as v1).
- `VARIANT=reorder-nav` and `VARIANT=new-field`: `changed`, not `fail`.
  `VARIANT=rename-cta`: `fail` (the path breaks at "New task") until heal.
- `BUGS=stale-list`: `fail` with the grader quoting the list without the new
  task; `BUGS=save-500`: `fail`.
- Explore: the same planted-bug score or better, and no false findings on
  the clean app.
- Cost: grader calls per drifted story and seconds per call, reported.

## Rejected

- **A grader that runs on every check.** Slow, costs model time on every
  run, and can flip on an unchanged page. The cache gives the same answers
  with no model when nothing changed.
- **Assertion code written by the actor.** Expressive and free at replay,
  but it is code someone has to review and it is still the actor grading
  itself. Can return later as an opt-in for criteria that must be checked
  on every run.
- **A different model as grader.** Ruled out for now in favour of Sol in a
  fresh thread; the grader sits behind the same model interface, so a
  `model.grader` config key can come later.
