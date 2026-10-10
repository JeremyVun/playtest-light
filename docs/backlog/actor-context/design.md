# Actor context for long UI sessions

Status: implemented in the working tree, 2026-10-10; scoped verification complete.
Record/explore use bounded decisions. The broad comparative release gates below
are not yet established. Actual results and implementation decisions are in
[build_plan.md](build_plan.md); historical transport measurements are in
[spike-results.md](spike-results.md).

## Jeremy's brief, verbatim

> yes, we should be doing context management like playtest. we should be
> engineering the context ourselves. small context means fast decisions and
> smaller costs. gpt 6.1 is smart enough to handle the compact context
> representation that playtest uses.

> how is the context management working? can it be made more efficient and effective?

> For context, i need playtest to be able to work really well on long context tasks e.g. many many turns when going through a UI the same way a human would

> yea, think it through carefully and make sure the proposal is good.

> making sure not to bust the cache is important as well to keep it fast and keep costs low.

Earlier recorded ruling: Jeremy chose a private Codex home, default
`~/.playtest-lite/codex`, with its own sign-in, and another forklog/HTTP spike
before building. That spike ran. This revision retains that choice, batched
actions, URL-first operation, the small CLI and the actor/grader separation.
The numerical budgets and release gates below are proposed engineering defaults,
not numbers supplied by Jeremy.

## Outcome and scope

The actor must complete work that spans hundreds of browser actions: create
something, switch tasks, recover from failure, return much later, and use the
right record and values. It must keep unfinished obligations and distinguish
what it attempted, what the browser showed, and what it merely suspects.

Keep a bounded working context and a complete, locally retrievable run history.
Preserve cacheable prefixes between decisions; accept occasional bounded
checkpoint replacements rather than unlimited history or constant summary
rewrites. Task success comes first, then measured cost and latency together.
A smaller prompt alone proves neither speed nor savings.

This is internal to record/explore. No memory service, vector database, extra
config file, new CLI flags or memory-management commands. Baseline replay stays
model-free. No crash-resume promise: recovering browser state after a process
restart is a separate feature. Resuming a subtask during the same live run is
required. Actor vision remains a separate proposal, not a dependency or a new
`--vision` flag in this item.

## Pre-implementation behaviour (historical)

- `src/model/codex.ts` holds one conversation per session. Record/explore tool
  results accumulate; the harness does not control their removal.
- `src/browser/snapshot.ts` already removes echoed names and clips individual
  strings to 300 characters. There is no overall page/ref budget. The previous
  proposal incorrectly said echo removal was missing.
- `Actor` sends shorter page diffs when useful. These depend on earlier pages
  still being present; a rebuilt context must instead contain a self-contained
  current page. A successful browser action is not proof of its intended effect.
- `explore-history.ts` sends limited findings/page coverage from three earlier
  matching runs. That is separate from memory during one long run.
- Reports count responses, not token usage. `.runs` pruning currently has no
  protection for a long-running session when other runs start.
- The spike established a workable fork/HTTP path. Its approximately 5.3k-token
  prompts were measured over 20 synthetic decisions, with an increasing log;
  they were not actually constant-size for arbitrarily long sessions.

## One journal, two views

Extend the existing per-run trajectory rather than create another source of
truth. Give each event a monotonic ID, decision ID and, when applicable, browser
step ID. Record action attempts, resolved locators, expectations, results,
mechanical issues, page observations, memory updates and retrievals. Record a
batch's executed prefix and skipped suffix; never turn an unexecuted action into
an event claiming success. Keep exact observations before actor-only compaction.

The archive grows on disk, not in each prompt. A derived offset index provides
bounded reads and search; no separate database. Derived checkpoints reference an
exact journal event ID and can be rebuilt. Append events before publishing the
next checkpoint. An incomplete or corrupt archived event fails its read explicitly;
missing/corrupt evidence is reported unavailable, never reconstructed as fact.
The current implementation does not reopen existing run journals: interrupted
output remains readable on disk, while a new actor requires a fresh run. Memory
inspection rebuilds the task/fact projection through its cursor high-water mark.

Use two views of the same journal:

