# Sample app: team project tracker

A small, realistic SaaS-style single-page app that Playtest Lite is tested against. Start it separately, then point pt at its URL. Test fixtures live under playtest/, while the app owns its schema and reset endpoint. Test values only; nothing here is a real credential or payment.

Stack: React + Vite + TypeScript client, a tiny `node:http` + `node:sqlite` API (Node 26, no framework or ORM). One process serves the built client and the API on one port (default 5310).

## Commands

```sh
npm install
npm run seed        # builds data/template.sqlite from playtest/seed.ts (deterministic ids and content)
npm run build       # builds the client into dist/
npm start           # serves dist/ and the API on http://127.0.0.1:$PORT (default 5310)
npm run dev         # Vite dev server on :5311, proxying /api and /__test to the app on :5310
npm run typecheck
```

Typical test boot: `TEST_MODE=1 TEST_NOW=2026-04-01T12:00:00Z npm start`.

Reset to the seeded state in milliseconds (about 15 ms; a file copy from the template, no re-seeding; needs `TEST_MODE=1`):

```sh
curl -X POST http://127.0.0.1:5310/__test/reset
```

`pt` uses the seed command in `playtest/config.json` to call this endpoint before each replay. Override the target with `--url`; supply `--seed "node playtest/reset.ts"` explicitly when testing an alternate local port.

Reset also clears sessions, so sign in again afterwards. `data/` and `dist/` are generated and gitignored.

## Seeded credentials (test values only)

| Role   | Email                | Password        | Can do |
|--------|----------------------|-----------------|--------|
| admin  | admin@example.test   | admin-pass-1    | everything, including deleting tasks and upgrading the plan |
| member | member@example.test  | member-pass-1   | create, edit and complete tasks and projects; no Delete buttons; the Plan page says only admins can change the plan |

Session token is an HttpOnly `sid` cookie. Session tokens are derived from a counter, so they are deterministic after a reset.

## Seed data

34 projects (4 pages of 10), ids `prj-001`..`prj-034`, statuses active/paused/archived, each with 3 to 7 tasks (`prj-001` has 7), except:

- `prj-007`: a very long name (used by the `clipped` bug).
- `prj-031` "Legacy import": its task list endpoint always returns HTTP 500 (the error state).
- `prj-033` "Greenfield kickoff": no tasks (the empty state).

Not-seeded paths: `/projects/prj-999` shows a "Project not found" error state.

Test card for the fake billing step: `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` is declined by the server (HTTP 402). Nothing external is ever contacted.

## Routes

`/login`, `/projects` (query: `q`, `status`, `page`), `/projects/new`, `/projects/:id`, `/upgrade` (step 1 choose plan), `/upgrade/details`, `/upgrade/review`, `/upgrade/done`, `/settings`, anything else renders a 404 page. Unauthenticated visits redirect to `/login?next=...`.

Server-side validation paths: new project (name `Quiet Billing`-style duplicates give "A project with this name already exists"; key `API` is reserved), task form (title required, 120 chars max), settings name, billing details.

## Determinism and environment switches

| Variable | Effect |
|----------|--------|
| `PORT` | Listen port, default 5310 (127.0.0.1 only). |
| `DB_PATH` | Working database file, default `data/app.sqlite`; give each instance its own when running several. |
| `TEST_MODE=1` | Enables `POST /__test/reset`, disables CSS transitions/animations, and keeps only the latest toast until replaced or dismissed so replay does not depend on expiry timing. |
| `TEST_NOW=<ISO instant>` | Pins the server clock. The client takes "now" from `/api/bootstrap` (shown in the footer, used for "overdue" and created timestamps), never from `Date.now()`. |
| `?nomotion` | URL param that disables CSS transitions/animations without `TEST_MODE`. The dialog and toast keep real animations otherwise. |
| `LATENCY_MS` | Adds a fixed delay to every API call, to make loading states observable. Default 0. |
| `BUGS=a,b` | Planted defects (below). All off by default. |
| `VARIANT=a,b` | Intended UI changes (below). None by default. |

No randomness, no external network, no CDN fonts or assets. No `window.alert`, `confirm` or `prompt` anywhere; destructive actions use an in-app `role="dialog"`.

## Planted bugs (`BUGS=`)

| Switch | How it manifests |
|--------|------------------|
| `overlap` | A yellow "Feedback" button is fixed on screen. At widths of 700px or less it covers the "New project" button on `/projects` (verified at 420px wide), so clicks hit Feedback. At wider widths it sits bottom-right, clear of everything. |
| `clipped` | Project cards become 260px wide with `overflow: visible` and a nowrap title, so the long name of `prj-007` overflows its card (page 1 of `/projects`). |
| `console-error` | `console.error('TypeError: Cannot read properties of undefined (reading "sparkline") ...')` on mounting `/projects`. |
| `save-500` | Creating a task, and editing a task's fields, returns HTTP 500 and the dialog shows an error plus an error toast. Toggling completion still works. |
| `stale-list` | A created task is saved (toast says "Task created") but does not appear in the list until the page is reloaded. |
| `dead-link` | An extra "Reports" nav link goes to `/reports`, which renders the 404 page. |
| `slow` | `GET /api/projects/:id/tasks` takes 3 seconds (the loading state shows for 3 s on every project page). |

## Variants (`VARIANT=`)

| Switch | Intended change |
|--------|-----------------|
| `rename-cta` | The "New task" button (and dialog title) becomes "Add task". |
| `reorder-nav` | Main nav order is reversed: Settings, Plan, Projects (instead of Projects, Plan, Settings). |
| `new-field` | The task form gains an optional "Estimate in hours (optional)" field (validated server-side, 0 to 999). |

Bug and variant switches combine freely (`BUGS=slow,clipped VARIANT=rename-cta`). They are read once at server start; restart to change them.
