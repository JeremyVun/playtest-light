# Actor context verification, 2026-10-10

Local working-tree implementation, Sol (gpt-6.1-sol), Codex CLI 0.160.0,
Node 26.8.2, macOS arm64. Runs use private Codex sessions and isolated databases.
Artifacts are under `/tmp/pt-context-live.4lX0nX`; prompts are in each run's
context.jsonl, fixed tools/instructions in context-header.json, and exact events
in trajectory.jsonl. The early probes predate header capture.

## Short story probes during implementation

These are successive implementations, not paired trials against the old
accumulating actor. Every row is included; token counts are not monetary savings.

| Probe | Decisions | Input | Cached | Uncached | Output | Wall ms | Peak context data bytes | Replay |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| first | 7 | 38229 | 22016 | 16213 | 724 | 47181 | 9239 | pass |
| refined | 8 | 39868 | 13440 | 26428 | 850 | 37836 | 5996 | pass |
| lean | 6 | 25037 | 12160 | 12877 | 637 | 32586 | 5350 | pass |
| final-lean | 6 | 24436 | 9728 | 14708 | 613 | 33104 | 4625 | pass |
| final-verified | 8 | 33133 | 14592 | 18541 | 670 | 39549 | 5309 | pass |

All used the same 20-action busy-morning story. The final verification used
eight decisions; the previous lean probe used six. Both passed, but their
cached/uncached token mix differed. In particular, final-verified has more
uncached input than first despite lower total input. This does not establish
lower cost. Cache preservation by the harness and service cache hits are
separate measurements.

## Normal stories

Seven fresh real-model recordings, each with two model-free replay passes:

| Story | Actions | Decisions | Wall ms | Replay |
|---|---:|---:|---:|---|
| add-task | 7 | 5 | 20721 | pass |
| browse-projects | 8 | 5 | 23063 | pass |
| busy-morning | 20 | 8 | 40422 | pass |
| change-display-name | 6 | 4 | 17868 | pass |
| create-project | 8 | 4 | 21511 | pass |
| member-permissions | 6 | 5 | 26323 | pass |
| upgrade-plan | 12 | 6 | 27865 | pass |

## Deferred exact-value workflows

Read an existing task title, rename it out of the UI, create 45 or 100 new
uniquely named high-priority completed tasks, then use the original title in
the final task's Notes. An independent database oracle checks identity, count,
uniqueness, priority, completion and the exact remembered value.

| Probe | Actions | Decisions | Rollovers | Peak context data bytes | Input | Cached | State oracle | Replay |
|---|---:|---:|---:|---:|---:|---:|---|---|
| long-45 | 234 | 11 | 1 | 21555 | 66480 | 39296 | pass | FAIL |
| long-100 | 509 | 11 | 3 | 26768 | 69022 | 38784 | pass | FAIL |
| stable-long-45 | 234 | 9 | 1 | 20018 | 49304 | 22016 | pass | pass |
| stable-long-100 | 509 | 12 | 2 | 26602 | 78075 | 33408 | pass | pass |

The first two replay failures came from the fixture's expiring toasts. Under
TEST_MODE it now retains only the latest toast until replacement/dismissal;
normal app behaviour is unchanged. Fresh 234- and 509-action recordings pass
both replays. No drift tolerance was relaxed. Rebuilding the seven existing
golden action sequences changed only two busy-morning snapshots, then all
seven independently checked clean. Large batches mean these runs alone do
not prove hundreds of model decisions.

## Exploration

| Fixture | Actions | Decisions | Findings | Input | Cached |
|---|---:|---:|---|---:|---:|
| explore-clean | 48 | 16 | none | 89741 | 51328 |
| explore-planted | 49 | 23 | Console error on /projects (reproduced); Created task missing from task list (reproduced) | 133640 | 85376 |

Both finished without transport errors. These are one clean and one planted
trial, not the entire earlier exploration matrix.

## Forced-turn endurance

`tools/probe-context-queue.ts` serves a controlled order-review UI. Each
submission reveals the next record's previously unseen ID, amount and stock;
the actor must classify it and enter the corresponding code. It also retains
an exact Unicode reference from the first page for the final form. This is a
controlled endurance fixture, not a broad usability scenario.

- 202 model decisions, 402 browser actions, three checkpoint replacements.
- All 200 records correct; zero rejected submissions or failed actions.
- Exact original reference recovered, and both deterministic replays pass.
- 892,245 ms total; 833,241 ms actor time. Decision p50 3971 ms; p90 4659 ms.
- Peak harness context data 14,151 bytes; fixed tools/instructions are additional.
- Input 1,081,863; cached 874,624 (80.8%); uncached 207,239; output 12,191.
- Zero unknown-usage responses and zero within-epoch prefix violations.

The run started before the final removal of duplicate successful-batch lines
and placeholder text; those reductions were verified in subsequent short probes
and deterministic tests. Backend hits varied, including stretches caching only
the tools. The aggregate cache share is measured, not a guarantee or a paired
cost result. Per-epoch metrics are saved in queue-200/metrics.json.

## Context inspection and automated checks

Root and fixture typechecks pass; the fixture builds. The final full suite
has 118 passing tests and one optional live-model test skipped. Separate real
model probes above supply the live coverage.

Captured prefixes remain byte-identical plus appended events within an epoch.
Only rollover replaces the checkpoint. Exact old values remain in the archive,
and retrieval paginates without splitting UTF-8 characters or mixing versions.
Synthetic tests exercise 2,000 decisions across many rollovers. Browser tests
cover oversized pages, dialogs, exact long labels and stale references while
leaving normalized snapshot output unchanged. Transport tests cover concurrent
calls, interruption, cancellation, late/missing usage and connection loss after
a mutation has started. A deadline stops the next batch action, not the one
already executing. Active run output survives pruning.

Trace review removed obsolete conversation instructions, duplicated memory
schemas, old page bodies, successful-action repetition, empty evidence sections,
placeholder snapshots and unnecessary timer digits. Search returns short excerpts
with exact ID reads. Validation errors and browser issues remain visible; a
regression test catches their accidental suppression. Historical-ref masking
only touches actual control markers, preserving values such as Order [e42].

## Viewer token metrics

Fresh artifacts: `/tmp/pt-view-tokens.0q6NbY`. The recording ran through the normal
command path; exploration used the existing live probe with planted stale-list
and console-error bugs. Both use the actual model.

| Run | Decisions | Peak full input | Total input | Output | Cached input | Result |
|---|---:|---:|---:|---:|---:|---|
| busy-morning recording | 8 | 4623 | 33178 | 707 | 12160 | Two verification replays passed |
| exploration | 18 | 6494 | 101534 | 1462 | 56960 | Both planted findings reproduced |

Evidence totals exactly match context statistics. Decision IDs associate batches
with their frames without duplicating run usage. Checks/final decisions without
new actions attach to the latest frame. Failed usage is retained when supplied;
unknown usage displays a dash or partial total, never a fabricated zero.

Inspected real captures at 1440×1000 and 420×900. Exercised normal Results and
exploration Findings → Steps → Debug, exact usage copying, and narrow scrolling.
No horizontal overflow. Existing keyboard/escaping/missing-evidence tests pass
with token metrics present. Full suite: 119 passed, one optional live-model test
skipped. Root typecheck passes.

## Remaining comparative work

The proposed 18-run multi-scenario matrix, paired accumulating/candidate cost
and latency comparison, per-item token-attribution cache gate, and peak retained
backend-resource audit are not complete. No broad reliability or cost claim is
made from these scoped checks. The backlog item remains open.
