/**
 * Responses recorded from a real KVStream 1.0.0 gateway (`kvstream serve`,
 * installed from microsoft/KVstream) on Windows, with Foundry Local CLI 0.12.1
 * installed but its daemon stopped, on 2026-10-28. Only the local path to
 * foundry.exe has been replaced. Test-only; never imported by src/ outside src/test.
 */

export const REAL_STATUS_NO_BACKEND = {
	"version": "1.0.0",
	"admission": {
		"unit": "concurrency",
		"budget": 8,
		"in_flight": 0,
		"utilization": 0.0,
		"waiting": 0,
		"max_queue_depth": 1000,
		"active": 0,
		"overshoots": 0,
		"reclaimed": 0,
		"draining": false,
		"queue": {
			"depth": 0,
			"head_cost": 0,
			"oldest_wait_seconds": 0.0,
			"admitted": 0,
			"timed_out": 0,
			"rejected": 0,
			"peak_depth": 0
		},
		"drain_rate_per_second": 0.0,
		"completions": 0,
		"queued_cost": 0,
		"hopeless_rejections": 0
	},
	"audio_admission": {
		"unit": "concurrency",
		"budget": 2,
		"in_flight": 0,
		"utilization": 0.0,
		"waiting": 0,
		"max_queue_depth": 1000,
		"active": 0,
		"overshoots": 0,
		"reclaimed": 0,
		"draining": false,
		"queue": {
			"depth": 0,
			"head_cost": 0,
			"oldest_wait_seconds": 0.0,
			"admitted": 0,
			"timed_out": 0,
			"rejected": 0,
			"peak_depth": 0
		},
		"drain_rate_per_second": 0.0,
		"completions": 0,
		"queued_cost": 0,
		"hopeless_rejections": 0
	},
	"budget_source": {
		"source": "config",
		"key": {
			"model": "unknown",
			"device": "windows-amd64",
			"cli_generation": "0.10.x",
			"backend_version": "0.12.1"
		}
	},
	"budget_pending": null,
	"runtime_profile": {
		"regime": "unknown",
		"detail": "no calibration record; run `kvstream calibrate`"
	},
	"calibration_key": {
		"model": "unknown",
		"device": "windows-amd64",
		"cli_generation": "0.10.x",
		"backend_version": "0.12.1"
	},
	"model": {
		"id": null,
		"source": "undetermined: could not read Foundry Local's model list (is it running?)",
		"inventory": {
			"downloaded": null,
			"loaded": null,
			"age_seconds": 77.9,
			"types": null
		}
	},
	"backend": {
		"base_url": "http://localhost:5273",
		"configured_url": "http://localhost:5273",
		"discover": true,
		"pinned": false,
		"scans": 16,
		"resolutions": 0,
		"usage_reporting": true,
		"resolution": {
			"url": null,
			"source": "unresolved",
			"detail": "No Foundry Local endpoint found. Foundry Local CLI 0.12.1 (0.10.x) is installed — start it with `foundry server start`, then load a model.",
			"attempts": [
				"foundry-cli(0.10.x)",
				"scan"
			]
		},
		"foundry_cli": {
			"available": true,
			"path": "<path to foundry.exe>",
			"version": "0.12.1",
			"generation": "0.10.x",
			"detail": ""
		}
	},
	"backend_health": {
		"reachable": false,
		"readiness": {
			"ready": false,
			"detail": "no model to probe — undetermined: could not read Foundry Local's model list (is it running?)",
			"latency_seconds": 0.0,
			"age_seconds": 0.0,
			"probed": false
		},
		"circuit_breaker": {
			"enabled": true,
			"state": "closed",
			"consecutive_failures": 0,
			"trips": 0,
			"fast_failures": 0,
			"last_error": "",
			"retry_after_seconds": 0
		}
	},
	"drift": {
		"state": "unknown",
		"baseline_seconds_per_token": 0.0,
		"observed_seconds_per_token": 0.0,
		"ratio": 0.0,
		"worst_ratio": 0.0,
		"samples": 0,
		"warn_ratio": 3.0
	},
	"routes": {
		"chat": true,
		"models": true,
		"embeddings": true,
		"transcriptions": true,
		"completions": true
	},
	"token_estimator": {
		"chars_per_token": 4.0,
		"units_per_token": 1.0,
		"initial_chars_per_token": 4.0,
		"safety_factor": 1.0,
		"samples": 0,
		"calibrated": false
	},
	"token_estimators": {
		"default": {
			"chars_per_token": 4.0,
			"units_per_token": 1.0,
			"initial_chars_per_token": 4.0,
			"safety_factor": 1.0,
			"samples": 0,
			"calibrated": false
		},
		"learned": {}
	},
	"cache": {
		"enabled": false
	},
	"coalescer": {
		"enabled": true,
		"inflight": 0,
		"coalesced_total": 0,
		"streaming": {
			"inflight": 0,
			"coalesced_total": 0
		}
	},
	"model_geometry": {
		"anchor": "",
		"anchor_known": false,
		"models": {}
	}
};