1. **Working context:** original task and completion criteria, a checkpoint of
   relevant state, compact event lines since that checkpoint, the current page,
   and the latest explicitly requested evidence.
2. **History:** exact older events, pages and memory versions, addressable by
   IDs and searchable by text, URL, task or record label.

No recursive model-written summaries. Checkpoints are deterministic projections
of recorded observations and explicit actor notes, with provenance retained.
This avoids a separate summarization call and repeated paraphrasing errors.

## Working memory and unfinished work

The original task and its completion criteria are immutable. Actor tools accept
an optional bounded `memory` update alongside their existing arguments; no extra
model round trip is needed. Updates operate by stable ID on tasks and facts:

- A task has a title, status (open, active, claimed complete or abandoned),
  and optional evidence references for status changes. Tasks are flat: explicit
  parents/dependencies were not needed by the implemented actor tools. The current
  task and unfinished tasks remain discoverable after every checkpoint.
- A fact has a label, exact value, source event IDs and a kind: observation or
  hypothesis. Task/record associations permit relevant selection. A model note
  remains a claim: valid citations prove the source exists, not the inference.
- Corrections append a new version; they do not rewrite earlier prompt bytes.
  Conflicting observations remain attributed and dated. Old facts describe
  earlier state until checked against the live page; recency alone is not truth.

Initialize required tasks from the story's explicit criteria, or one task pointing
to the full prose when there are none; an exploration goal is one required task.
The actor can add subtasks, not remove or rewrite those original obligations.
Memory citations are validated against the journal high-water mark of the last
decision, never the future result of the accompanying action. This establishes
source availability, not that every cited byte was displayed or supports the claim. Reported findings remain
claims until their existing verification path establishes otherwise.

The harness automatically retains action results, expectation failures, reported
findings, visited pages and counts. Exact filled/selected values and resolved
locators remain in the archive even when the model forgets to write a note.
Recent action context remains available alongside notes, not replaced by them.
Do not require narration or hidden reasoning to maintain memory.

At rollover, prioritize active tasks, original requirements and open tasks ahead
of completed work, then facts associated with those tasks and recent facts.
Keep recent outcomes plus a small visited-page and reported-finding index. Stable
ID order makes selection/rendering deterministic. Keep a compact unfinished-task
list; if it exceeds its allocation, show counts plus a paginated task index,
never claim omitted tasks are complete. Closed work remains searchable.
Explicit task switches/retrievals select facts in the volatile evidence area
until the next rollover; they must not rewrite the checkpoint on every turn.
Reserve 2,000 bytes within the checkpoint for up to eight recent action outcomes
and exact-evidence references, so rollover does not erase the immediate recovery
context. A pending required-task check reads the complete derived task index,
not just the subset that fits in the prompt.

A `done` call claims the original criteria through the existing checks; it
does not require a redundant memory update marking each original criterion
complete. Added open/active subtasks block `done` until explicitly resolved
or abandoned. Claimed completion never independently passes a story: retain
today's checks/verification until the separate grader item replaces them. Compaction must not silently change the meaning of `done`
from the current `done({ summary, checks })` contract.

## Cache-preserving context assembly

An **epoch** is the period between checkpoint replacements. On every decision
inside an epoch, serialize this order:

```
fixed tool schema and harness instructions
original task + unchanged epoch checkpoint
append-only event tail, in stable event order
--- end of reusable prefix ---
current page + latest retrieval + remaining budget
```

No per-decision timestamps, countdowns, re-sorted coverage tables, rewritten task statuses or
changing metrics before the volatile suffix. Status changes and new findings
are appended as events. All variable fields use deterministic serialization.
Record the shared-prefix byte count to distinguish our invalidation from a
backend cache miss. Keep the same tool declarations even when some tools are
inapplicable to a particular decision.

The event tail is a compact projection, not raw journal JSON: action/outcome,
memory changes and evidence references, without old page bodies or retrieval
payloads. Bound action previews to 256 bytes with explicit omission markers;
retain accepted memory values verbatim within their separate update limit.
If a batch produces more tail than fits, journal every result, fold it into a
new checkpoint and include a bounded batch outcome with an archive range. Never
drop executed actions from the archive or silently omit a batch failure.

