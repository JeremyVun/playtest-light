# Asynchronous waits build plan

1. Browser action and cancellation: types, browser wait, check parsing,
   baseline ordering and action labels. Verify delayed/streaming DOM changes,
   cancellation and nonblocking timers. Done.
2. Actor scheduling: queue `wait_for` in recorder/explorer, complete the model
   decision before awaiting it, preserve action budgets, evidence and separate time.
   Verify model call ordering and replay with scripted integration tests. Done.
3. Live probe and documentation: real-model slow chat, full suite/typecheck,
   update usage/roadmap and record results. Done.

4. Owner simplification: remove `--minutes`, actor deadlines, countdown metadata
   and obsolete timeout handling. Verify Ctrl+C during a twenty-minute wait
   exits promptly and removes the browser process and profile. Done.

Verification: `npm run typecheck`; `npm test` (126 passed, one skipped).
Nine wait tests cover real browser streaming, heartbeat responsiveness, replay,
condition timeout, cancellation, navigation and recording/exploration scheduling. The live
Sol probe completed a 20-second response and two model-free verification replays;
see `design.md` for the measured results.