export const REAL_METRICS_NO_TRAFFIC = "# HELP kvstream_requests_total Requests by proxied route and outcome.\n# TYPE kvstream_requests_total counter\n# HELP kvstream_rejected_total Rejected requests by route and reason.\n# TYPE kvstream_rejected_total counter\n# HELP kvstream_cache_hits_total Response-cache hits.\n# TYPE kvstream_cache_hits_total counter\nkvstream_cache_hits_total 0.0\n# HELP kvstream_cache_hits_created Response-cache hits.\n# TYPE kvstream_cache_hits_created gauge\nkvstream_cache_hits_created 1.7931887504017072e+09\n# HELP kvstream_cache_skipped_total Responses not cached, by reason.\n# TYPE kvstream_cache_skipped_total counter\n# HELP kvstream_coalesced_total Requests served by a coalesced leader.\n# TYPE kvstream_coalesced_total counter\nkvstream_coalesced_total 0.0\n# HELP kvstream_coalesced_created Requests served by a coalesced leader.\n# TYPE kvstream_coalesced_created gauge\nkvstream_coalesced_created 1.7931887504017072e+09\n# HELP kvstream_request_seconds End-to-end request latency (seconds) by route.\n# TYPE kvstream_request_seconds histogram\n# HELP kvstream_admission_wait_seconds Time spent waiting for admission, by route.\n# TYPE kvstream_admission_wait_seconds histogram\n# HELP kvstream_backend_errors_total Backend failures by phase.\n# TYPE kvstream_backend_errors_total counter\n# HELP kvstream_reservation_overshoot_total Times a generation outgrew its admitted reservation and was topped up: below admission.reserve_completion_ratio 1.0, or with admission.apply_default_max_tokens off, when a request set no limit and generated past admission.default_max_tokens.\n# TYPE kvstream_reservation_overshoot_total counter\nkvstream_reservation_overshoot_total 0.0\n# HELP kvstream_reservation_overshoot_created Times a generation outgrew its admitted reservation and was topped up: below admission.reserve_completion_ratio 1.0, or with admission.apply_default_max_tokens off, when a request set no limit and generated past admission.default_max_tokens.\n# TYPE kvstream_reservation_overshoot_created gauge\nkvstream_reservation_overshoot_created 1.7931887504017072e+09\n# HELP kvstream_reservation_reclaimed_tokens_total Budget returned early by live accounting, before request teardown.\n# TYPE kvstream_reservation_reclaimed_tokens_total counter\nkvstream_reservation_reclaimed_tokens_total 0.0\n# HELP kvstream_reservation_reclaimed_tokens_created Budget returned early by live accounting, before request teardown.\n# TYPE kvstream_reservation_reclaimed_tokens_created gauge\nkvstream_reservation_reclaimed_tokens_created 1.7931887504017072e+09\n# HELP kvstream_budget Admission budget (tokens or slots).\n# TYPE kvstream_budget gauge\nkvstream_budget 8.0\n# HELP kvstream_in_flight Reserved budget currently in flight.\n# TYPE kvstream_in_flight gauge\nkvstream_in_flight 0.0\n# HELP kvstream_budget_utilization in_flight / budget.\n# TYPE kvstream_budget_utilization gauge\nkvstream_budget_utilization 0.0\n# HELP kvstream_queue_depth Requests waiting for admission.\n# TYPE kvstream_queue_depth gauge\nkvstream_queue_depth 0.0\n# HELP kvstream_chars_per_token Current characters-per-token ratio used for cost estimation.\n# TYPE kvstream_chars_per_token gauge\nkvstream_chars_per_token 4.0\n# HELP kvstream_token_ratio_samples Number of real usage reports the estimator has learned from.\n# TYPE kvstream_token_ratio_samples gauge\nkvstream_token_ratio_samples 0.0\n# HELP kvstream_active_requests Requests currently holding a reservation.\n# TYPE kvstream_active_requests gauge\nkvstream_active_requests 0.0\n# HELP kvstream_discovery_scans Full localhost discovery sweeps performed since start.\n# TYPE kvstream_discovery_scans gauge\nkvstream_discovery_scans 16.0\n# HELP kvstream_calibration_age_seconds Age of the calibrated budget in use; 0 when none is in use.\n# TYPE kvstream_calibration_age_seconds gauge\nkvstream_calibration_age_seconds 0.0\n# HELP kvstream_circuit_breaker_state 0 = closed, 1 = half-open, 2 = open.\n# TYPE kvstream_circuit_breaker_state gauge\nkvstream_circuit_breaker_state 0.0\n# HELP kvstream_backend_ready 1 when the backend completed a bounded trial generation. Distinct from kvstream_backend_up, which only means it answered /v1/models.\n# TYPE kvstream_backend_ready gauge\nkvstream_backend_ready 0.0\n# HELP kvstream_backend_drift_ratio Served seconds-per-token relative to the calibration baseline; 0 when unknown.\n# TYPE kvstream_backend_drift_ratio gauge\nkvstream_backend_drift_ratio 0.0\n# HELP kvstream_backend_up Last known backend reachability (startup, /health, completed requests): 1 up, 0 down.\n# TYPE kvstream_backend_up gauge\nkvstream_backend_up 0.0\n# HELP kvstream_audio_budget Concurrent transcription slots.\n# TYPE kvstream_audio_budget gauge\nkvstream_audio_budget 2.0\n# HELP kvstream_audio_in_flight Transcriptions currently in flight.\n# TYPE kvstream_audio_in_flight gauge\nkvstream_audio_in_flight 0.0\n# HELP kvstream_audio_queue_depth Transcriptions waiting for a slot.\n# TYPE kvstream_audio_queue_depth gauge\nkvstream_audio_queue_depth 0.0\n";