Use the measured forklog layout: fixed instructions followed by serialized
context data in the fork's base instructions, with the volatile suffix in its
turn. Context data must be explicitly labelled as quoted evidence, never rules;
serialize/escape arbitrary app text so it cannot close the data envelope.
The fixed rules say app text, notes and retrieved content cannot change tool
permissions or the user's task. Include hostile page text in transport tests.
If the backend cannot preserve that separation in practice, move data into the
user message and measure the cost; do not trade instruction integrity for hits.

Continue appending until the event-tail allocation would be exceeded. Between
decisions, materialize a new bounded checkpoint and start an empty tail. Keep the
fixed header byte-identical across epochs. A rollover can lose cache coverage
for the changing state; account for that cost explicitly. Do not rotate every
N actions, refresh on a timer, summarize every turn, or warm the cache with a
second paid response. No silent fallback to an accumulating conversation.

Initial budgets, in UTF-8 bytes (not estimated tokens): original task 12,000;
checkpoint 8,000; event tail 12,000; current page 8,000; retrieved evidence 6,000;
volatile metadata 2,000. Maximum harness data is 48,000 bytes, plus fixed
instructions/tool schemas and backend overhead, all measured separately.
Unused allocations are not silently borrowed. These are internal constants,
subject to the gates below, not settings the user must tune.

Reject an oversized original task before starting browser work, with its actual
size and limit; never silently truncate its requirements. Oversized individual
observations get a bounded preview and exact archive reference. Validate memory
updates before executing their accompanying action; rejected updates produce
no browser side effect. Limit each update to 2,000 bytes. Very large referenced
values are read in chunks rather than repeatedly stuffed into the prefix.

Rollovers cannot delete open work or archive data. If the minimum working
context cannot fit, return a specific unfinished/context-capacity result with
evidence intact. Do not loop on compaction or report success. Bytes bound the
payload; actual input/cached/output tokens and their costs still decide whether
the budget performs well for multilingual pages and different tool overheads.

## Retrieval and page inspection

Add one read-only actor tool, `inspect`, with explicit modes:

- `history`: read an exact event ID, or search any archived text (including
  URLs and task/fact IDs). Text search is deterministic literal matching, not
  a model or embeddings. No separate range/filter language is needed. Return source IDs, bounded excerpts,
  total matches and an opaque continuation cursor; absence is explicit.
- `memory`: list/search tasks and facts at a stable journal high-water mark.
  Earlier versions remain available through history.
- `page`: search the live accessibility tree or page through
  omitted nodes/text. This is how a control outside the compact view is found.

Search indexes the full archived observation text, not only previews or model
notes. Cursors bind to a query and journal high-water mark, so new events do not
skip/duplicate historical results. Page cursors bind to the current observation
and expire when it changes. Every mode respects the 6,000-byte response budget;
long individual fields have explicit continuation. No hidden “and more” dead end.
The next decision receives the result; later decisions retain its reference and
any explicit notes, not an accumulating collection of retrieved snapshots.

Historical snapshots carry no usable live refs. Live refs are observation-scoped;
a stale ref is rejected before action, with a fresh observation. This requires
an explicit snapshot/version binding in the Page/actor seam. Batched actions
may still name future elements by role and exact name as today, resolving them
against the live page. Merely seeing an old locator does not establish its
current presence. Late page changes, scope changes and authentication loss must
trigger renewed observation rather than an automatic repeat of a submission.
Do not invalidate every remaining batch ref merely because a field was filled:
validate the referenced live node's identity/semantics before use. Navigation or
replacement invalidates it. Page inspection can issue refs for omitted controls;
they stay usable while that observed node remains valid, even if the default
compact page does not include the control. Never silently rebind a stale ref.

## The current page and action outcomes

