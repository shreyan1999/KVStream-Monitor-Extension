/** Parsed Prometheus exposition data and the snapshot the UI consumes. */

export interface PromSample {
	name: string;
	labels: Record<string, string>;
	value: number;
}

export interface PromFamily {
	name: string;
	type?: 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';
	help?: string;
	samples: PromSample[];
}

export type PromRegistry = Map<string, PromFamily>;

/**
 * A value the UI may render, plus why it is missing when it is.
 *
 * `undefined` value with `reason` set is an honest "not measured"; it must
 * never be rendered as 0.
 */
export interface Measured<T = number> {
	value?: T;
	reason?: string;
}

export interface RequestMetrics {
	/** Sum of `kvstream_requests_total` across routes and outcomes. */
	totalRequests: Measured;
	/** Outcome breakdown of `kvstream_requests_total`. */
	byOutcome: Record<string, number>;
	/** Route breakdown of `kvstream_requests_total` (chat, embeddings, ...). */
	byRoute: Record<string, number>;
	/** `kvstream_active_requests` — requests holding a reservation. */
	running: Measured;
	/** `kvstream_queue_depth` — requests waiting for admission. */
	queued: Measured;
	/** `kvstream_requests_total{outcome="error"}` + `{outcome="client_error"}`. */
	failed: Measured;
	/** `kvstream_requests_total{outcome="served"}` + cache_hit + coalesced. */
	served: Measured;
	rejected: Measured;
}

export interface BudgetMetrics {
	unit?: string;
	used: Measured;
	total: Measured;
	remaining: Measured;
	/** 0..1 */
	utilization: Measured;
}

/** A point in a bounded time series. */
export interface Sample {
	t: number;
	v: number;
}

export interface SeriesSnapshot {
	points: Sample[];
	/** Indices at which a gap means the line must not be joined. */
	limit: number;
}
