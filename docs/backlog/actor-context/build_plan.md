# Actor context: build plan

Status: implementation landed in the working tree 2026-10-10; functional
verification passes so far. Scoped endurance verification is complete; the larger
paired comparative benchmark remains unverified.
Read [design.md](design.md) for the contracts and gates. Historical transport
spikes are complete in [spike-results.md](spike-results.md): the original shared
home cache gate failed, then the approved private-home forklog/HTTP spike passed
its conditional cache measure. Neither implemented production history control,
token accounting or long-run memory. Do not rerun those exploratory matrices
without a version change or an unresolved failure that justifies it.

Keep implementation and live verification separate. For code phases run
`npm run typecheck`, `npm test`, and the phase-specific checks. Start fixture apps
independently on ports 5400+, never 5310; pass the URL and seed command to pt.
Preserve existing dirty checkout work. No deployment, API-key migration,
extra CLI/config surface, grader implementation or visual redesign in this item.

## Phase 1: bounded model decisions and accounting — implemented; scoped checks pass

Owns `src/model/`, the Model seam in `src/types.ts`, `tools/spike-context.ts`,
model/scripted tests. Keep current callers working until phase 4 switches them.

- Private-home HTTP transport with a private stdio app-server per run; fixed
  minimal source rollout, disposable forks, full lockdown reapplied per fork,
  `environments: []` on each turn. Clean up source and fork resources.
- Add `decide` accepting a reusable prefix, volatile input and one tool handler.
  Return the call outcome, response usage (or unknown) and timings only after
  local execution settles; no second mutation or follow-up model response.
- Correlate response IDs; distinguish total/cached/output counts and unknowns,
  bootstrap, cancellation and errors. Hold replies until usage or bounded timeout.
  Never retry an action because the transport broke after it started.

Gate: fake transport tests for duplicate/concurrent calls, late usage, failed
interrupt, cancellation and disconnected-but-running tools. Capture the installed
backend's actual request shape without credentials. A short real-model probe
must confirm no previous-decision marker, stable tools/source cache identity,
correct usage and no unwanted follow-up response. The 20-decision historical
spike is a reference, not an automatic pass on a new backend version.

## Phase 2: exact evidence, state projection and retrieval — implemented; scoped checks pass

Owns new `src/run/context.ts`, journal helpers as needed, `src/env/runs.ts`,
trajectory event types and tests. Reuse the trajectory, no parallel memory store.

- Stable event/decision/step IDs, append-before-checkpoint ordering and derived
  offset index. Persist exact observed text separate from compact previews.
- Task/fact memory updates with versioned source IDs, observed versus hypothesized
  content, immutable original criteria and no implicit verification of claims.
- Deterministic bounded checkpoints; open-work index with omission counts; exact
  archived values and searchable old evidence. No model-written summaries.
- One `inspect` schema for history/memory/page; implement history and memory now.
  Bounded results, query/high-water cursors and long-field continuation.
- Protect active runs during pruning and release ownership on completion/crash.

Gate: deterministic 2,000-decision sequences exercising several rollovers,
corrections, many pending tasks, early values retrieved late, Unicode/large values,
corrupt tails, missing evidence and concurrent pruning. No file-sized reads per
query and no memory growth proportional to archived page text. Rebuild derived
state from the journal and compare it with the live projection.

## Phase 3: bounded live page and stable cached prefix — implemented; scoped checks pass

Owns `src/browser/{page,snapshot}.ts`, Page seam in `src/types.ts`,
`src/run/context.ts`, page inspection and tests.

- Self-contained actor page with geometry-based viewport priority, dialogs,
  alerts, full-value inspection, omitted counts and 200-ref limit. Existing
  echo suppression remains; normalized baseline output stays unchanged.
- Observation-scoped refs, expired-cursor/ref errors before mutation and live
  resolution of role/name locators within batches. Historical refs cannot act.
- Byte-budgeted serialization: immutable header/checkpoint, append-only epoch
  tail, volatile current page/retrieval/budget. Checkpoint rollover only for
  capacity, never every turn or after a mere task switch.
- Inspect page search/region/pagination integrated with the same result budget.
  Arbitrary app text remains labelled evidence, never harness instructions.

Gate: exact prefix comparisons across ordinary decisions, task/fact corrections,
retrievals, tool errors and countdown changes; only rollover may replace the
checkpoint. All component budgets enforced before sending. Large pages remain
navigable through inspect; long labels are not presented as app truncation.
Assert existing normalized snapshots/baselines are identical. A captured real
backend probe verifies cache attribution across at least two rollovers.

## Phase 4: recorder/explorer integration — implemented; scoped checks pass

Owns `src/run/{actor,record,explore}.ts`, prompts, `src/run/report.ts`, findings
stats and the existing Debug data integration. Avoid a new metrics dashboard.

