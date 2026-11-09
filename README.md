# KVStream Monitor

A Visual Studio Code extension for watching [KVStream](https://github.com/microsoft/KVstream) — the
OpenAI-compatible admission gateway that sits in front of Microsoft Foundry Local — without leaving
the editor.

It shows gateway and backend health, request and queue counts, admission-budget utilisation,
throughput and queue-depth trends, and the live output of a gateway it started itself. Everything it
displays comes from an endpoint KVStream actually serves; anything the gateway does not report is
shown as `n/a` with the reason, never as `0`.

---

## What you get

| Surface | What it does |
|---|---|
| **Dashboard** (editor tab) | Header with overall health, an auto-refresh switch and last-updated time; KVStream and Foundry Local service cards; Quick Actions; six stat cards (Requests, Running, Queue, Admission budget, Memory, GPU) with sparklines and five-minute deltas; a time-axis throughput chart (5m / 15m / 1h); a request-distribution donut by route; a Backend Health list; and filterable Live Logs. |
| Activity Bar → **KVStream** | A compact menu: the gateway's status word (hover it for the connection error, if any) and Dashboard / Logs / Settings links. Everything else lives in the dashboard. |
| Status Bar | `KVStream: 8 running · 2 queued`, or a neutral `disconnected`. Click it to open the dashboard. |
| Command Palette | Fourteen `KVStream:` commands — see [Commands](#commands). |
| Settings | `kvstream.*`, validated on read — see [Settings](#settings). |

Both views render the same sample from one shared poller, so they never disagree.

> **Screenshots.** Captured during verification but not embedded: the Marketplace rewrites relative
> image links against a `repository` URL, and none is set yet. See
> [What has and has not been verified](#what-has-and-has-not-been-verified).

---

## Quick start

This is the exact sequence used to verify the extension against a real KVStream 1.0.0 gateway and
Foundry Local CLI 0.12.1 on Windows.

**You need:** VS Code 1.140+, Python 3.10+, Git, and Foundry Local. The extension itself needs
nothing else.

### 1. Install the extension

```bash
code --install-extension kvstream-monitor-0.0.1.vsix
```

Or in VS Code: **Extensions: Install from VSIX…** and pick the file. A **KVStream** icon appears in
the Activity Bar and `KVStream: disconnected` in the Status Bar until a gateway is running.

### 2. Install KVStream (once)

KVStream is not on PyPI; install it from source, ideally in a virtual environment:

```bash
git clone https://github.com/microsoft/KVstream
cd KVstream
python -m venv .venv
.venv\Scripts\activate        # macOS/Linux: source .venv/bin/activate
pip install -e .
```

### 3. Start Foundry Local with a model loaded

```bash
foundry server start
foundry model list --cached          # models already downloaded
foundry model load qwen2.5-0.5b      # or any model you have; `foundry model download <alias>` first if not
```

KVStream reports *serving* only when a model is loaded, because it proves readiness with a real
one-token generation. Foundry Local starts and restarts with **nothing loaded**, so once the monitor
is open you can also do this step from **Quick Actions → Foundry Local → Load model…**.

### 4. Start the gateway

In the same terminal as step 2:

```bash
kvstream serve
```

It binds `http://127.0.0.1:8080` (the extension's default `kvstream.url`), finds Foundry Local's
ephemeral port itself, and auto-detects the model when exactly one is loaded.

Alternatively, start it **from VS Code** with the dashboard's **Start** button. Set
`kvstream.kvstreamPath` to the `kvstream` executable inside the virtualenv first (for example
`C:\path\to\KVstream\.venv\Scripts\kvstream.exe`). Started that way, its output streams into
**Live Logs** and Stop/Restart work.

### 5. Open the monitor

Click **KVStream: … running · … queued** in the Status Bar, or the KVStream Activity Bar icon →
**Dashboard**. Within a couple of seconds both cards should read **Running** / **Serving**.

### 6. (Optional) Generate some traffic

From this repository, with KVStream serving (dashboard **Healthy**):

```bash
npm run load-test              # every phase, about 3 minutes
npm run load-test -- --quick   # every phase, about 1 minute
```

`scripts/kvstream-load.mjs` (Node 18+, no dependencies) sends real chat completions through
KVStream to the Foundry Local model, in phases, and prints what the dashboard should show during
each one beside the gateway's own `/status` figures:

| Phase | What it does | What the dashboard shows |
|---|---|---|
| `smoke` | 3 sequential requests, replies printed | Requests +3 |
| `ramp` | closed-loop load at concurrency 1, 2, 4, then the admission budget | Running steps 1 → 2 → 4 → 8; budget 13 % → 100 %; throughput rises |
| `burst` | 3 × budget requests at once (2 × with `--quick`) | Running pinned at 8, Queue jumps and drains |
| `stream` | streaming chat at concurrency 4, time to first token reported | Running ≈ 4 |
| `errors` | an unknown model and a malformed body, both refused | Requests +1 (a malformed body is refused before KVStream counts it); health stays Healthy |

Run one phase with `--scenario <name>`; see `--help` for `--max-tokens`, `--burst`,
`--step-seconds`, `--model` and `--url`. It ends by reading `kvstream_requests_total` before and
after, and says what the **Requests** card should read. Every prompt is unique, because KVStream
merges identical concurrent requests and that would hide the concurrency being tested.

Measured on an RTX 2070 with `Phi-3-mini-4k-instruct-generic-gpu:2` and `--quick`: 130 requests,
0 failures, p50 1.6 s, ~72 tokens/s, gateway peaks of 8 running and 8 queued, and the counter delta
matching exactly.

KVStream's own `kvstream bench --concurrency 12 --total 240 --max-tokens 48` also works, as a
single flat load.

### If something is off

| You see | Do this |
|---|---|
| `disconnected` | Step 4 isn't running, or `kvstream.url` points elsewhere (**KVStream: Configure Endpoint**). |
| *"/health is not answering in time…"* with Foundry **Not running** | Step 3. KVStream holds `/health` open while it searches for Foundry Local. |
| **Degraded**, Foundry **Not serving** | No model loaded: `foundry model load <alias>`. |
| Live Logs empty | Expected for a gateway started in a terminal — KVStream has no logs endpoint. Use **Start** in the dashboard to get live logs. |

---

## Prerequisites in detail

- **VS Code 1.140 or later.**
- **KVStream** — monitoring works against a gateway started anywhere: a terminal, a service manager,
  another machine. Starting one *from* the extension is optional.
- **Foundry Local** — optional for the extension (it adds backend discovery and the Memory/GPU
  cards), required by KVStream itself. Verified against CLI **0.12.1**.

---

## Development setup

```bash
npm install
npm run compile      # type-check, lint, bundle with esbuild
npm test             # 135 tests in a real VS Code host (the live suite below is skipped)
npm run vsix         # produce kvstream-monitor-0.0.1.vsix
```

**Live end-to-end test.** With Foundry Local *stopped*, a model in its cache and port 8080 free:

```bash
KVSTREAM_E2E=1 npx vscode-test --run out/test/e2e/liveStack.test.js --timeout 1200000
```

It drives the dashboard's Quick Actions (each step delivers the exact message the button posts):
starts Foundry Local and KVStream, checks the dashboard reports **No model loaded**, picks
`KVSTREAM_E2E_MODEL` (default `Phi-3-mini-4k-instruct-generic-gpu:2`) in **Load model…**, sends a
real chat completion, runs Health check, then stops both and leaves Foundry Local as it found it. The report, with every state the dashboard showed,
goes to `KVSTREAM_E2E_OUT` (default `%TEMP%/kvstream-e2e/e2e-report.json`).

To debug: open this folder in VS Code and press **F5** (the *Run Extension* configuration). A second
window — the Extension Development Host — opens with the extension loaded. Edits rebuild through the
`watch` task; use **Developer: Reload Window** in the host to pick them up.

---

## Configuring the endpoint

The one setting that matters is `kvstream.url`: the base URL of the **gateway**, default
`http://127.0.0.1:8080`. It is not the Foundry Local address — KVStream discovers that itself and
reports it, which is why this extension never asks for it.

Set it from the Command Palette (**KVStream: Configure Endpoint**), the gear icon in the sidebar
title bar, or Settings. Only `http` and `https` are accepted; anything else is rejected with a
message rather than failing later.

### Verifying connectivity

1. Run **KVStream: Check Health**. It calls `/health?probe=true`, which forces the gateway to run a
   real trial generation rather than answering from its readiness cache.
2. A success notification names the model. A warning names what is wrong, using the gateway's own
   `hint` field.
3. If nothing answers, the sidebar shows `Disconnected` (hover it for the connection error) and the
   dashboard shows the error with a hint.

---

## What the dashboard shows, and where each number comes from

Every figure is traceable to a documented endpoint. The contracts below were read from
`microsoft/KVstream` at `src/kvstream/app.py`, `src/kvstream/observability/metrics.py` and the
dataclasses they serialise.

### Health

| Field | Source |
|---|---|
| Gateway state | HTTP status of `GET /health` — **200 means serving, 503 means degraded**, and both carry the same JSON body. A 503 is data, not an error. |
| Foundry Local state | `backend_reachable` (answered `/v1/models`) and `backend_serving` (completed a bounded trial generation), reported separately. |
| Backend endpoint | `backend_url`, plus `backend.resolution.source` from `/status`. |
| Model | `model` and `model_source`. |
| Circuit breaker | `circuit_breaker.state`. |

A process existing is never taken as evidence that Foundry Local is serving. The gateway is the only
thing that probes it with a real generation, so the gateway is the only authority the UI uses — a
stalled runtime answers `/v1/models` in 4 ms while completing nothing, which is exactly the failure
this distinction exists for.

### Requests

| Tile | Source |
|---|---|
| Processed | Sum of `kvstream_requests_total` over every route and outcome (one increment per request). |
| Running | `admission.active` from `/status`, or the `kvstream_active_requests` gauge. **A count of requests.** |
| Queued | `admission.waiting`, or `kvstream_queue_depth`. |
| Served | Outcomes `served` + `cache_hit` + `coalesced`. |
| Errors | Outcome `error` only. `client_error` is a malformed request and says nothing about service health, so it is excluded. |
| Rejected | Outcome `rejected` — shed or queue-full refusals. |

Throughput is derived from `kvstream_requests_total` and elapsed time between samples. A counter
that goes backwards means the gateway restarted, and no rate is reported for that interval rather
than a spike or a negative.

### Admission budget

`admission.budget`, `admission.in_flight`, `admission.utilization` and `admission.unit` from
`/status`, falling back to the `kvstream_budget` / `kvstream_in_flight` /
`kvstream_budget_utilization` gauges.

> **This is not GPU memory.** KVStream's admission budget is a configured request count
> (`concurrency` mode) or a *calibrated token estimate* (`tokens` mode). KVStream is a proxy: it
> runs no model, owns no KV tensors and cannot read the backend device. The dashboard labels it
> "KVStream admission budget" and keeps it visually and semantically apart from the host hardware
> section.

`budget_source` tells you where the number came from — `configured`, `calibration:exact`,
`calibration:partial`, or `fallback:concurrency` — and `runtime_profile.regime` reports what the
calibration sweep found (`serialising`, `batching`, `capped`, or `unknown`).

### Memory and GPU cards (dashboard only)

From `foundry status --output json`: system memory used of total (the **Memory** card's percentage
and bar), GPU name, and GPU total video memory. These are real device figures and have nothing to do
with the admission budget.

**The GPU card shows total VRAM, not a utilisation percentage, because Foundry Local does not
expose GPU usage.** The card says so on its face. Adding a cross-platform GPU-usage dependency to
fill it with a number was declined.

### Request distribution

The donut splits `kvstream_requests_total` by its `route` label (chat, completions, embeddings,
transcriptions). With no counters it reads `n/a`; with counters but no traffic, "No requests yet".

### Trends

Throughput (blue) and running requests (purple) on one time axis, with 5m / 15m / 1h ranges, from a
rolling in-memory window (`kvstream.historyWindow`, default 1 hour) that is never written to disk.
The legend states both units. A gap longer than two and a half metric intervals is drawn as a break,
not joined — a straight line across a disconnect would read as a steady value when nothing was
measured. The stat cards' arrows are the change over the last five minutes of that same history,
and are hidden whenever the current value is unavailable.

### Uptime

KVStream reports no uptime, so the KVStream card shows one only for a gateway started from this
extension (time since spawn). Foundry Local's uptime comes from `foundry server status` and is shown
only while the daemon reports itself running — the CLI keeps the old value after it exits.

### Auto refresh

The dashboard switch pauses polling entirely. A banner says the figures are from the last sample and
the last-updated time turns amber once it is stale. **Refresh** still takes a one-off sample.

---

## Logs

**KVStream exposes no logs endpoint.** Its routes are `/health`, `/status`, `/metrics` and the
`/v1/*` proxy surface, and nothing else. So the live-log panel streams the stdout and stderr of a
`kvstream serve` process **this extension started**. When the gateway was started anywhere else
there is nothing to stream, and the panel says so instead of showing an empty list.

The panel has search, a severity filter, pause/resume, and a bounded buffer
(`kvstream.logBufferSize`, default 2000 lines). Auto-scroll follows the tail while you are at the
bottom and stops when you scroll up; a **Jump to latest** button returns you.

**"Clear view" empties this extension's buffer only.** It cannot delete anything service-side, and
once a line is dropped it is gone — there is no endpoint to fetch history back from.

---

## Service controls

### KVStream

KVStream's CLI is `serve | health | status | calibrate | bench`. There is **no stop and no restart
subcommand**, so stopping it means terminating a process id.

- **Start** spawns `kvstream serve` with `spawn(…, { shell: false })` and an argv array. It is
  disabled while any gateway already answers at `kvstream.url`, since a second one would only fail
  on the port bind.
- **Stop** and **Restart** are available **only for a gateway this extension started**. Terminating
  a pid we did not start, chosen because its command line looked right, could kill anything; the
  buttons are disabled with that reason in their tooltip instead.
- **Ownership policy:** a gateway started from here is stopped when the extension deactivates. This
  is stated in the start confirmation. Nothing else knows the pid, so leaving it running would
  strand a process you could not address.
- On POSIX, stopping sends `SIGTERM` and KVStream drains in flight requests. **On Windows, Node has
  no SIGTERM to deliver** — `kill()` calls `TerminateProcess` — so the shutdown is abrupt and
  in-flight requests are cut off. The confirmation dialog says so.

### Foundry Local

**Start**, **Stop** and **Restart** run `foundry server start|stop|restart` with an argv array and
no shell. All three are confirmed first, and the stop/restart confirmations say that Foundry Local
is a machine-wide service other applications may be using, and that it takes a new ephemeral port on
almost every restart.

**Load model…** lists the models in Foundry Local's cache (`foundry cache list --output json`), with
size, device and whether each is loaded, and runs `foundry model load <id>` for the one you pick.
Foundry Local starts and restarts with no model in memory, and KVStream cannot serve until one is
loaded, so this is the step between **Start** and *Healthy*. It is offered only while the daemon is
running, because on CLI 0.10.3 both commands start a stopped daemon as a side effect. KVStream picks
the model up on its next `/health`; no gateway restart is needed. When the dashboard sees the
gateway up but nothing loaded, the Foundry Local card reads **No model loaded**, the banner says so
in KVStream's own words, and the button is highlighted.

### Calibrate

**KVStream: Calibrate Admission Budget** opens a terminal running `kvstream calibrate`. It is a
terminal rather than a progress notification because calibration drives a real load sweep through
the backend for up to a minute and you should be able to watch and interrupt it.

Every control is disabled while another operation is in progress, so a repeated click cannot start a
second operation.

---

## Foundry Local discovery

In priority order:

1. **What KVStream reports** — `backend_url` from `/health`, `backend.base_url` and
   `backend.resolution` from `/status`. This always wins: it is the endpoint traffic actually goes
   to, and second-guessing it would show an address nothing uses.
2. **The Foundry CLI** — `foundry status --output json` (`service.webUrls`) and
   `foundry server status --output json`. Used only when the gateway reported nothing.

Whether the daemon is up is re-read with `foundry server status` alone every
`max(kvstream.refreshInterval, 3 s)`, so starting or stopping Foundry Local from anywhere shows on
the Foundry Local card within seconds. The full snapshot (version and hardware) is taken every 15 s.
With the gateway down, a live daemon is shown as **Running** — not *Serving*, which only KVStream's
readiness probe can establish.

No port is ever assumed. Specific cases:

- **CLI not installed** → the connection section says so; discovery relies on KVStream alone.
- **Daemon not running** → `foundry server status` still reports the *previous* session's
  `webUrls`. Those are shown as stale and are **not** offered as an endpoint.
- **Several candidates** → reported as ambiguous with all of them listed, rather than picking one.
  Pin it with `kvstream serve --backend-url`.
- **CLI disabled** (`kvstream.enableFoundryCli: false`) → no processes are spawned for discovery.

---

## Commands

| Command | Notes |
|---|---|
| `KVStream: Open Monitor` | Reveals the Activity Bar view. |
| `KVStream: Open Dashboard` | Opens (or reveals) the editor-tab dashboard. |
| `KVStream: Refresh` | Polls every source now. |
| `KVStream: Check Health` | `/health?probe=true` — forces a fresh readiness generation. |
| `KVStream: Configure Endpoint` | Validated input box; writes `kvstream.url`. |
| `KVStream: Start Service` | Spawns `kvstream serve`. Confirmed. |
| `KVStream: Stop Service` | Owned process only. Confirmed. |
| `KVStream: Restart Service` | Owned process only. Confirmed. |
| `KVStream: Start Foundry Local` | `foundry server start`. Confirmed. |
| `KVStream: Stop Foundry Local` | `foundry server stop`. Confirmed, with a shared-service warning. |
| `KVStream: Restart Foundry Local` | `foundry server restart`. Confirmed, with a port-change warning. |
| `KVStream: Load Foundry Local Model` | Pick a downloaded model; `foundry model load <id>`. Daemon must be running. |
| `KVStream: Calibrate Admission Budget` | `kvstream calibrate` in a terminal. Confirmed. |
| `KVStream: Open Output Channel` | Extension diagnostics. |

---

## Settings

| Setting | Default | Notes |
|---|---|---|
| `kvstream.url` | `http://127.0.0.1:8080` | Gateway base URL. `http`/`https` only. |
| `kvstream.refreshInterval` | `2000` | `/health` + `/status` period, ms. Clamped to 500–300000. |
| `kvstream.metricsRefreshInterval` | `5000` | `/metrics` period, ms. Clamped to 1000–600000. |
| `kvstream.requestTimeout` | `3000` | Per-request timeout, ms. |
| `kvstream.historyWindow` | `3600000` | Trend window, ms. In memory only. |
| `kvstream.logBufferSize` | `2000` | Max buffered log lines. |
| `kvstream.kvstreamPath` | `kvstream` | Executable path. Run with no shell. |
| `kvstream.kvstreamArgs` | `[]` | Extra `serve` arguments, one per array entry. |
| `kvstream.foundryPath` | `foundry` | Executable path. |
| `kvstream.enableFoundryCli` | `true` | Off disables all CLI process spawning. |

Invalid values are replaced by the default or clamped, logged to the output channel, and summarised
in one notification. Executable paths containing shell metacharacters (`& | ; < > ` $ " '`) are
rejected outright.

---

## Performance

One poller serves every view: the sidebar and the dashboard open together produce exactly the same
request rate as one of them, and both render the same sample. Polling stops entirely when no view is
visible. Cycles never overlap — a slow gateway is polled less often rather than queued behind — and
consecutive failures back off exponentially, so a gateway that simply is not running costs almost
nothing. The backoff never delays a change you caused: Refresh and every Quick Action reset it, a
gateway started here is polled at the normal rate while it boots, and the first `/status` answer
re-polls `/health` and `/metrics` at once. Metric history and the log buffer are both bounded by count and by
time.

---

## Security

- The webview runs under `default-src 'none'` with a per-document script nonce and
  `connect-src 'none'`. It has no network access; every HTTP request happens in the extension host.
- Only the two asset folders are reachable from the webview (`localResourceRoots`).
- Every message from the webview is validated against an action allowlist with per-action payload
  checks before anything acts on it. An unknown action is logged and dropped.
- Nothing from the gateway is ever inserted as HTML. Model ids, URLs, hints and log lines are
  written with `textContent`.
- No process is ever launched through a shell. `spawn` is called with an argv array and
  `shell: false`.
- No credentials are read, stored or displayed. KVStream has no authentication of its own, and
  `/status` and `/metrics` disclose operational data — treat the endpoint as internal, as the
  KVStream README advises.
- Trend history and logs live in memory only; nothing is written to disk or sent anywhere.

---

## Troubleshooting

| Symptom | What it means |
|---|---|
| `disconnected` | Nothing is listening at `kvstream.url`. Start the gateway, or fix the URL. |
| `degraded` with a hint | The gateway is up; the backend is not serving. The hint is KVStream's own text — usually "load a model" or "restart Foundry Local". |
| Foundry Local **No model loaded** | Foundry Local is up but has nothing in memory — normal right after Start or Restart. Use **Quick Actions → Load model…**. |
| Counts show `n/a` | This gateway build did not report that field, or `/metrics` is unreachable. Hover for the reason. The dashboard never substitutes `0`. |
| Charts empty | Fewer than two metric samples so far. They appear within a couple of poll cycles. |
| Logs panel empty with a note | The gateway was not started by this extension, and KVStream has no logs endpoint. |
| Stop/Restart disabled | Same reason. Hover for the tooltip. |
| Foundry buttons disabled | The `foundry` executable was not found, or `kvstream.enableFoundryCli` is off. |
| Foundry Local goes **Not running → Starting** by itself after Stop | KVStream is restarting it, not this extension. KVStream 1.0's model inventory runs `foundry cache list`, which on Foundry CLI 0.10.3 starts a stopped daemon (seen in 2 of 3 live runs, ~3 s after Stop). Stop KVStream first. |
| "settings were invalid" | Open the **KVStream Monitor** output channel; each rejected setting is named. |

---

## Known limitations

- **No logs endpoint upstream.** Live logs require a gateway started from this extension. This is a
  KVStream API limitation, not an implementation gap.
- **No stop/restart of a gateway started elsewhere.** KVStream has no such CLI command, and
  terminating a pid matched by name is not safe.
- **Windows shutdown is abrupt.** Node cannot deliver SIGTERM on Windows, so KVStream's graceful
  drain does not run there.
- **No live GPU or VRAM utilisation.** Foundry Local reports device totals only.
- **Only one gateway at a time.** `kvstream.url` is a single endpoint.
- **No persisted history.** Trends reset when the window closes.
- **`kvstream calibrate` was not run against the real CLI** — see below.

---

## What has and has not been verified

**Implemented and tested** — API response parsing, Prometheus parsing, metric derivation and unit
semantics, route distribution, throughput and counter-reset handling, bounded history, settings
validation, error classification, polling-overlap prevention and backoff, webview message
validation (including the auto-refresh and navigation actions), log buffering and level detection,
status-bar text, backend-endpoint selection: **120 automated tests, all passing**, including
integration tests against a mock gateway that reproduces the documented contract (healthy, degraded
503, backend down, partial metrics, missing `/metrics`, HTTP 500, invalid JSON, slow responses,
gateway restart, rising queue depth), and contract tests over **payloads recorded from a real
KVStream 1.0.0 gateway**.

**Verified end to end against real KVStream and Foundry Local** — KVStream 1.0.0 installed from
`microsoft/KVstream` and run with `kvstream serve`, in front of Foundry Local CLI 0.12.1 serving
`qwen2.5-0.5b-instruct-generic-gpu:4`, with `kvstream bench` driving 12 concurrent requests. In the
packaged extension inside VS Code, the dashboard showed:

- the gateway version and the backend's real ephemeral port, discovered by KVStream
- the auto-detected model, and Foundry's uptime
- requests climbing with route distribution, and throughput charted
- Running pinned at 8 by the budget, the queue filling, and "8 of 8 slots used"

Running against the real gateway found five things the source-derived fixtures had not, all now
fixed and covered by tests:

1. **`/health` can take seconds or not answer at all.** It runs a real generation (3.2 s observed),
   and with no backend it stays open for over a minute while KVStream re-scans localhost. `/health`
   now has its own longer deadline and its own back-off, and is decoupled from the 2-second
   `/status` poll. When it stalls, the dashboard says why using KVStream's own words instead of
   showing an error.
2. **`backend.base_url` is a default, not a discovery.** It reads `http://localhost:5273` while
   `resolution.source` is `unresolved`, so it is no longer shown as the backend address.
3. **A counter with no traffic has no series.** `kvstream_requests_total` prints only its `# TYPE`
   line until the first request. It now reads as 0, not n/a.
4. **`resolution.attempts` is a list of strategy names, not a count.**
5. **Foundry's live daemon state is `"ready"`, not `"running"`.** The daemon is now judged by the
   CLI's `running` boolean.

**Verified inside VS Code, from the packaged VSIX** — the `.vsix` was installed into an isolated
VS Code 1.143.1 profile and driven by hand:

- activation; the Status Bar item; the Activity Bar sidebar; the dashboard opened from the status bar
- both views showing the same figures from the same sample
- healthy, disconnected and stopped states; the auto-refresh switch; Health check; and the sidebar's
  Dashboard, Logs and Settings links
- the log severity filter
- the whole owned-process lifecycle: **Start** (with its confirmation) → live log streaming with
  level colouring → **Stop** (with its confirmation) → the process verified gone and the port freed

For the lifecycle test the gateway was a **stand-in** for `kvstream serve`: `kvstream.kvstreamPath`
pointed at Node.js, so the extension spawned exactly `<exe> serve` with no shell, as it would the
real CLI.

**Verified against the Foundry Local CLI 0.12.1** — the Memory/GPU cards, and both the stopped and
running daemon states. Checks included version detection, `foundry status --output json` (GPU name,
VRAM total, system memory), `foundry server status --output json`, and classifying a stopped
daemon's leftover `webUrls` and `uptime` as stale rather than live.

**Verified end to end through Quick Actions (2026-11-04)** — Foundry Local CLI 0.10.3, KVStream
1.0.0 (`kvstream.exe` on PATH), `Phi-3-mini-4k-instruct-generic-gpu:2` on an RTX 2070, VS Code
1.145.0 Extension Development Host, using the live end-to-end test above. The Quick Actions were
exercised by delivering each button's message to the open dashboard's host (no desktop automation
was available to move a mouse), so everything after the click is the real path: confirmation,
`foundry server start|stop`, spawning the real `kvstream serve`, and the dashboard's view of it.
9 of 9 steps passed. Measured from the third run:

| Step | What the dashboard showed |
|---|---|
| Foundry Local → Start | **Starting** 3.1 s after the click; **Running** 0.1 s after the command finished (~20 s) |
| KVStream → Start | gateway visible 6.8 s after the click; **Healthy / Serving** with version, model and KVStream-resolved backend URL |
| Real chat completion | counted on the Requests card 4.3 s later; route donut 100 % chat |
| Health check | "KVStream is serving (Phi-3-mini-4k-instruct-generic-gpu:2)." |
| Foundry Local → Stop | **Not running** 0.35 s after `foundry server stop` returned, with the gateway still up |
| KVStream → Stop | **Stopped** immediately; process gone, port 8080 free |

The first run of that test found the backoff and cached-`/health` problems listed in the
CHANGELOG, and the KVStream daemon-restart behaviour in [Troubleshooting](#troubleshooting).

**Not yet verified against the real CLI** — **Calibrate** (`kvstream calibrate`, which drives a
minute of load through the backend and was not run).

**Not implemented** — a logs panel fed by an API (no such endpoint), stop/restart of an externally
started gateway (no such command), live GPU utilisation (not exposed), multi-gateway monitoring
(out of scope).

---

## License

**Not yet chosen.** No `LICENSE` file is included and `package.json` declares no license, because
the copyright holder for this extension has not been established. KVStream itself is MIT; that says
nothing about this extension. Add a `LICENSE` file and a `license` field before distributing it.

Marketplace publishing is a separate, explicit action and is not configured here: it needs a
publisher account and a Personal Access Token, neither of which belongs in this repository.
