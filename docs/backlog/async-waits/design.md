# Asynchronous UI waits

Owner request, 2026-10-10, verbatim:

> typical example will be the actor enters some text into a chatbox, presses enter, and then the rsponse might genuinely take like 20 minutes to come back. The actor might choose to go and do other things on the app while waiting, or it could wait for 20 minutes for the response.

> yea ok, as long as it doesn't block the thread. proceed

Clarification, verbatim:

> hang on, what i mean is the actor can literally pause and wait if it wants to e.g. waiting on that hook. but programmatically i dont want that wait to block or spin the thread if there is other work that needs to be done by the harness. understand waht i mean. basically an async await or whatever

## Contract

Owner correction, verbatim:

> what?? why do i need to set --minutes 30?

> why is that flag even needed? seriously, get rid of all the stupid complications that are not needed

> if the user wants to kill it, they should just be able to cntrl + c

Remove `--minutes` and the overall actor deadline, rather than hiding a fixed
timeout behind the CLI. Ctrl+C cancels a run and cleans up its browser. Waits
retain their own condition timeout; exploration retains its action budget.

One actor tool, `wait_for`, accepts observable conditions and a maximum duration
in seconds. The actor pauses; the harness uses asynchronous timers and browser
reads, leaving the Node event loop free. No background monitor IDs, extra CLI
commands, or configuration file. To work elsewhere instead, the actor simply
continues taking actions and waits later if needed.

The tool queues the wait and returns immediately. The model decision settles
before the recorder/explorer awaits the browser condition. There are no model
calls during waiting. All conditions must hold on two consecutive observations;
the checks run at most four times per second. Navigation must not accidentally
satisfy disappearance checks. Closing the page cancels pending waits. Errors,
timeouts and completion are distinct observations; a timeout does not retry the
submission or declare the app broken.

Waits support the existing checks plus enabled/disabled controls. The default
maximum is 60 seconds, with explicit waits up to 24 hours. There is no overall
run time limit or additional flag needed for a twenty-minute response.

Successful waits are recorded as condition-based browser actions, including
the maximum wait, and replay without a model. The actual elapsed wait is not a
fixed sleep in the baseline. Wait time is recorded separately from network
settling and model time; expected waiting does not become an automatic slow-page
finding. Waits count as steps, including explorer action budgets. Baseline
snapshots retain their existing semantics.

Completion remains the actor's responsibility. The independent grader is
deferred following the owner's experience with its tuning cost.

## Verification

Exercise delayed text, streaming, enabled/disabled buttons, already-satisfied
conditions, timeout, navigation and cancellation on a real browser. A concurrent
heartbeat must keep running during waits. Verify recording and exploration wait
outside model decisions, budgets, context events and model-free replay. Run a
real-model slow-chat recording and inspect the saved trajectory and timing.

Implemented and verified, 2026-10-10. The prior fresh-context waiver applies.

`node tools/probe-wait.ts <output-directory> 20` exercised a real Sol actor against
the streaming fixture. It finished in 72.7 seconds including two successful
model-free replays, with exactly one submission per execution. The actor made
three decisions: act, wait_for, done. The wait decision finished before the
10.6-second browser wait started; no model calls occurred during that wait.
The concurrent 50 ms heartbeat ticked 1,429 times, with a largest gap of 87 ms.
The fixture took 20 seconds per response; this was not a twenty-minute endurance
run. Automated tests separately exercise a twenty-minute requested timeout,
prompt cancellation and a stalled browser read. The subsequent removal of the
overall deadline is covered by recording/exploration without a time option,
absence of a countdown in model context, and a CLI interrupt during a pending
twenty-minute wait that checks exit status, browser process and profile cleanup.

After removing the overall deadline, the full suite passed (126 passed, one
skipped), as did TypeScript checking. Ctrl+C cancelled the pending twenty-minute
wait with exit code 130 and removed both the browser process and temporary profile.
The disposable live evidence was written to `/tmp/pt-wait-live.wHU6rj/`.
