# Slow chat fixture

A small streaming chat page for testing condition-based waits. No credentials,
database or model; the server returns fixed text after a configurable delay.

```sh
node fixtures/slow-chat/server.ts 20
```

The printed localhost URL serves the page. Enter a message and press Enter.
The first response fragment appears immediately; Send stays disabled until the
final fragment arrives. Pass `1200` instead of `20` for a twenty-minute response.

`node tools/probe-wait.ts <scratch-directory> 20` runs a real-model recording,
two model-free verification replays and a concurrent event-loop heartbeat. It
saves the report, exact context, trajectory and timings in the output directory.
