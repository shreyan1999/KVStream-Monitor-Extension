/**
 * Types for the KVStream gateway HTTP surface.
 *
 * Shapes verified against microsoft/KVstream `src/kvstream/app.py`
 * (`/health` and `/status` handlers) and the dataclasses they serialise:
 * `admission/capacity.py`, `backend/health.py`, `backend/foundry.py`,
 * `backend/inventory.py`, `backend/resolver.py`, `admission/drift.py`.
 *
 * Every field is optional on the wire as far as this extension is concerned:
 * the gateway is versioned independently, so parsers validate rather than cast.
 */

/** `/health` — 200 when the backend is serving, 503 when it is not. */
export interface HealthBody {
	status?: string;
	/** Liveness. Kept by KVStream for compatibility; equals `backend_reachable`. */
	backendHealthy?: boolean;
	/** The backend answered `GET /v1/models`. A stalled runtime still does. */
	backendReachable?: boolean;
	/** The backend completed a real bounded trial generation. */
	backendServing?: boolean;
	readiness?: Readiness;
	circuitBreaker?: CircuitBreaker;
	drift?: Drift;
	backendUrl?: string;
	model?: string;
	modelSource?: string;
	version?: string;
	/** Actionable text KVStream supplies when it is not serving. */
	hint?: string;
}

export interface Readiness {
	ready?: boolean;
	detail?: string;
	latencySeconds?: number;
	ageSeconds?: number;
	probed?: boolean;
}

export type CircuitState = 'closed' | 'open' | 'half_open' | string;

export interface CircuitBreaker {
	enabled?: boolean;
	state?: CircuitState;
	consecutiveFailures?: number;
	trips?: number;
	fastFailures?: number;
	lastError?: string;
	retryAfterSeconds?: number;
}

export interface Drift {
	state?: string;
	baselineSecondsPerToken?: number;
	observedSecondsPerToken?: number;
	ratio?: number;
	worstRatio?: number;
	samples?: number;
	warnRatio?: number;
}

/**
 * `admission` / `audio_admission` in `/status`.
 *
 * `unit` decides what `budget` and `inFlight` count. In `concurrency` mode they
 * are request slots; in `tokens` mode they are estimated KV tokens. They are
 * never a reading of device memory.
 */
export interface AdmissionStats {
	unit?: 'tokens' | 'concurrency' | string;
	budget?: number;
	/** Reserved budget in flight, in `unit`. NOT a request count. */
	inFlight?: number;
	utilization?: number;
	waiting?: number;
	maxQueueDepth?: number;
	/** Requests currently holding a reservation. This *is* a request count. */
	active?: number;
	overshoots?: number;
	reclaimed?: number;
	draining?: boolean;
	queue?: QueueStats;
	drainRatePerSecond?: number;
	completions?: number;
	queuedCost?: number;
	hopelessRejections?: number;
}

export interface QueueStats {
	depth?: number;
	headCost?: number;
	oldestWaitSeconds?: number;
	admitted?: number;
	timedOut?: number;
	rejected?: number;
	peakDepth?: number;
}

export interface BudgetSource {
	/** `config` | `configured` | `calibration:exact` | `calibration:partial` | `fallback:concurrency` */
	source?: string;
	key?: Record<string, unknown>;
	lookup?: Record<string, unknown>;
}

export interface RuntimeProfile {
	regime?: 'serialising' | 'batching' | 'capped' | 'unknown' | string;
	detail?: string;
}

export interface BackendResolution {
	url?: string;
	/** `configured` | `foundry-cli` | `scan` | `unresolved` (verified on 1.0.0). */
	source?: string;
	detail?: string;
	/** Strategies tried, e.g. `["foundry-cli(0.10.x)", "scan"]` (verified on 1.0.0). */
	attempts?: string[];
}

export interface BackendStats {
	baseUrl?: string;
	configuredUrl?: string;
	discover?: boolean;
	pinned?: boolean;
	scans?: number;
	resolutions?: number;
	/** Whether KVStream still asks for `usage`, not whether the backend answers. */
	usageReporting?: boolean;
	resolution?: BackendResolution;
	foundryCli?: Record<string, unknown>;
}

export interface ModelInventory {
	downloaded?: string[] | null;
	loaded?: string[] | null;
	ageSeconds?: number | null;
	types?: Record<string, string> | null;
}

export interface ModelInfo {
	id?: string | null;
	source?: string;
	inventory?: ModelInventory;
}

export interface BackendHealthStats {
	reachable?: boolean;
	readiness?: Readiness;
	circuitBreaker?: CircuitBreaker;
}

export interface CacheStats {
	enabled?: boolean;
	[key: string]: unknown;
}

export interface CoalescerStats {
	enabled?: boolean;
	inflight?: number;
	coalescedTotal?: number;
	[key: string]: unknown;
}

export interface StatusBody {
	version?: string;
	admission?: AdmissionStats;
	audioAdmission?: AdmissionStats;
	budgetSource?: BudgetSource;
	runtimeProfile?: RuntimeProfile;
	model?: ModelInfo;
	backend?: BackendStats;
	backendHealth?: BackendHealthStats;
	drift?: Drift;
	routes?: Record<string, boolean>;
	tokenEstimator?: Record<string, unknown>;
	cache?: CacheStats;
	coalescer?: CoalescerStats;
}
