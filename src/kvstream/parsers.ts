import type {
	AdmissionStats,
	BackendHealthStats,
	BackendStats,
	BudgetSource,
	CircuitBreaker,
	Drift,
	HealthBody,
	ModelInfo,
	QueueStats,
	Readiness,
	RuntimeProfile,
	StatusBody,
} from '../types/kvstream';

/**
 * Validators for the JSON bodies the gateway returns.
 *
 * KVStream is versioned independently of this extension, so nothing is cast:
 * each field is read with a type guard and simply omitted when it is absent or
 * the wrong type. A body that is not an object at all is rejected outright,
 * which is what distinguishes "the gateway answered something else" (an error
 * state) from "this build does not report that field" (a missing value).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	return typeof value === 'string' ? value : undefined;
}

function bool(obj: Record<string, unknown>, key: string): boolean | undefined {
	const value = obj[key];
	return typeof value === 'boolean' ? value : undefined;
}

/**
 * A finite number, optionally allowed to be negative.
 *
 * Counts, budgets and queue depths cannot be negative; a negative one means
 * the body is not what we think it is, and reading it would put a nonsense
 * number on the dashboard. Ratios may legitimately be any finite value.
 */
function num(
	obj: Record<string, unknown>,
	key: string,
	opts: { allowNegative?: boolean } = {},
): number | undefined {
	const value = obj[key];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	if (!opts.allowNegative && value < 0) {
		return undefined;
	}
	return value;
}

function record(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const value = obj[key];
	return isRecord(value) ? value : undefined;
}

function stringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
	const value = obj[key];
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((item): item is string => typeof item === 'string');
}

function stringMap(raw: Record<string, unknown> | undefined): Record<string, string> | null {
	if (!raw) {
		return null;
	}
	const entries = Object.entries(raw).filter(
		(entry): entry is [string, string] => typeof entry[1] === 'string',
	);
	return Object.fromEntries(entries);
}

export function parseReadiness(raw: unknown): Readiness | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		ready: bool(raw, 'ready'),
		detail: str(raw, 'detail'),
		latencySeconds: num(raw, 'latency_seconds'),
		ageSeconds: num(raw, 'age_seconds'),
		probed: bool(raw, 'probed'),
	};
}

export function parseCircuitBreaker(raw: unknown): CircuitBreaker | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		enabled: bool(raw, 'enabled'),
		state: str(raw, 'state'),
		consecutiveFailures: num(raw, 'consecutive_failures'),
		trips: num(raw, 'trips'),
		fastFailures: num(raw, 'fast_failures'),
		lastError: str(raw, 'last_error'),
		retryAfterSeconds: num(raw, 'retry_after_seconds'),
	};
}

export function parseDrift(raw: unknown): Drift | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		state: str(raw, 'state'),
		baselineSecondsPerToken: num(raw, 'baseline_seconds_per_token'),
		observedSecondsPerToken: num(raw, 'observed_seconds_per_token'),
		ratio: num(raw, 'ratio'),
		worstRatio: num(raw, 'worst_ratio'),
		samples: num(raw, 'samples'),
		warnRatio: num(raw, 'warn_ratio'),
	};
}

export function parseHealth(raw: unknown): HealthBody | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		status: str(raw, 'status'),
		backendHealthy: bool(raw, 'backend_healthy'),
		backendReachable: bool(raw, 'backend_reachable'),
		backendServing: bool(raw, 'backend_serving'),
		readiness: parseReadiness(raw['readiness']),
		circuitBreaker: parseCircuitBreaker(raw['circuit_breaker']),
		drift: parseDrift(raw['drift']),
		backendUrl: str(raw, 'backend_url'),
		model: str(raw, 'model'),
		modelSource: str(raw, 'model_source'),
		version: str(raw, 'version'),
		hint: str(raw, 'hint'),
	};
}

function parseQueue(raw: unknown): QueueStats | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		depth: num(raw, 'depth'),
		headCost: num(raw, 'head_cost'),
		oldestWaitSeconds: num(raw, 'oldest_wait_seconds'),
		admitted: num(raw, 'admitted'),
		timedOut: num(raw, 'timed_out'),
		rejected: num(raw, 'rejected'),
		peakDepth: num(raw, 'peak_depth'),
	};
}

