# Discovered API contracts

What this extension relies on, where each contract came from, and how confident we are in it.

Sources read: `microsoft/KVstream` at `main` (shallow clone, 2026-10-28) — `README.md`,
`src/kvstream/app.py`, `src/kvstream/cli.py`, `src/kvstream/observability/metrics.py`,
`src/kvstream/admission/{__init__,capacity,drift}.py`,
`src/kvstream/backend/{health,foundry,inventory,resolver}.py` — and the **Foundry Local CLI 0.12.1**
installed on this machine, run live.

Update, 2026-10-28: KVStream **1.0.0** was then installed from source and run live, both with
Foundry Local stopped and in front of Foundry Local serving `qwen2.5-0.5b`. Everything marked
*source* below matched on the wire, with the exceptions recorded in
[Observed only on a live gateway](#observed-only-on-a-live-gateway).

Confidence levels:

- **source** — read from the gateway's own code. Exact, but not observed on the wire.
- **live** — observed by running the real thing here.

---

## KVStream HTTP surface

| Endpoint | Status codes | Confidence |
|---|---|---|
| `GET /health` | **200 serving, 503 not serving — same body both ways** | source |
| `GET /health?probe=true` | forces a fresh readiness generation, rate-limited to one per `readiness_force_min_interval_seconds` (5 s) | source |
| `GET /status` | 200 | source |
| `GET /metrics` | 200, Prometheus text exposition | source |

Errors use the OpenAI envelope: `{"error": {"message", "type", "code", "param"}}`.

### `/health` body

```
status              "ok" | "degraded"
backend_healthy     bool   liveness; kept for compatibility, equals backend_reachable
backend_reachable   bool   answered GET /v1/models
backend_serving     bool   completed a bounded trial generation
readiness           {ready, detail, latency_seconds, age_seconds, probed}
circuit_breaker     {enabled, state, consecutive_failures, trips, fast_failures,
                     last_error, retry_after_seconds}
drift               {state, baseline_seconds_per_token, observed_seconds_per_token,
                     ratio, worst_ratio, samples, warn_ratio}
backend_url         str
model               str | null
model_source        str
version             str
hint                str    present only when not serving
```

`circuit_breaker.state` is `closed` | `open` | `half_open`.
`drift.state` is `unknown` without a calibration record.

### `/status` body (fields this extension reads)

```
version
admission        {unit: "tokens"|"concurrency", budget, in_flight, utilization,
                  waiting, max_queue_depth, active, overshoots, reclaimed, draining,
                  queue: {depth, head_cost, oldest_wait_seconds, admitted, timed_out,
                          rejected, peak_depth},
                  drain_rate_per_second, completions, queued_cost, hopeless_rejections}
audio_admission  same shape, separate limit for transcriptions
budget_source    {source, key, lookup?}
                 source ∈ config | configured | calibration:exact | calibration:partial
                          | fallback:concurrency
runtime_profile  {regime: serialising|batching|capped|unknown, detail}
model            {id, source, inventory: {downloaded[], loaded[], age_seconds, types{}}}
backend          {base_url, configured_url, discover, pinned, scans, resolutions,
                  usage_reporting, resolution: {url, source, detail, attempts},
                  foundry_cli}
backend_health   {reachable, readiness, circuit_breaker}
drift            as above
routes           {chat, models, embeddings, transcriptions, completions}
token_estimator  {samples, ...}
cache            {enabled, ...}
coalescer        {enabled, inflight, coalesced_total, streaming}
```

**Unit trap.** `admission.budget` and `admission.in_flight` are in `admission.unit`: request slots
in `concurrency` mode, *estimated KV tokens* in `tokens` mode. `admission.active` is a count of
requests. The extension reads `active` for "running requests" and never `in_flight`.

### Metric names

Counters (labels in braces):
`kvstream_requests_total{route,outcome}` — outcome ∈ `served`, `cache_hit`, `coalesced`,
`rejected`, `error`, `client_error`, `abandoned`, `cache_miss`; **one increment per request**;
`kvstream_rejected_total{route,reason}`, `kvstream_cache_hits_total`,
`kvstream_cache_skipped_total{reason}`, `kvstream_coalesced_total`,
`kvstream_backend_errors_total{phase}`, `kvstream_reservation_overshoot_total`,
`kvstream_reservation_reclaimed_tokens_total`.

Histograms: `kvstream_request_seconds{route}`, `kvstream_admission_wait_seconds{route}`.

Gauges: `kvstream_budget`, `kvstream_in_flight`, `kvstream_budget_utilization`,
`kvstream_queue_depth`, `kvstream_active_requests`, `kvstream_chars_per_token`,
`kvstream_token_ratio_samples`, `kvstream_discovery_scans`, `kvstream_calibration_age_seconds`,
`kvstream_circuit_breaker_state`, `kvstream_backend_ready`, `kvstream_backend_up`,
`kvstream_backend_drift_ratio`, `kvstream_audio_budget`, `kvstream_audio_in_flight`,
`kvstream_audio_queue_depth`.

### Capabilities that do **not** exist

- **No logs endpoint.** The route table is `/health`, `/status`, `/metrics`, `/v1/chat/completions`,
  `/v1/completions`, `/v1/embeddings`, `/v1/audio/transcriptions`, `/v1/models`,
  `/v1/models/{id}`. Nothing else.
- **No stop or restart in the CLI.** `kvstream serve | health | status | calibrate | bench`.
  Shutdown is Ctrl+C or SIGTERM, which triggers a graceful drain.
- **No device-memory reading.** KVStream states it outright: it is a proxy, runs no model, owns no
  KV tensors, and cannot raise or read the backend's physical capacity.

### `kvstream serve` flags used

`--config`, `--host`, `--port`, `--model`, `--backend-url`, `--mode`, `--max-concurrency`,
`--max-tokens`. The extension passes only what the user configures in `kvstream.kvstreamArgs`.

---

## Foundry Local CLI (0.12.1, verified live)

`foundry --version` → `0.12.1`

`foundry server status --output json` →

```json
{"running":false,"state":"not_running","pid":14524,
 "webUrls":["http://127.0.0.1:64524"],"startedAt":"...","uptime":"...","logFile":""}
```

**`webUrls` is retained from the previous session after the daemon exits.** Verified live. Treating
it as a live endpoint would show a dead address as a discovery result, so the extension classifies
it as stale whenever `running` is false.

`foundry status --output json` →

```json
{"system":{"operatingSystem":"...","architecture":"X64","cpu":"...","logicalCores":6,
           "gpus":[{"name":"NVIDIA GeForce GTX 1660 SUPER","vendor":"NVIDIA",
                    "videoMemoryBytes":6255804416}],
           "npus":[],"totalMemoryBytes":17098465280,"availableMemoryBytes":8791953408,
           "diskPath":"C:\\","diskTotalBytes":...,"diskFreeBytes":...},
 "service":{"state":"not_running","ready":false,"webUrls":[],"cliVersion":"0.12.1",
            "daemonVersion":"0.12.1","protocolVersion":2,...},
 "models":{},"connectivity":{"localServiceReachable":false},"warnings":[]}
```

`videoMemoryBytes` is the device **total**. No usage figure is exposed, for GPU or VRAM.

Subcommands: `foundry server start|stop|restart|status|logs`. The older generation used
`foundry service start|status`; neither CLI's JSON has a documented stability contract, so every
parse failure is treated as a miss rather than an error.

---

## Architecture assessment of the pre-existing workspace

Found at `D:\kvstream-monitor\kvstream-monitor`: a `yo code` TypeScript scaffold with esbuild,
eslint 10, `@vscode/test-cli`, a git repository with **no commits** and everything untracked. It
contained a working `package.json` with seven commands and two settings, a 40-line
`src/kvstream/client.ts` whose comments already recorded the `/health` 503 semantics correctly, an
empty `src/views/monitorView.ts`, and the generated sample test.

Kept: the build toolchain, esbuild config, tsconfig, eslint config, launch and task configuration,
the `kvstream.url` / `kvstream.refreshInterval` settings and their defaults, and the
`kvstream-monitor.*` / `kvstream.monitor` / `kvstream` identifiers, so existing user settings and
muscle memory still work.

Replaced: `src/kvstream/client.ts` (grown into a validated client with error classification),
`src/extension.ts`, and the sample test.

One file was wrong rather than incomplete: `resources/kvstream.svg` was a 1024×1024 **PNG** with an
`.svg` extension, which an Activity Bar container cannot render. It was preserved as
`resources/kvstream-logo.png`, downscaled to `resources/icon.png` (128×128) for the Marketplace
icon slot, and a real monochrome SVG was written in its place.

---

## Observed only on a live gateway

Recorded against KVStream 1.0.0 on Windows; the raw `/status` and `/metrics` bodies are kept as test
fixtures in `src/test/fixtures/realKvstream.ts`.

| Behaviour | Observed | Consequence for the extension |
|---|---|---|
| `/health` latency, backend serving | 3.2 s (it runs a 1-token generation) against 2 ms for `/status` | `/health` gets its own deadline (≥ 15 s) and poller |
| `/health` with no backend reachable | no answer within 60 s; KVStream re-scans localhost about every 6 s | `/health` backs off to 30 s; the state is read from `/status` meanwhile, with a notice explaining why |
| `backend.base_url` when nothing is found | `http://localhost:5273` (a default) with `resolution.source: "unresolved"` | only a resolved URL is displayed; otherwise KVStream's `resolution.detail` is shown |
| `resolution.attempts` | `["foundry-cli(0.10.x)", "scan"]` | parsed as `string[]` |
| `kvstream_requests_total` before any request | `# HELP` / `# TYPE` lines, no samples | a declared counter with no series reads as 0 |
| prometheus_client `_created` families | present, e.g. `kvstream_cache_hits_created` | never summed into request totals |
| Foundry CLI 0.12.1 live daemon | `{"running": true, "state": "ready", ...}` | liveness comes from `running`, not from the state word |
| Foundry CLI side effect | `foundry cache list` started the daemon when it was stopped | documented; the extension only runs `--version`, `status` and `server status` |
