# Playtest Lite

A small CLI for agent-driven UI regression, bug finding and design hill
climbing: stories, baselines and seeds are committed; pt tests an already-running URL.
All findings are saved as text. Each run has a local HTML view; screenshots and videos stay in disposable output. The light successor to
`../playtest`. v1 is built: Jeremy's v1 brief verbatim,
rulings and design in `docs/backlog/v1/design.md`, phases and their status in
`docs/backlog/v1/build_plan.md`. The seam types are `src/types.ts`.

- UI rule: no expandables, accordions, `<details>` or disclosure triangles. Use visible content or separate views. Inspect real run captures at wide and narrow sizes and exercise the full results-to-evidence-to-debug flow; passing isolated interaction tests alone does not establish usability.
- How to install and use the tool: `README.md`. Keep root CLI help to a short command list; command help and accepted flags share one definition so option scope stays clear.
- What it is, the north stars, decisions, open proposals and Jeremy's brief
  verbatim: `docs/project.md`. Read it first.
- Milestones: `docs/roadmap.md`.
- URL/seed design, verification and Jeremy's brief: `docs/backlog/url-targets/`.
- Run/view simplification and automatic findings: `docs/backlog/run-view/`.
- Async UI waits, twenty-minute chat responses and the owner's nonblocking requirement: `docs/backlog/async-waits/`. No overall actor time limit or `--minutes` flag; users stop runs with Ctrl+C.
- The app the harness is tested against, with seeded users, planted bugs
  (`BUGS=`) and intended changes (`VARIANT=`): `fixtures/sample-app/`, see its
  `README.md`. `TEST_MODE=1 npm start` serves it on port 5310.
- Feature designs go in `docs/backlog/<feature>/` (backlog-item skill);
  interface contracts in `docs/contracts/` once there are interfaces.
- The parent project's concepts (record, act, heal, the drift oracle):
  `../playtest/docs/playtest-design.md`.
- Playtest's mechanisms are the default, not optional: a design that drops or
  changes one must say why. Where each stands: `docs/project.md`, "Playtest
  mechanisms". Long-session memory and cache requirements, including Jeremy's
  brief, live in `docs/backlog/actor-context/`; short cache spikes do not prove
  endurance or savings.
