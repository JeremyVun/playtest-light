# URL targets and optional seeds

## Rulings (2026-10-10)

The app is an already-running URL, including localhost. Playtest owns its
browser and test data, not app startup, deployment or database provisioning.
One optional `playtest/config.json`; flags override defaults. No environment
registry or second config file. Seeds are commands supplied by users or agents,
with scripts and fixtures alongside stories. No database-specific interface.
No backward compatibility is required. All four build phases are complete;
verification is recorded in build_plan.md. Historical app reconstruction is removed
from this change; render replays against the supplied URL. The owner explicitly
waived the backlog skill's fresh-context requirement for this build.

## Interface

`pt explore [url]`, `pt record <story>`, `pt check [story...]`, and
`pt render <story>` accept `--url`, `--seed <command>`, and `--no-seed`.
`explore` calls its existing randomness option `--random-seed`.
`init --url <url> [--seed <command>]` writes only those defaults, the existing
ignore file and an example story. `accept` and `adopt` remain. Remove
`up`, `down`, `status`, app `--env` overrides, and render's commit selectors.
Keep existing useful command options; add no provisioning or environment flags.

Minimal config: `{ "url": "http://localhost:3000", "seed": "node playtest/seed.js" }`.
Browser and model settings remain optional with existing defaults. Missing URL
is an actionable input error. Only HTTP(S) targets are valid. The URL's path,
query and fragment are the initial explore location; story paths resolve against
the supplied URL normally. Conflicting positional URL and `--url` are errors.

Config discovery uses the nearest playtest directory, or `--project`. No Git
checkout or config is required for a URL-only run; otherwise use cwd/playtest
for local test data and disposable output. An explicit Markdown story path is
accepted by record/check/render; its baseline remains beside it. No new story
format or per-story seed setting. Config is never written implicitly.

`--seed` and `--no-seed` are mutually exclusive. A saved seed is used only
when the resolved URL matches its saved URL (canonical URL equality). Changing
the target disables that saved seed; an explicit seed always wins. The seed
command executes locally, with stdin closed, before navigation at every fresh
story/replay, including recording verification, finding confirmation and slow
step retries. No seed means no reset, not a claimed clean database. Failures
abort with infrastructure exit code 2; timeout is 60 seconds. Child output
must not corrupt JSON stdout. Config commands run from the directory containing
playtest/; flag commands run from invocation cwd. Inherit process environment
and provide PLAYTEST_URL. Credentials belong in the invoking environment, not
persisted connection strings. Seeding restores existing data; it is not app
startup. No automatic hostname-based restriction is needed: explicit commands
are user-owned and the intended use is local data.

The browser is an internal resource. Start and close it automatically per run,
including failures. Do not stop externally started app processes. Remove the
warm-browser lifecycle interface along with the app lifecycle commands; measure
the resulting cold-browser overhead rather than claiming old warm timings.

## Evidence and scope

Keep no-model replay, normalized accessibility comparisons, fingerprint
warnings, mechanical checks, and replay confirmation. Without a seed the
same checks still run, but reports record that state was not reset. No weaker
confirmation shortcut. Run reports identify the resolved target and seed status.
Explore history is partitioned by target, seed command and goal, so different
sites do not share findings. Normalize same-origin recorded navigate actions to
paths, so accepted baselines can replay against another URL.

New baselines identify their target URL and whether seeding was used. They do
not infer the deployed app's commit from the test-data checkout. Remove mandatory
Git metadata; increment the format version and rerecord sample baselines.
Coordinate the grader backlog with this version change (its version 2 was only
a plan). `render` produces current screenshots/flipbook/video with no model;
no worktree, old commit launch, before/after orchestration, or pretend historical
provenance. Regenerating exact historical evidence requires the matching app
version and data to be supplied externally; a URL alone cannot guarantee it.

Keep raw CDP, batched actor actions, assertions, determinism verification,
mechanical issue checks, clocks, disposable artifacts and stable baselines.
Actor-context and independent grader work are separate and remain unimplemented.
This change deliberately removes v1 app setup/cache/worktrees and historical
rendering because they violate the agreed tool boundary. It adds no hosted
services, auth system, database adapters, or framework-specific detection.

## Sample app and verification

Move the sample data fixture under playtest/, leaving schema in the app.
Keep an app-owned reset endpoint to reload its database safely; a Playtest-owned
seed command calls it. Starting/building the sample app is documented and
performed outside pt. Tests may own server startup/teardown as fixture code,
but production CLI code must not do so. Use isolated ports 5400+, never 5310.

Verify precedence, seed cwd, failing/timeout seeds, repeat restoration, JSON
purity, no-Git/no-config operation, URL path/query handling, and no cross-target
history. Run typecheck, the suite, CLI probes with an independently served app,
and seeded record/check/render plus planted-bug regression. Rerecord all seven
sample stories with the actual model if available; report unavailable gates
truthfully. Do not rewrite unrelated actor/grader functionality.

## Jeremy's brief, verbatim

> i think one of the value adds is i want the ability to run pt against an actual remote url.

> yea, like im not convinced that we should need pt up, pt down, pt status. that sounds like application management is bleeding into pt. am i wrong?

> well the thing is, local is just a localhost url...

> yea, and for data seeding, either we introduce an environment concept to pt, or just have have a flag like --seed with an url to a postgres db or something (locally it'd be running in a docker container). I think the seed should be part of the playtest data, not the app. same way the storeis and baselines are part of the playtest data.

> im assuming you're talking about reworking the config.json for this? i dont want another config file, and i want our configs to be really minimal. and not bloated. We wouldn't be seeding anything other than local anyway.
>
> What's wrong with just using --seed command? Then i dont need to play around with configs, i (or an agent) can create a seed and pass it directly to the cli? Or maybe just follow the pattern where you can configure it in config.json if you want for the env, but also overwrite stuff with flags. Basically, while humans will run this, it will be run mostly be an agent s it needs to be agent friendly

> yep cool proceed. keep the cli surface small and simple

> do not be concerned with backwards compat, the tool is still in development.

> ignore the command to start build stage runs in a fresh context
