/**
 * Fixtures modelled on the real gateway.
 *
 * Shapes are taken from microsoft/KVstream `src/kvstream/app.py` (`/health`
 * and `/status`) and `src/kvstream/observability/metrics.py`, not invented.
 * They exist only for tests: nothing in `src/` outside `src/test/` imports
 * this file, so a fixture can never become the production data source.
 */

export const HEALTH_SERVING = {
	status: 'ok',
	backend_healthy: true,
	backend_reachable: true,
	backend_serving: true,
	readiness: { ready: true, detail: 'generated 1 token', latency_seconds: 0.173, age_seconds: 1.2, probed: true },
	circuit_breaker: {
		enabled: true,
		state: 'closed',
		consecutive_failures: 0,
		trips: 0,
		fast_failures: 0,
		last_error: null,
		retry_after_seconds: 0,
	},
	drift: {
		state: 'ok',
		baseline_seconds_per_token: 0.0121,
		observed_seconds_per_token: 0.0129,
		ratio: 1.066,
		worst_ratio: 1.21,
		samples: 42,
		warn_ratio: 1.5,
	},
	backend_url: 'http://127.0.0.1:51264',
	model: 'Phi-3-mini-4k-instruct-generic-gpu:2',
	model_source: 'auto-detected: the only model loaded in Foundry Local',
	version: '0.6.0',
};

/** The 503 body: same shape, plus the `hint` the gateway adds. */
export const HEALTH_DEGRADED = {
	...HEALTH_SERVING,
	status: 'degraded',
	backend_serving: false,
	readiness: { ready: false, detail: 'probe timed out after 10.0s', latency_seconds: 10.0, age_seconds: 0.2, probed: true },
	hint:
		'The backend is reachable but not serving: probe timed out after 10.0s. ' +
		'Restarting Foundry Local usually clears a runtime that has exhausted its KV cache.',
};

export const HEALTH_BACKEND_DOWN = {
	status: 'degraded',
	backend_healthy: false,
	backend_reachable: false,
	backend_serving: false,
	readiness: { ready: false, detail: 'no model to probe — backend unreachable', latency_seconds: 0, age_seconds: 0, probed: false },
	circuit_breaker: {
		enabled: true,
		state: 'open',
		consecutive_failures: 8,
		trips: 1,
		fast_failures: 3,
		last_error: 'ConnectError',
		retry_after_seconds: 12,
	},
	drift: { state: 'unknown', baseline_seconds_per_token: 0, observed_seconds_per_token: 0, ratio: 0, worst_ratio: 0, samples: 0, warn_ratio: 1.5 },
	backend_url: 'http://127.0.0.1:51264',
	model: null,
	model_source: 'no model determined',
	version: '0.6.0',
	hint: 'Foundry Local does not appear to be running. Start it with `foundry server start`.',
};

