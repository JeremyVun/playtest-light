# Run evidence and automatic findings

2026-10-10. Continue in this chat under Jeremy's explicit fresh-context waiver.

## Owner brief, verbatim

> why is there a separate pt render? can we not combine pt record and pt check into a pt run?

> im curious about explore.. my instinct tells me that you need a user story to create paved roads. are you saying explore can actually find bugs and so on absent that? How does it know if something is a bug or not? Also, do we need accept and adopt as separate things? I'm also trying to figure out how a human is even supposed to make a considered decision to accept and adopt? Do we have any kind of visual feedback back to the human to help them make that decision?

> why do we need "adopt"? if we adopt, where are the issues recorded? why not just auto record all issues found. the pt tool doesn't need to manage whether an issue is accepted or not, that is a different concern.
>
> and yes, i'd like a local html view of the run. If only for debug purposes ../playtest had something like this with the playtest view. we should have something like that here as well, but keep it light and minimal.

## Additional owner brief

> is it too complicated to have keyboard accessibility and the film strip?

Add a compact thumbnail filmstrip with action labels, selection, and horizontal
scrolling. Keyboard: Tab between controls, Left/Right between steps, Home/End
first/last, native keyboard phase selection, visible focus and accessible labels.
Use a single step navigator, not duplicate text and thumbnail lists.

## UI ruling

> also, as a first principle, i would like to ban the use of expandables (i noticed you like to do this alot with the triangle expandables).

No expandables, accordions or disclosure triangles. Run, Findings and Debug are
separate keyboard-accessible views; each exposes its content without disclosure
controls. The filmstrip is the single step navigator. Run inspectors use ordinary
scrolling for lengthy snapshots. This supersedes the first viewer's expandables.

## Model ruling

Jeremy waived the Opus requirement after its expired OAuth login blocked visual work:

> ignore that stuff, you can just do it yourself as astra

The primary agent implements and verifies the viewer in this chat.

## Behaviour

Public commands: init, run, explore, accept, view. run replays existing baselines without a model; missing baselines or --record play the story and verify it twice. --accept saves only a deterministic pending baseline. Existing failures never silently record replacements. No backwards compatibility commands. accept remains exclusively a baseline operation, with no finding approval workflow.

Every exploration saves all findings to playtest/findings/<run-id>/findings.json and findings.md, including reproduction status, weak evidence, expected/actual, steps and draft story text. These files survive pruning .runs. No automatic story enrolment, deduplication service, issue state or issue tracker. Reproduced means the condition happened again, not that product intent has been established.

Every run/exploration writes index.html and evidence.json in its disposable run directory. Static file, inline script/styles, relative screenshots, no server, external assets, framework or config. Retain Markdown/JSON results. Viewer is a minimal port of the parent's trajectory viewer: step navigation, screenshot, action/URL/timing, accessibility snapshot, checks/issues/diff, run summary and findings. It is read-only. Use existing parent viewer/flipbook visual grammar rather than a new design direction; visual implementation and QA run in this chat under the model waiver above.

Record/explore capture each original action (including failed ones) and verification phase separately. Fast replay collects text evidence and failure screenshots; --view or --video captures every step. --view opens the finished HTML, --video derives an MP4 from captured frames (no additional execution), and pt view [run-directory-or-index.html] opens existing evidence without touching the target. Default pt view selects the newest run with a view. Missing screenshots are stated plainly. No claim of historical pictures: baseline snapshots are text, screenshots show this actual run.

Exit codes 0 success, 1 failed story, 2 input/infrastructure error. JSON stdout stays clean. Multi-story run produces one report; per-story phase reports can be linked. Findings paths and viewer paths are returned for agents. Retain partial evidence on errors where a run directory was created. HTML treats app/model text as data and escapes it. Durable finding writes must not overwrite a previous run.

## Viewer correction (2026-10-10)

Jeremy rejected the first viewer screenshot:

> really. you think this is acceptable?

> Do not stop until the app UI is acceptable for a human to use. Don't use design comps.. just improve it

Improve the actual viewer directly under the existing model waiver. Compact
header and navigation, a larger readable capture with fit/actual-size controls,
step details beside the capture, relevant evidence without repeated empty
sections, page text in a separate view, and readable filmstrip labels. Preserve
keyboard access, local static HTML, all raw evidence and the no-expandables rule.
Verify the real report at the rejected wide viewport, laptop and phone sizes,
in light and dark appearance. A passing interaction test alone is not visual QA.


Implemented: Fit image, Fit width and Actual size; phone views default to Fit
width. The filmstrip stays reachable while the image/evidence scroll. Empty
checks/issues/diffs are omitted; raw actions and accessibility text remain in
Page text. Findings show reproduction captures and link to their matching run
step and draft story in Debug. File links live in Debug. No additional runtime,
server, frontend dependency or CLI command was added.


## Filmstrip timing and simplification (2026-10-10)