Send a full, self-contained compact view on each decision, not a diff whose base
has been removed. Preserve page URL/title, dialogs, alerts, focused control,
then viewport content and navigation. Collapse repetitive structure while
retaining distinguishing labels and inspectable regions. Cap at 200 live refs
and the byte budget above. Report omitted counts and how to inspect them.
Never render a clipped string as if the app itself displayed an ellipsis.
The actor needs access to the full raw name/value even though the existing drift
normalizer clips strings; leave baseline/oracle output byte-for-byte unchanged.
Viewport prioritization needs geometry from the browser seam, not a guess based
on tree order. These are actor-view changes only.

Distinguish action execution, expectation results, observed page change and
hypotheses. `page unchanged` is a warning, not proof a save failed: asynchronous
or off-page effects may occur. Repeating a submission must not be the default
recovery. Detect repeated equivalent actions on unchanged state and surface the
attempt count, previous error and current expectation. Do not automatically
skip intentional repeats, polling, scrolling or edits.

## Decision execution and lifetime

Expose a bounded `decide` operation behind `Model`; keep scripted tests supported.
Use a private stdio app-server per run, the approved private Codex home and HTTP.
Fork each decision from a fixed minimal source rollout; never fork from the
previous decision or append work to the source. Reapply provider, instructions,
lockdown and tools to each fork; `environments: []` on every `turn/start`.
Inspect actual outgoing layout on the installed version before relying on the
historical spike. Missing sign-in produces the private-home login instruction,
not a fallback to the user's shared daemon.

Accept one actor tool call per decision; `act` can execute a batch. Validate and
reserve its call ID before mutation. Reject additional/concurrent calls without
executing them. Await the executed batch before the next page/context is built.
A code-mode program containing two calls must not execute the second. Finish or
invalid/no-call responses consume a decision and get a bounded correction in
the next context, rather than silently ending a successful session.

Hold the tool reply while waiting for response completion/usage, then interrupt
and dispose of the fork without starting a follow-up response. Use a bounded
wait (initially 2 seconds after the batch), not an unconditional sleep. Missing
usage is unknown, not zero. If the connection dies after a tool starts, await its
local outcome; never retry the browser mutation because transport failed. An
ambiguous outcome ends unfinished with evidence. Clean up source/forks on normal
exit and cancellation, and prevent retained rollouts/subscribers growing with
decision count. Journal before/after action boundaries support diagnosis, not
an exactly-once guarantee across process crashes.

Keep existing wall-clock and action budgets. Count inspection/invalid/no-call
responses as model decisions, not browser steps. For exploration, bound decisions
at `4 * steps + 20` as well as wall time; recording retains its deadline and an
internal 2,020-decision ceiling. Exhaustion records unfinished work, never pass.
All benchmark timeouts include model work, inspection and rollover. A long test
may increase the existing minutes budget; no extra CLI surface is required.

Protect active run directories from pruning: an exclusive per-run lease held
for the run lifetime, released on completion and safely recognized as stale
after process death. Retention applies to completed runs; concurrent runs must
not delete each other's history. Memory is scoped to one run, target and seeded
state. Existing cross-run finding hints remain hints, not live facts or browser
resume state. No new durable user-memory store.
Use a small owner marker in run output (host and PID), created before the run is
eligible for pruning. On the same host, prune only after proving the process is
absent; permission errors, another host or a reused live PID mean retain it.
Do not use an age timeout that can expire while a long run is still active.

## Accounting and release gates

Record per response: input, cached input, output, reasoning if supplied, missing
usage, latency, backend/model version, and action/inspection/rollover category.
Record per decision: epoch, context bytes by component, shared-prefix bytes,
retrieval count, action count, preparation and browser time. Include bootstrap,
failed responses and rollovers in totals. Avoid double-counting cumulative usage.
Keep the ordinary CLI output small; detailed metrics live in JSON/Debug.

1. **Deterministic contracts:** replay at least 2,000 synthetic decisions through
   many epochs; assert bounds, exact value recovery, corrections, omitted-task
   discoverability, no lost pending work, stable prefixes, stale-ref rejection,
   no duplicated mutation after transport failure, and bounded live resources.
   Include Unicode, huge tables/fields, injected instructions and concurrent
   pruning. This is a plumbing test, not evidence of actor competence.
