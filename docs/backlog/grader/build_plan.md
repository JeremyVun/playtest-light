# Actor and grader split: build plan

Deferred by the owner, 2026-10-10; do not execute this historical plan. Completion
stays with the actor. See the updated status in design.md.

Builds `design.md` in this folder, after `docs/backlog/actor-context/` (it rewrites the actor loop this item builds on). Gates for every phase: `npm run
typecheck` clean, `npm test` green, the phase's live probe. Start sample apps independently on ports 5400+, never 5310; pass their URL and seed command to pt.

### Phase 1: grader core. **Done when** marked here.

Owns `src/run/grade*.ts`, the model layer's image input
(`src/model/`, `ModelThread.send` accepting images additively in
`src/types.ts`), tests.

- Evidence pack from a replay (steps, pages, issues, up to six viewport
  screenshots written to the run folder), the grader prompt and `verdict`
  tool, quote validation with one retry, keys, the `.runs/grades/` cache.
- Scripted-backend tests for quote rejection, keys and cache hits.
- Probe: grade the current `add-task` replay with real Sol, clean and with
  `BUGS=stale-list`; report verdicts, quotes and seconds per call.

### Phase 2: record, baseline v3, check outcomes. **Done when** marked here.

Owns `src/run/{actor,record,replay,baseline,report}.ts`,
`src/commands/{record,accept,check}.ts`, tests, the sample stories.

- `done({ summary })`, grading after the baseline replay, the two-round
  feedback loop, verdicts in baseline v3, `accept` showing them.
- `check`: key reuse, regrading stale criteria concurrently, pass / changed
  / fail, `--no-grade`, reports.
- Record the seven sample stories again and accept them.
- Probe: the design's "How we know it works" list except explore.

### Phase 3: explore. **Done when** marked here.

Owns `src/run/{explore,findings}.ts`, `src/commands/{explore,adopt}.ts`,
tests. Findings without checks, confirmed by replay plus grader; remove the
weak-evidence pass. Probe: the v1 explore scoring runs, before/after.

### Phase 4: docs. **Done when** marked here.

README, `docs/project.md` scores, `docs/roadmap.md` (milestone 5 partly
done), and the v1 design's check sections pointing here.