export function parseAdmission(raw: unknown): AdmissionStats | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		unit: str(raw, 'unit'),
		budget: num(raw, 'budget'),
		inFlight: num(raw, 'in_flight'),
		utilization: num(raw, 'utilization'),
		waiting: num(raw, 'waiting'),
		maxQueueDepth: num(raw, 'max_queue_depth'),
		active: num(raw, 'active'),
		overshoots: num(raw, 'overshoots'),
		reclaimed: num(raw, 'reclaimed'),
		draining: bool(raw, 'draining'),
		queue: parseQueue(raw['queue']),
		drainRatePerSecond: num(raw, 'drain_rate_per_second'),
		completions: num(raw, 'completions'),
		queuedCost: num(raw, 'queued_cost'),
		hopelessRejections: num(raw, 'hopeless_rejections'),
	};
}

function parseBudgetSource(raw: unknown): BudgetSource | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		source: str(raw, 'source'),
		key: record(raw, 'key'),
		lookup: record(raw, 'lookup'),
	};
}

function parseRuntimeProfile(raw: unknown): RuntimeProfile | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return { regime: str(raw, 'regime'), detail: str(raw, 'detail') };
}

function parseBackend(raw: unknown): BackendStats | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const resolutionRaw = record(raw, 'resolution');
	return {
		baseUrl: str(raw, 'base_url'),
		configuredUrl: str(raw, 'configured_url'),
		discover: bool(raw, 'discover'),
		pinned: bool(raw, 'pinned'),
		scans: num(raw, 'scans'),
		resolutions: num(raw, 'resolutions'),
		usageReporting: bool(raw, 'usage_reporting'),
		resolution: resolutionRaw
			? {
					url: str(resolutionRaw, 'url'),
					source: str(resolutionRaw, 'source'),
					detail: str(resolutionRaw, 'detail'),
					attempts: stringArray(resolutionRaw, 'attempts'),
				}
			: undefined,
		foundryCli: record(raw, 'foundry_cli'),
	};
}

function parseModel(raw: unknown): ModelInfo | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const inventoryRaw = record(raw, 'inventory');
	return {
		id: str(raw, 'id') ?? null,
		source: str(raw, 'source'),
		inventory: inventoryRaw
			? {
					downloaded: stringArray(inventoryRaw, 'downloaded') ?? null,
					loaded: stringArray(inventoryRaw, 'loaded') ?? null,
					ageSeconds: num(inventoryRaw, 'age_seconds') ?? null,
					types: stringMap(record(inventoryRaw, 'types')),
				}
			: undefined,
	};
}

function parseBackendHealth(raw: unknown): BackendHealthStats | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		reachable: bool(raw, 'reachable'),
		readiness: parseReadiness(raw['readiness']),
		circuitBreaker: parseCircuitBreaker(raw['circuit_breaker']),
	};
}

export function parseStatus(raw: unknown): StatusBody | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const routesRaw = record(raw, 'routes');
	const cacheRaw = record(raw, 'cache');
	const coalescerRaw = record(raw, 'coalescer');
	return {
		version: str(raw, 'version'),
		admission: parseAdmission(raw['admission']),
		audioAdmission: parseAdmission(raw['audio_admission']),
		budgetSource: parseBudgetSource(raw['budget_source']),
		runtimeProfile: parseRuntimeProfile(raw['runtime_profile']),
		model: parseModel(raw['model']),
		backend: parseBackend(raw['backend']),
		backendHealth: parseBackendHealth(raw['backend_health']),
		drift: parseDrift(raw['drift']),
		routes: routesRaw
			? Object.fromEntries(
					Object.entries(routesRaw).filter(
						(entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
					),
				)
			: undefined,
		tokenEstimator: record(raw, 'token_estimator'),
		cache: cacheRaw ? { ...cacheRaw, enabled: bool(cacheRaw, 'enabled') } : undefined,
		coalescer: coalescerRaw
			? {
					...coalescerRaw,
					enabled: bool(coalescerRaw, 'enabled'),
					inflight: num(coalescerRaw, 'inflight'),
					coalescedTotal: num(coalescerRaw, 'coalesced_total'),
				}
			: undefined,
	};
}
