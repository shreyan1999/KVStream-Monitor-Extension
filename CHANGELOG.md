# Change Log

All notable changes to KVStream Monitor are recorded here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Sidebar is now just a menu**: the gateway's status word plus Dashboard / Logs / Settings. Service
  cards, stat cards, Quick Actions and logs moved out; they were already in the dashboard. The
  sidebar no longer receives log lines.

### Fixed

- **Foundry Local status lagged by 15 s to several minutes.** Daemon liveness is now polled on its
  own with `foundry server status` every `max(kvstream.refreshInterval, 3 s)`; the full CLI snapshot
  stays at 15 s.
- A slow first `foundry --version` (cold start) was reported as *CLI not found* and backed the
  Foundry poll off to two minutes. A timeout is now treated as slow, not missing.
- With the gateway down, a running Foundry daemon showed as **Unknown**. It now shows **Running**.
- After Foundry Local was stopped, the card kept saying **Serving**: plain `/health` answers from
  KVStream's readiness cache. A current *not running* from the CLI now always wins on the Foundry
  Local card (shown within ~0.3 s of `foundry server stop` in the live run).
- A booting daemon (`running: false`, `state: "initializing"` on CLI 0.10.3, for ~17 s) showed as
  **Not running**. It now shows **Starting**.
- With Foundry Local stopped or booting, its card and the Backend Health list kept showing the
  backend URL and model KVStream had last reported — a dead port and an unloaded model. They now
  read `n/a` / *Not loaded*, with "Foundry Local is not running" (or "is starting") as the reason.
- **KVStream took ~30 s to appear after Start, and request counts up to a minute.** The pollers kept
  the backoff they had earned while the gateway was down. An explicit refresh (every Quick Action
  does one) now resets backoff; `/status` keeps the normal cadence while a gateway this extension
  started is booting; and the moment `/status` answers, `/health` and `/metrics` are re-polled. Live:
  6.8 s from Start to the gateway showing, 4.3 s from a request to the Requests card.

### Added

- **Load model…** Quick Action and `KVStream: Load Foundry Local Model` command: pick a downloaded
  model and `foundry model load` it. Foundry Local starts with nothing loaded, so until now the Start
  buttons alone left the dashboard stuck on *Degraded / Not serving*. Offered only while the daemon
  runs.
- **No model loaded** state on the Foundry Local card, from KVStream's model inventory, with the
  Load model button highlighted. The degraded banner now gives KVStream's own explanation instead of
  "run a health check for KVStream's own explanation".
- **`npm run load-test`** (`scripts/kvstream-load.mjs`): phased real traffic through KVStream to
  Foundry Local — smoke, concurrency ramp, burst past the budget, streaming, refused requests — with
  the dashboard's expected readings and the gateway's `/status` figures printed side by side, and an
  exact check of `kvstream_requests_total` at the end. Not packaged in the VSIX.
- **Live end-to-end test** (`src/test/e2e/liveStack.test.ts`, opt-in with `KVSTREAM_E2E=1`): drives
  the dashboard's Quick Actions against the real Foundry Local and KVStream on the machine — start
  Foundry, start KVStream (checking it reports No model loaded), Load model…, send a real request,
  health check, stop both — and writes a
  JSON report with every state the dashboard showed. `activate()` returns a small test API only
  under the test runner.

## [0.0.1] — 2026-10-28

First working version.

### Added

- **Dashboard panel** in an editor tab: health header with an auto-refresh switch, KVStream and
  Foundry Local service cards, Quick Actions, six stat cards with sparklines and five-minute deltas,
  a time-axis throughput chart (5m / 15m / 1h), a request-distribution donut by route, a Backend
  Health list, and Live Logs with severity chips, search, pause and clear.
- **Sidebar view** in a dedicated Activity Bar container: Dashboard / Logs / Settings links, service
  cards, request stat cards, Quick Actions and the latest log lines, laid out for narrow widths.
- **Status Bar indicator** showing running and queued counts when the gateway reports them, and a
  neutral `disconnected` when it does not.
- **Monitoring core** polling `/health` + `/status` and `/metrics` on separate cadences, shared by
  every view so the request rate does not depend on how many views are open. Cycles never overlap,
  failures back off exponentially, and a stale response cannot overwrite newer data.
- **Prometheus text parser** and typed validators for `/health` and `/status`, written against the
  shapes in `microsoft/KVstream` rather than assumed.
- **Bounded trend history** for throughput, queue depth and budget utilisation, in memory only,
  with counter-reset detection and gap-aware chart rendering.
- **Foundry Local discovery** that prefers what KVStream reports, falls back to
  `foundry status --output json` and `foundry server status --output json`, treats a stopped
  daemon's `webUrls` as stale, and reports several candidates as ambiguous rather than picking one.
- **Host hardware** (GPU name, VRAM total, system memory) from the Foundry CLI, kept separate from
  the admission budget.
- **Process management** for a `kvstream serve` started by the extension: argv-array spawn with no
  shell, duplicate-launch prevention, exit tracking, and live stdout/stderr streamed into a bounded
  log panel with search, severity filter and pause.
- **Service controls** for KVStream (start / stop / restart, owned processes only) and Foundry Local
  (`foundry server start|stop|restart`), each confirmed with the target named, plus
  `kvstream calibrate` in an interruptible terminal.
- **Thirteen commands**, each declared in the manifest and registered in TypeScript, with a test
  asserting the two lists match.
- **Ten validated settings**, with out-of-range values clamped and reported rather than silently
  applied.
- **120 automated tests** — unit tests for every parser and derivation, and integration tests
  against a mock gateway covering healthy, degraded, backend-down, partial-metrics, missing-metrics,
  HTTP 500, invalid-JSON, slow-response, restart and rising-queue scenarios.

### Fixed after testing against a real KVStream 1.0.0 gateway

- `/health` runs a real generation (3.2 s observed) and, with no backend, stays open for over a
  minute while KVStream re-scans localhost. It now has its own deadline, back-off and poller,
  separate from `/status`, and a stall is explained rather than shown as an error.
- `backend.base_url` holds a default (`localhost:5273`) while `resolution.source` is `unresolved`;
  it is no longer shown as a discovered address.
- A counter with no traffic exposes no series; request counts now read 0 rather than n/a.
- `resolution.attempts` is parsed as a list of strategy names.
- Foundry Local 0.12.1 reports a live daemon as `state: "ready"`; liveness now comes from the
  `running` boolean.

### Notes on honesty of display

- A value the gateway did not report renders as `n/a` with the reason, never as `0`.
- The admission budget is labelled as a KVStream estimate and is never presented as GPU, VRAM or
  KV-cache memory. KVStream is a proxy and cannot read the backend device.
- Foundry Local is reported as *serving* only on KVStream's own trial-generation probe, never
  inferred from a process existing.
- Unsupported capabilities (live logs or stop/restart for a gateway started elsewhere) are disabled
  with the reason in their tooltip, not rendered as buttons that do nothing.

### Known limitations

- Verified end to end in VS Code against a real KVStream 1.0.0 gateway and Foundry Local CLI 0.12.1.
  Not yet run against the real CLI: Start launching the real `kvstream.exe` (verified with a stand-in),
  and `kvstream calibrate`.
- KVStream exposes no logs endpoint, so live logs require a gateway started by this extension.
- Node cannot deliver SIGTERM on Windows, so stopping a gateway there is abrupt rather than drained.
- Foundry Local does not expose live GPU utilisation, so only device totals are shown.
- No license has been chosen for this extension; see the README.
