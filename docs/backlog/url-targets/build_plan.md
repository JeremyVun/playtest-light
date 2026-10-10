# URL targets build plan

Owner waived the fresh-context requirement. Build sequentially; current pt
rename changes are already present and must be preserved.

1. **Done: config, CLI and target session.** Own types, project loading,
   CLI commands, seed execution and session/browser cleanup. Resolve flags once;
   seed before each fresh page; never start an app. Gate: typecheck and targeted
   precedence, seed and CLI tests.
2. **Done: evidence and render.** Own baselines, reports, explore history,
   URL-portable actions, render and removal of obsolete app lifecycle code.
   Gate: no-config/no-Git record and replay, JSON output, current-URL render.
3. **Done: fixture and verification.** Move sample seeds to test data;
   test-owned independent app processes replace production lifecycle helpers.
   Run all checks, fresh baseline recordings and planted-bug probes; measure
   replay speed with automatic browser cleanup.
4. **Done: docs and closeout.** Update README, project and roadmap plus
   actor-context/grader references. Record gates and limitations accurately.

## Verification (2026-10-10)

- Root typecheck passed. Sample data generation, build and typecheck passed.
- Final test suite: 93 tests, 92 passed, zero failures, one opt-in live-model
  transport test skipped. Actual Sol was separately exercised below.
- Seven stories recorded and accepted through actual Sol at the independently
  started sample URL on port 5401. Each passed both no-model verification replays.
  All seven then passed pt check in 6.4 seconds.
- Twenty-step busy-morning, ten command-to-exit runs: median 1827 ms, p90 1854 ms,
  including fresh browser startup and cleanup. No timing threshold was relaxed.
- Independent server on port 5402 with stale-list and console-error: add-task
  failed as expected, with the missing task, failed criterion and console issue.
- Actual pt render add-task --video: eight PNG frames, flipbook and MP4 produced.
  No app process was started or stopped by pt; both verification servers were
  stopped separately at the end of the work.
- Added wire-level CLI tests with no Git or config: explicit story paths,
  standalone accept, seeded record/check/render, seed invocation counts,
  infrastructure errors, JSON stdout purity, URL path/query/fragment and
  non-seeded exploration. Existing browser and exploration regression checks pass.
- Latest targeted and full checks passed after fixing a test-only macOS /var
  versus /private/var path expectation. No known unresolved implementation gate.

No backward compatibility with the old app config, lifecycle commands,
commit-based render or v1 baselines. The sample baselines are v2. Authentication
extensions, remote data reset and historical deployment provisioning are not
part of this change. The full historical unprompted explore matrix was not rerun.