2. **Short live regressions:** seven stories still record and verify; repeat the
   clean and planted-bug exploration matrix, not just one favourable run. Compare
   against a frozen pre-change baseline with the same app, seed, model and budget.
3. **Long live workflows:** three distinct scenarios at both 200 and 500 browser
   actions, three trials each (18 runs). Cover deferred cross-page work and exact
   record reuse; failed saves/auth interruptions and recovery without duplicate
   submissions; broad exploration with revisits and delayed defect checks. Require
   multiple memory rollovers and an early fact needed hundreds of actions later.
   Include one paginated search through evidence omitted from working memory.
   Use generated data/UI permutations; the actor receives goals, not a scripted
   action list. No filler clicks merely to reach a number. Also include a run
   with at least 200 model decisions: batched actions alone do not test that.
4. **Success gate:** fixture-owned final-state and event-log assertions score
   completed criteria, correct record identity, duplicate mutations, forgotten
   required work and planted findings independently of actor summaries. Require
   at least 17/18 completions, no false passes or duplicate irreversible actions,
   and every trial retrieves the required old fact correctly. Compare to the
   accumulating baseline; publish all failures and budget exhaustions. A baseline
   timeout counts, not a discarded sample. These are release gates, not promises.
   For an open-ended explore run, reaching its declared action/time budget is
   expected; score scenario coverage and the required delayed checks, not whether
   the actor called `done`. Budget exhaustion must not masquerade as story pass.
5. **Cache gate:** within an epoch, captured reusable-prefix bytes must remain
   identical except for appended events. For served-cache, non-rollover decisions,
   target uncached input no greater than volatile input + new events + 512 tokens
   on at least 95% of decisions. Instrument token attribution in the probe; byte
   estimates are insufficient for this claim. Classify misses, cold starts and
   rollovers separately but include all of them in cost/latency totals. Verify
   one session cache identity across forks/epochs on the installed backend.
   Define a served-cache decision before examining results: cached tokens cover
   at least the fixed tools/instructions prefix minus 256 tokens. Also publish
   the unconditional hit rate, so conditional coverage cannot hide poor reuse.
6. **Cost/latency gate:** interleave matched baseline/candidate trials. Report
   total tokens by billing class, uncached tokens, p50/p90 decision latency, total
   elapsed time and cost per successfully completed workflow. Use documented
   applicable rates if available, never equate token counts to money. Including
   rollover and misses, target no cost increase and at most 10% p90 decision
   latency regression, with correctness gates met. If rates are unavailable or
   completion differs, show raw counts and tradeoffs rather than claim savings.
   Without applicable rates, the cost gate requires no increase per successful
   workflow in any billed token class (uncached input, cached input and output).
   Otherwise the monetary gate remains unresolved. Missing usage also prevents
   a complete cost claim; report the missing-response count.
   Failure to meet a gate means investigate/tune and rerun affected comparisons;
   do not hide it by dropping misses or raising caps without recording the change.

## Alternatives and build boundary

- An unlimited append-only log is cache-friendly but not bounded and accumulates
  stale evidence. Retain it on disk, not entirely in each prompt.
- Rewriting a rolling summary every turn loses exact details and invalidates the
  changing prefix. Deterministic checkpoints plus append-only epochs avoid that.
- Keeping only a recent window forgets long-range obligations; retrieval and
  explicit memory are required. Retrieval alone also fails if the actor cannot
  tell there is something worth retrieving, hence tasks and omitted-item counts.
- Full conversation history or Codex's generic compaction delegates memory
  semantics to a component that does not know our evidence and completion rules.
- A vector store, background summarizer or planner agent adds machinery before
  literal search and explicit notes have demonstrated a deficiency.
- The measured private-home fork/HTTP approach stays preferred. Direct Responses
  remains unmeasured and requires a separate credential decision, not an implicit
  switch during implementation. No paid priority tier by default.

Build this before the grader item. Preserve its future ability to cite exact
step/page evidence without feeding it the actor's notes or reasoning. Its current
proposal to send every page also needs a separate long-evidence review; do not
claim this actor change makes the future grader bounded. Build plan gates,
not historical synthetic cache measurements, establish readiness to ship.