- Both actor loops use the new decision seam; keep action batches and existing
  final checks/verification. Wire optional memory updates and read-only inspect.
- Archive only observed/executed events, preserve skipped actions as skipped,
  distinguish unchanged page from failed effect, surface repeated attempts.
- Retain current deadlines/action budgets; enforce decision limits and report
  unfinished work/capacity failures accurately. No seed during context rollover.
- Detailed token/latency/epoch metrics in JSON and existing Debug output; concise
  human CLI output. No recorded reasoning required to make memory work.
- Remove the replaced accumulating actor path once both callers migrate; keep
  only model seams actually needed by other callers and tests.

Gate: existing scripted and browser suites, cancellation and error paths. Record
and independently verify all seven fixture stories on the real model, then
repeat clean/planted exploration checks. Confirm replay still calls no model,
rollovers do not reset app/session state, and finding evidence remains usable.

## Phase 5: endurance and paired cost verification — scoped live checks pass; comparative gates open

Owns reproducible fixture scenarios/tests, an endurance probe under `tools/`,
and results in this folder. Freeze the pre-change baseline before live trials;
keep its model/app/seed/budget conditions matched to the candidate.

- Build three workflows in the design at 200/500 actions, three trials each;
  fixture-owned final-state and event assertions. Include 200 model decisions,
  multiple rollovers, exact old-fact recovery and omitted-evidence retrieval.
- Interleave baseline/candidate runs; record all outcomes and backend versions.
  No filler actions, oracle answers in actor context, or cherry-picked trials.
- Evaluate the design's completion, false-pass, mutation, memory, cache and
  cost/latency gates, including cold starts, misses, rollover and unknown usage.
- Report peak process memory/retained fork resources and archive growth as well
  as bounded prompt size. Fix failures and rerun affected comparisons.

Gate: every release gate in design.md met, or an explicit unresolved result
recorded with the item still unshipped. Aggregate cost per successful workflow
must include failed attempts. Unknown billing rates prevent monetary claims;
unknown token usage prevents a complete cost gate, not the functional results.

## Phase 6: measured closeout — documentation updated; item remains open

Owns `docs/project.md`, `README.md`, this folder, and durable contracts at close.
Document actual limits, private-home sign-in and measured results. Keep proposed
numbers distinct from achieved numbers. Update stale project mechanism statuses.
The grader follows this item and needs its own long-evidence review; actor memory
must not leak notes or inferred claims into independent grading.

Gate: docs match shipped behaviour, examples/help remain small, measurements
include failures and tradeoffs. Close only after phase 5 passes; do not mark this
feature done because the historical cache spike succeeded.

## Implementation log, 2026-10-10 (in progress)

Jeremy's implementation request, verbatim:

> ok, implement it, then do a run and check the context that gets built up to see if htere's any other issues or things we can do to improve it

> also look for what can be removed or reduced from the what is put into the context window without reasonably affecting the effectiveness of the model's performance.

Implemented the bounded private-home fork transport, usage accounting, shared
recorder/explorer decision loop, context journal and retrieval, append-only epochs,
explicit task/fact updates, bounded actor pages with raw-text inspection, stable
non-recycled refs, and active-run pruning protection. Verification is ongoing;
none of the broad release gates are inferred from a single successful run.

Live inspection already changed the implementation:
- Compact action descriptions replace raw event JSON; failures come before long
  arguments. Batch results no longer repeat every action. Old page text stays
  outside the epoch tail. History searches return excerpts; ID reads are exact.
- Removed obsolete accumulated-conversation instructions, examples and nudges.
  Memory format is documented once instead of duplicated in every tool schema.
- Fork usage is only delivered at turn end on CLI 0.160.0. Wait up to one second
  from call arrival (overlapping browser work), or until response completion,
  rather than two seconds after the batch. Unknown usage remains unknown. All
  responses in the first three short probes and 234-action probe had usage.
- Raw per-action archive capture does not collect viewport geometry; only the
  live actor view does. Baseline normalization remains unchanged.
- `done` claims the original criteria via existing checks. Additional open tasks
  block it; original criteria need not be restated as memory updates just to end.
  This avoids a redundant actor response. Independent grading is still separate.
- Run ownership markers live beside the directory and are created before it,
  avoiding a gap where pruning can delete a newly created active directory.

Initial real-Sol sample-app probes, same 20-action busy-morning story:

| version | decisions | total input | cached input | output | wall ms | max context data bytes | verified |
|---|---:|---:|---:|---:|---:|---:|---|
| initial bounded implementation | 7 | 38,229 | 22,016 | 724 | 47,181 | 9,239 | yes |
| compact log | 8 | 39,868 | 13,440 | 850 | 37,836 | 5,996 | yes |
| lean instructions/tool schemas | 6 | 25,037 | 12,160 | 637 | 32,586 | 5,350 | yes |