> time per step is really important. can that be added to the filmstrip? Also, keep going to see if there's anything that can be made simpler, cleaner, lighter

Show recorded settle duration on every thumbnail, in milliseconds below one
second and seconds above it, with an explicit missing state. Keep exact
milliseconds in the tooltip and selected-step detail. This is the existing
page-settle measurement, not model thinking time or total command duration.
Keep labels and timing visible on phones in a compact filmstrip.
Remove duplicated finding descriptions from step cards; retain the full finding
and direct link. Embed only the finding fields used by the viewer script.


> Keep in mind as well that a user is going to most likely want to copy the debug text and paste it into their own agent session, so if you can add a simple copy feature that'd be great.

> nono just hae a small "copy" icon in the text box or whatever.

> also, how does it look for normal runs that aren't explore?

Each text box has a small copy icon, including the report, draft stories,
actions, page text and diffs. It copies that box's exact plain text, shows a
brief checkmark, and supports local-file clipboard restrictions with a fallback.
No separate copy toolbar. Normal runs with no findings omit the Findings tab.
Verify and show both a passing captured replay and a failing replay.


The Debug view puts the full report first with its copy icon; it no longer
repeats terminal output as a long bullet list above the report. If no detailed
report exists, show the summary text instead. Original summary data remains in
evidence.json. Shared tab navigation replaces duplicated keyboard handlers.


For fast runs without screenshots, the main area shows captured page text with
a copy icon. A phase with no images uses compact step cards rather than eight
identical empty thumbnails. Unavailable image-size controls are omitted.


## Complete review flow (2026-10-10)

> and is that UX acceptable?

> then why have you stopped? don't stop until the UX is acceptable.

Normal runs start on structured Results: each requested story has its real
runner verdict, duration, completed steps and reason. Failures appear first;
the longest measured story is marked. Selecting a row opens a relevant step,
with a persistent Results tab to return. Infrastructure failures and stories
not run are explicit, never inferred as passing from an empty trace.

Steps keep screenshots and outcome/check evidence. Without a screenshot,
show a compact outcome card, not an empty canvas or raw accessibility tree.
Raw actions, snapshots and diffs live in Debug with copy icons and a direct
Inspect step data link. This supersedes the previous page-text fallback.

Capture action duration around page.act/goto/resize before recording artifacts.
Filmstrip timing uses this full action duration, including settle and browser
checks, excluding model thinking and evidence capture. Preserve settle as a
separate measurement in the step detail. Never relabel old settle-only data as
full duration. Verify fresh real replays and the complete Results-to-step-to-
Debug navigation in a browser, not merely individual controls.


## CLI simplification (2026-10-10)

> I need you to take a look at simplifying the CLI. remove everything that isn't needed. I have no idea what all those things at the bottom like target, evidence, common, defaults are about. does it mean i can do pt accept --url? it's very very confusing. tidy this up PROPERLY

Top-level help is a short command list, with no shared flag categories or
long flag-heavy usage lines. Each command has its own complete, plain help,
examples and valid options. pt help <command> and pt <command> --help agree.
Parser options and displayed options come from one definition. Reject flags
that do not apply to the command, with concise error output and the relevant
help command; preserve JSON errors for agents. Help needs no config or app.

Keep run, explore, view, accept and optional init because their outcomes are
distinct. Keep recording/baseline replacement explicit, URL/seed overrides,
bounded model work, local evidence and agent output. Remove exploration's
random-seed/fresh CLI tuning; exploration still varies plans and uses prior
findings automatically. Remove init --no-seed, which has nothing to disable.
Keep deterministic exploration controls internal for tests. Reports must not
recommend removed CLI flags. No new config or compatibility aliases.


## Implementation cleanup (2026-10-10)

> now, in terms of the actual CLI code, can you tidy things up? what can be deleted? keep in mind, this CLI will be used mainly by an agent as well (an agent like you)

Delete duplicate positional validation, unused render callbacks, one-use
report wrappers and the standalone recording/report lookup path left from the
removed record command. pt run owns the run report and recording evidence;
recordStory owns the actor and verification. Baseline persistence belongs with
baseline code, not a cross-command dependency. Share numeric option validation
without creating a CLI framework. Keep lazy command imports, native argument
parsing, no prompts, clean JSON and exit codes. In JSON mode --view captures
and returns the HTML path but does not launch a desktop app. Baseline replacement
still requires a verified recording, and a failed latest attempt prevents
falling back to an older recording.


## Bug audit (2026-10-10)

> Fine bugs and fix any that you find

Reproduced stale baseline acceptance during an in-progress replacement,
incorrect same-millisecond run ordering/name reuse after pruning, missing
.runs ignore rules when init encounters an existing .gitignore, and explicit
report viewing being blocked by unrelated invalid config. Fix each against
its failing regression. Recording attempts must be durable before any model,
seed or browser work starts; the final report replaces that checkpoint.
This keeps one report file while preventing concurrent acceptance of stale work.