export const STATUS_CONCURRENCY = {
	version: '0.6.0',
	admission: {
		unit: 'concurrency',
		budget: 4,
		in_flight: 3,
		utilization: 0.75,
		waiting: 2,
		max_queue_depth: 64,
		active: 3,
		overshoots: 0,
		reclaimed: 0,
		draining: false,
		queue: { depth: 2, head_cost: 1, oldest_wait_seconds: 1.42, admitted: 118, timed_out: 0, rejected: 3, peak_depth: 9 },
		drain_rate_per_second: 2.61,
		completions: 118,
		queued_cost: 2,
		hopeless_rejections: 0,
	},
	audio_admission: {
		unit: 'concurrency',
		budget: 1,
		in_flight: 0,
		utilization: 0.0,
		waiting: 0,
		max_queue_depth: 16,
		active: 0,
		overshoots: 0,
		reclaimed: 0,
		draining: false,
		queue: { depth: 0, head_cost: 0, oldest_wait_seconds: 0, admitted: 0, timed_out: 0, rejected: 0, peak_depth: 0 },
		drain_rate_per_second: 0,
		completions: 0,
		queued_cost: 0,
		hopeless_rejections: 0,
	},
	budget_source: { source: 'fallback:concurrency', key: { model: 'phi-3-mini', device: 'gpu' } },
	budget_pending: null,
	runtime_profile: { regime: 'unknown', detail: 'no calibration record; run `kvstream calibrate`' },
	calibration_key: { model: 'phi-3-mini', device: 'gpu' },
	model: {
		id: 'Phi-3-mini-4k-instruct-generic-gpu:2',
		source: 'auto-detected',
		inventory: {
			downloaded: ['Phi-3-mini-4k-instruct-generic-gpu:2'],
			loaded: ['Phi-3-mini-4k-instruct-generic-gpu:2'],
			age_seconds: 3.4,
			types: { 'Phi-3-mini-4k-instruct-generic-gpu:2': 'Chat' },
		},
	},
	backend: {
		base_url: 'http://127.0.0.1:51264',
		configured_url: '',
		discover: true,
		pinned: false,
		scans: 1,
		resolutions: 2,
		usage_reporting: true,
		resolution: { url: 'http://127.0.0.1:51264', source: 'foundry-cli', detail: 'foundry status --output json', attempts: 1 },
		foundry_cli: { available: true, version: '0.12.1' },
	},
	backend_health: {
		reachable: true,
		readiness: { ready: true, detail: 'generated 1 token', latency_seconds: 0.173, age_seconds: 1.2, probed: true },
		circuit_breaker: { enabled: true, state: 'closed', consecutive_failures: 0, trips: 0, fast_failures: 0, last_error: null, retry_after_seconds: 0 },
	},
	drift: HEALTH_SERVING.drift,
	routes: { chat: true, models: true, embeddings: true, transcriptions: true, completions: true },
	token_estimator: { samples: 17, chars_per_token: 3.81 },
	token_estimators: {},
	cache: { enabled: false },
	coalescer: { enabled: true, inflight: 0, coalesced_total: 4, streaming: null },
	model_geometry: {},
};

/** A build that reports no admission block at all. */
export const STATUS_MINIMAL = { version: '0.6.0' };

export const METRICS_TEXT = `# HELP kvstream_requests_total Requests by proxied route and outcome.
# TYPE kvstream_requests_total counter
kvstream_requests_total{outcome="served",route="chat"} 118.0
kvstream_requests_total{outcome="rejected",route="chat"} 3.0
kvstream_requests_total{outcome="error",route="chat"} 2.0
kvstream_requests_total{outcome="cache_hit",route="chat"} 5.0
# HELP kvstream_rejected_total Rejected requests by route and reason.
# TYPE kvstream_rejected_total counter
kvstream_rejected_total{reason="timeout",route="chat"} 3.0
# HELP kvstream_budget Admission budget (tokens or slots).
# TYPE kvstream_budget gauge
kvstream_budget 4.0
# HELP kvstream_in_flight Reserved budget currently in flight.
# TYPE kvstream_in_flight gauge
kvstream_in_flight 3.0
# HELP kvstream_budget_utilization in_flight / budget.
# TYPE kvstream_budget_utilization gauge
kvstream_budget_utilization 0.75
# HELP kvstream_queue_depth Requests waiting for admission.
# TYPE kvstream_queue_depth gauge
kvstream_queue_depth 2.0
# HELP kvstream_active_requests Requests currently holding a reservation.
# TYPE kvstream_active_requests gauge
kvstream_active_requests 3.0
# HELP kvstream_backend_up Whether the backend answered /v1/models.
# TYPE kvstream_backend_up gauge
kvstream_backend_up 1.0
# HELP kvstream_backend_ready Whether a trial generation succeeded.
# TYPE kvstream_backend_ready gauge
kvstream_backend_ready 1.0
# HELP kvstream_circuit_breaker_state Circuit breaker state.
# TYPE kvstream_circuit_breaker_state gauge
kvstream_circuit_breaker_state 0.0
# HELP kvstream_request_seconds End-to-end request latency (seconds) by route.
# TYPE kvstream_request_seconds histogram
kvstream_request_seconds_bucket{le="0.5",route="chat"} 12.0
kvstream_request_seconds_bucket{le="+Inf",route="chat"} 118.0
kvstream_request_seconds_count{route="chat"} 118.0
kvstream_request_seconds_sum{route="chat"} 243.8
`;

/** No admission block, no request counters: a gateway that reports less. */
export const METRICS_PARTIAL = `# TYPE kvstream_backend_up gauge
kvstream_backend_up 0.0
`;