Each reusable prefix was byte-identical to the preceding prefix plus appended
events. Cache hits varied; these are sequential implementation probes, not a
paired cost study or a pre-feature baseline comparison.

The first 234-action run created 45 distinct high-priority completed tasks and
correctly reused an early task title after renaming it out of the UI. A database
oracle confirmed count, uniqueness, priority, completion and exact remembered
value. There was one checkpoint rollover and three inspections. Its replay gate
FAILED because the fixture's 4-second toast expiry produced different snapshots
in the two replays. Do not describe that as verified deterministic recording.
A fresh 234-action run now passes the database oracle and both deterministic
replays after this test-mode-only correction: show the newest
notification until replacement/dismissal, with no wall-clock expiry. Production
fixture behaviour is unchanged. No change to the harness drift oracle.

Current verification artifacts: `/tmp/pt-context-live.4lX0nX/`; reusable probe:
`tools/probe-context.ts`. Unit tests include 2,000 decisions/rollovers, exact
Unicode retrieval, invalid-memory non-mutation, active-run pruning, transport
single-call enforcement and disconnect-after-mutation. The test count and final measurements are recorded in verification.md. More
focused checks cover cancellation, late/missing usage, stable memory pagination,
validation errors, deadline-stopped batches and resize step numbering.
The 18-run matrix and paired monetary/latency gate have not yet run.


Additional implementation decisions from trace review:
- A successful batch does not need a second “Batch finished” line after its
  individual executed actions. That event stays in the journal but leaves the
  prompt. Empty evidence/memory sections and initial-page placeholders are gone;
  remaining minutes use one decimal place.
- Keep validation errors, expectation failures, browser issues and repeated-action
  warnings. A regression test catches the earlier over-aggressive reduction that
  described invalid arguments as a finished batch.
- Flat task IDs plus associations on facts replace a separate dependency graph.
  History uses exact IDs/literal search; no additional range/filter language.
  Memory queries rebuild the projection at their cursor's high-water mark.
- Native and scripted close wait for in-flight browser work. No next batch action
  starts after the deadline. Transport control/cleanup has a five-second bound;
  cancellation and transport errors never retry a mutation.
- Checkpoints retain a bounded visited-page/finding index and prioritize unfinished
  work over completed tasks. Resize increments the same journal step counter as
  successful browser actions.
- The old accumulating model seam remains only for existing transport tests and
  historical probes; both production actor loops explicitly use bounded decisions.
  No CLI or config switch was introduced.
- Seven fresh real-model recordings all pass both replay checks. Clean exploration
  has no findings; planted exploration reproduces stale-list and console-error.
  The fixture toast correction changes two busy-morning snapshots; its original
  action sequence was rebuilt and independently checked before saving that baseline.

This is implemented behaviour with scoped live evidence, not completion of the
18-run comparative release matrix. The item stays open until that broader claim
has evidence; do not infer monetary savings from smaller prompts or hit rates.

Measured results, including failed initial replays and variable cache hits:
[verification.md](verification.md). Exact context and full journal are linked from
run reports. Failed decisions preserve available usage; missing usage is counted
as unknown, including timeout/error paths.

The forced-turn queue probe is complete: 202 decisions, 402 actions, three
rollovers, no wrong submissions, exact Unicode reference recovery and two
passing replays. Peak data context 14,151 bytes; 80.8% of input tokens cached.
Within-epoch prefixes matched exactly. These are controlled-endurance results;
the proposed comparative multi-scenario release gates remain open.


Viewer follow-up, Jeremy's request verbatim:

> That is the other metric i want in the playtest view btw. context window, input, and output

Add measured full-input context size and input/output token totals to the existing
static view. Count each decision once across batches and include decisions with
no browser action. Distinguish missing usage from zero and replay from model use.
Show decision attribution on selected steps and retain copyable exact numbers in
Debug. Keep the viewer light, with no new tabs or expandables. Verify normal and
exploration output at wide and narrow sizes using real captured run data.

Implemented: run-wide peak context, input/output totals and cached input share;
selected-step decision usage; exact copyable usage in Debug. Original batches
share decision IDs, replay has no model attribution, and failed/missing usage
stays explicit. Fresh recording and exploration totals match their context
statistics exactly. Wide/narrow captures and real results/findings → steps →
Debug → copy checks passed. Root typecheck and 119 tests pass, one optional live
test skipped; see verification.md for the fresh live probes.

Jeremy's simplification, verbatim:

> you dont need to put it on every step.. try to keep the UI light and clean.

Removed token blocks from step evidence and step Debug, plus their rendering
logic and styling. The compact run summary remains; exact usage stays in the
saved evidence data. Refreshed the real reports and rechecked the viewer.
