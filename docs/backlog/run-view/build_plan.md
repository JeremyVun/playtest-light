# Build plan

1. Evidence and HTML: capture hooks in actor/replay/explore; static renderer; safe data insertion and partial error report. Verify real browser frames including failed actions and multiple phases. Done.
2. CLI and findings: run consolidation, read-only view, remove adopt and automatically persist findings; JSON and exit semantics. Verify no-model replay, explicit replacement, durable findings and prune survival. Done.
3. Integration: appropriate tests, typecheck, real local HTML browser drive and visual QA in this chat under Jeremy's model waiver; update README, project/roadmap/AGENTS. Done.

## Verification (2026-10-10)

- Typecheck passed. Full suite: 90 passed, 0 failed, 1 opt-in model test skipped.
  Removed obsolete standalone render tests; added real-browser static-file viewer
  tests and CLI tests for capture, explicit replacement, unchanged failing
  baselines, automatic durable findings, pruning, and failed reproduction seeds.
- Static HTML executed under file:// in real Chrome. Verified next/previous,
  phase selection, finding-to-step navigation, hostile script/HTML text escaping,
  absent screenshots, empty runs, and no document overflow at 1280px and 420px.
- Seven real sample stories all passed against a separately started clean app.
  Five complete 20-step CLI replays took 1843, 1817, 1830, 1924 and 1882 ms.
- A separate sample with stale-list and console-error failed add-task as expected.
  Actual Sol exploration (15-action budget) found both planted problems and
  reproduced them; all findings saved as Markdown/JSON in the sample's
  playtest/findings/20261010-034735-966-explore/ directory.
- Captured pass/failure/exploration HTML inspected visually. Moved the
  full summary into Debug and put findings in their own view. No expandables,
  accordions or disclosure triangles remain.
  Captured screenshots come from the actual execution, not a later render.
- A same-run MP4 was generated. No additional app replay is needed for video.
  All probe servers and browser processes were stopped after verification.

Sample inspection report (disposable):
fixtures/sample-app/playtest/.runs/20261010-034735-966-explore/index.html.

No hosted viewer, frontend dependencies, new config, issue acceptance state or
historical app provisioning was introduced. The next work remains actor-context
and the independent grader; neither is implied by this viewer.

4. Owner follow-up: keyboard accessibility and thumbnail filmstrip, with browser/visual verification. Done.

Verified real key input through CDP: Tab, Left/Right, Home/End, focus movement,
selected filmstrip item, selected view tab and finding-to-step navigation.
No details/summary elements or aria-expanded controls are emitted. Screenshots
were inspected at 1280×900 and 420×900; desktop screenshot/inspector/filmstrip
fit together without obscuring the capture. Targeted viewer and CLI suite:
7 passed after the final interaction changes.

5. Viewer correction after owner rejection: directly improve layout, reading scale, evidence hierarchy and findings; verify actual wide/laptop/mobile captures and keyboard/zoom behavior. Done.


The owner rejected the phase-4 appearance despite its passing tests. The
correction removes the stacked header rows, gives the capture more height,
moves step information into the inspector, omits empty evidence sections, and
places the raw action/snapshot in Page text. The filmstrip uses short two-line
labels with issue markers. Findings pair expected/observed text with a real
reproduction screenshot; draft stories remain directly linked in Debug.

Verification: root typecheck passed; viewer and CLI integration tests passed
(7 tests). The extended real-browser viewer test covers fit/width/actual size,
keyboard inspector tabs, draft-story navigation, hidden empty sections, capture
geometry and fixed filmstrip at 320, 420, 768, 1280 and 1904px. The final viewer
test passed again after responsive refinements. Inspected real sample captures
at 1904×961 (2x), 1280×900, 1280×800 and 420×900 in light/dark, including login,
failed checks, portrait captures, missing captures and Findings. On phones,
Fit width uses normal vertical scrolling without an empty fixed-height stage.
Wide and Findings screenshots are saved beside the demonstration report as
viewer-wide.png and viewer-findings.png. No app execution or model call was
needed to regenerate the reports from their existing evidence.json files.


6. Filmstrip timing, small copy icons, and normal-run cleanup. Done.

Each step shows its recorded settle time in ms or seconds; unknown timing is
an explicit dash and exact milliseconds are in the tooltip and inspector.
Copy icons sit inside text boxes, copy exact plain text, and give a brief
checkmark. Clipboard failures fall back to a selected temporary textarea;
failed copies announce failure rather than success. Viewer browser tests cover
zero, seconds, unavailable timing, clipboard success/fallback/failure, existing
keyboard behavior, escaping and layout. Typecheck and the 7-test viewer/CLI
suite passed; viewer checks passed again after the text-evidence fallback.

Normal runs omit an empty Findings tab. Debug shows the full copyable report
first instead of repeating the terminal output as bullets. Missing screenshots
show captured page text; phases with no screenshots use compact step cards.
Step findings link to the full finding without repeating its description, and
only the finding fields needed by the browser are embedded in script data.
Tab keyboard navigation is shared. No dependencies or services were added.
Real passing, failing, fast multi-story, Debug and phone views were captured and
inspected. Captures live beside their reports as viewer-passing.png,
viewer-failing.png, viewer-fast-run.png, viewer-debug-copy.png and
viewer-timing-phone.png. All reports were regenerated from existing evidence.


7. Complete normal-run review flow. Done.

