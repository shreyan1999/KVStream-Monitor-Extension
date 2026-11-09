import type { AdmissionStats } from '../types/kvstream';
import type { BudgetMetrics, Measured, PromRegistry, RequestMetrics } from '../types/metrics';
import { gaugeValue, groupByLabel, isDeclaredCounter, sumFamily } from '../kvstream/prometheus';

/**
 * Derivation of displayable metrics from `/status` and `/metrics`.
 *
 * Two rules run through all of it:
 *
 *  - A number is only produced when a documented source reported it. Anything
 *    else is `{ reason }`, which the UI renders as "n/a" — never as 0.
 *  - Units are never mixed. `kvstream_in_flight` and `kvstream_budget` are in
 *    whatever `admission.unit` says (request slots in `concurrency` mode,
 *    estimated KV tokens in `tokens` mode), and `admission.active` is a count
 *    of requests. Those are different quantities and are kept apart.
 */

const NO_SOURCE = 'not reported by this gateway';
const NO_METRICS = 'metrics endpoint unavailable';

function measured(value: number | undefined, reason: string): Measured {
	return value === undefined ? { reason } : { value };
}

/** Outcomes of `kvstream_requests_total` that mean the request was answered. */
const SERVED_OUTCOMES = ['served', 'cache_hit', 'coalesced'];

export function deriveRequestMetrics(
	registry: PromRegistry | undefined,
	admission: AdmissionStats | undefined,
): RequestMetrics {
	const metricsReason = registry ? NO_SOURCE : NO_METRICS;
	const byOutcome = registry ? groupByLabel(registry, 'kvstream_requests_total', 'outcome') : {};
	const byRoute = registry ? groupByLabel(registry, 'kvstream_requests_total', 'route') : {};

	const total = registry ? sumFamily(registry, 'kvstream_requests_total') : undefined;

	// Once the counter is declared, an outcome with no series has occurred zero
	// times — the series only appears on first increment.
	const declared = registry ? isDeclaredCounter(registry, 'kvstream_requests_total') : false;
	const outcome = (name: string): number | undefined => byOutcome[name] ?? (declared ? 0 : undefined);

	const servedTotal = SERVED_OUTCOMES.reduce<number | undefined>((acc, name) => {
		const value = outcome(name);
		if (value === undefined) {
			return acc;
		}
		return (acc ?? 0) + value;
	}, undefined);

	// `error` is a gateway or backend failure. `client_error` is a malformed
	// request and says nothing about service health, so it is not folded in.
	const failed = outcome('error');
	const rejected = outcome('rejected');

	// Running requests are a *count*; `kvstream_in_flight` is reserved budget,
	// which in tokens mode is not a count at all. Only `admission.active` and
	// `kvstream_active_requests` answer this question.
	const running = admission?.active ?? (registry ? gaugeValue(registry, 'kvstream_active_requests') : undefined);
	const queued =
		admission?.waiting ?? admission?.queue?.depth ?? (registry ? gaugeValue(registry, 'kvstream_queue_depth') : undefined);

	return {
		totalRequests: measured(total, metricsReason),
		byOutcome,
		byRoute,
		running: measured(running, admission ? NO_SOURCE : metricsReason),
		queued: measured(queued, admission ? NO_SOURCE : metricsReason),
		failed: measured(failed, metricsReason),
		served: measured(servedTotal, metricsReason),
		rejected: measured(rejected, metricsReason),
	};
}

export function deriveBudget(
	registry: PromRegistry | undefined,
	admission: AdmissionStats | undefined,
): BudgetMetrics {
	const reason = admission ? NO_SOURCE : registry ? NO_SOURCE : NO_METRICS;

	const total = admission?.budget ?? (registry ? gaugeValue(registry, 'kvstream_budget') : undefined);
	const used = admission?.inFlight ?? (registry ? gaugeValue(registry, 'kvstream_in_flight') : undefined);

	// Utilization is only computed from two values in the same unit, both of
	// which came from the same source. A reported one is preferred over a
	// computed one so the gateway stays the authority on its own rounding.
	let utilization = admission?.utilization;
	if (utilization === undefined) {
		utilization = registry ? gaugeValue(registry, 'kvstream_budget_utilization') : undefined;
	}
	if (utilization === undefined && total !== undefined && used !== undefined && total > 0) {
		utilization = used / total;
	}

	const remaining = total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined;

	return {
		unit: admission?.unit,
		used: measured(used, reason),
		total: measured(total, reason),
		remaining: measured(remaining, reason),
		utilization: measured(utilization, reason),
	};
}

/**
 * The sample fed to the history store.
 *
 * Throughput is derived from `kvstream_requests_total` because it is the only
 * counter documented as incrementing exactly once per request. `admission.completions`
 * counts admission releases, which is a different population (it excludes cache
 * hits and coalesced followers), so the two are never mixed in one series.
 */
export function historySample(
	requests: RequestMetrics,
	budget: BudgetMetrics,
): { totalRequests?: number; queueDepth?: number; running?: number; utilization?: number } {
	return {
		totalRequests: requests.totalRequests.value,
		queueDepth: requests.queued.value,
		running: requests.running.value,
		utilization: budget.utilization.value,
	};
}