Normal runs open on structured Results with actual runner verdicts, story
wall durations, failure reasons and explicit not-run/error rows. Failures come
first. Selecting a story opens its earliest failing step from the runner's
results, or its final checks when it passed. Steps shows screenshots and concise
evidence; fast runs without captures use an outcome card. Raw action, snapshot
and diff live in Debug. Failed checks come first, and View text difference
focuses the diff directly. Small copy icons remain inside each text box.

Filmstrip timings now measure page.goto/act/resize before evidence capture.
They include settling and browser checks, exclude model thinking and artifact
capture, and show settling separately. Older settle-only evidence shows an
unknown action duration rather than being relabelled. No framework, service,
config file, command or expandables were added.

Verification: root typecheck and full suite passed (90 tests; one opt-in
live-model test skipped). Viewer tests cover Results ordering, story navigation,
error/not-run rows, keyboard focus, direct diff navigation, failed-check order,
copy success/fallback/failure, timing and responsive geometry. Fresh sample CLI
runs: seven clean stories passed in 6.53 s; captured add-task passed in 1.35 s;
a captured stale-list run correctly failed add-task and busy-morning while the
other five passed (8.61 s). Failed seed produced one error and six not-run rows.

Inspected actual Results, failing steps, no-capture steps, Debug and error views
at 1280×900, 1904×900 dark and 420×900 light. Exercised keyboard Enter on a result,
reloaded a selected-step URL, navigated to its diff and successfully copied it
using the browser clipboard, then returned to Results and opened a passing
story's final checks. Phone filmstrip remains visible while evidence scrolls.
The reusable browser tests also cover 320px. All probe servers and browsers
were stopped.

Current demonstration: fixtures/sample-app/playtest/.runs/20261010-043425-955-run/index.html.
Captures alongside it: review-results.png, review-failure.png, review-debug.png,
review-phone.png, review-phone-step.png and review-wide.png. Fast passing view:
20261010-043417-845-run/review-fast.png. Error view:
20261010-043514-075-run/review-error.png. These are disposable local artifacts.


8. Simplify CLI help and prune unnecessary flags. Done.

Own src/cli.ts, the explore command's options, report references, README and
CLI regression tests. Root help lists outcomes only; per-command help and
validation share option definitions. Drop random-seed/fresh from the CLI and
no-seed from init. Verify installed-bin help, all help entry points, errors in
text/JSON, command-specific option rejection, and real URL integrations.


Verification: typecheck passed; 20 focused tests passed across installed-bin,
CLI help, URL run/explore, findings and initialization. After final error-copy
and option-order cleanup, all five installed-bin/help tests passed again.
Help aliases agree, every advertised option is accepted, help is available
with invalid local config, and unrelated/removed flags fail with exit 2 in
both text and JSON modes. All help lines fit within 80 columns. Manually checked
the installed /opt/homebrew/bin/pt with help, help run, help accept, view --help,
init --help and accept --url. No app or model starts for help or invalid flags.
README and exploration report output no longer advertise removed options.


9. Delete obsolete CLI implementation paths and preserve agent contracts. Done.

Simplify commands, recording ownership and baseline acceptance; remove unused
render callbacks and duplicate output writes. Test native CLI JSON/error behavior,
headless capture, baseline acceptance after failures, replay/record and exploration.


Removed standalone record run creation/view/report writing, legacy record-report
acceptance, unused onStep render hooks, repeated command arity checks, a one-use
report writer that wrote JSON twice, and the one-line acceptedLines wrapper.
Acceptance now uses a Story path and lives in baseline.ts; numeric validation
is shared without string/error unions or casts. pt run owns one final report.
No new runtime dependency, CLI framework or production file was added.

JSON capture uses --view without launching open/xdg-open. Tests replace those
commands with marker scripts, verify they were never called, and still inspect
real PNGs/HTML. JSON stdout matches the saved report, with the latter's kind
field. A literal --json after -- remains a positional, not output-mode detection.
Latest failed or corrupt reports cannot silently revive an older baseline.

Typecheck passed. Full suite: 95 passed, 1 opt-in live-model test skipped.
After final help copy, private helper naming and corrupt-report coverage,
21 relevant CLI/report tests passed again. Production source in the ten
reviewed CLI/report files decreased from 1129 to 1084 lines. Browser, seed,
recording, replay, findings and viewer behavior remain covered by real-browser
integration tests; no live model call was needed for this refactor.


10. Fix reproducible bugs in acceptance, retention, init and saved reports. Done.

Regression tests must fail before their fixes and pass afterwards. Verify
recording-in-progress acceptance with a real CLI subprocess held in its seed,
then terminate it and confirm the baseline stays protected. Test same-timestamp
creation/pruning with a fixed clock, existing ignore content preservation, and
explicit report paths with broken config. Run the full suite after fixes.


All four regressions were observed failing against the old implementation.
A graceful SIGTERM already produced a failed report; the confirmed acceptance
bug was concurrent accept while the replacement was blocked in its seed.
The run now checkpoints attempts before starting recording work, and lookup
uses the latest recording for a repeated story. This also leaves an explicit
attempt if the process exits before its final report.

Retention now sorts collision suffixes numerically and allocates after the
highest existing suffix rather than reusing pruned names. A fixed-clock probe
creates 23 runs, verifies unique names and checks that exactly the last 20
remain. Init appends the ignore rule without replacing existing content.
Explicit HTML files/directories resolve before loading unrelated config.

Final verification: typecheck passed; 99 tests passed, zero failed, one optional
live-model test skipped. The ignore-file test's path assertion was corrected
for macOS /var versus /private/var aliases before the final full-suite run.
No app, model or seed process from the regression probes remains running.
