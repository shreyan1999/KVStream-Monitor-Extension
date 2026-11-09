import * as assert from 'assert';
import { deriveBudget, deriveRequestMetrics } from '../../monitoring/derive';
import { parseAdmission, parseStatus } from '../../kvstream/parsers';
import { parsePrometheus } from '../../kvstream/prometheus';
import { METRICS_PARTIAL, METRICS_TEXT, STATUS_CONCURRENCY } from '../fixtures/gatewayFixtures';

const registry = parsePrometheus(METRICS_TEXT);
const admission = parseStatus(STATUS_CONCURRENCY)?.admission;

suite('Metric derivation', () => {
	test('total requests is the sum over every route and outcome', () => {
		const requests = deriveRequestMetrics(registry, admission);
		assert.strictEqual(requests.totalRequests.value, 128);
	});

	test('route distribution comes from the route label', () => {
		const multi = parsePrometheus(
			[
				'# TYPE kvstream_requests_total counter',
				'kvstream_requests_total{outcome="served",route="chat"} 60',
				'kvstream_requests_total{outcome="error",route="chat"} 2',
				'kvstream_requests_total{outcome="served",route="embeddings"} 30',
			].join('\n'),
		);
		const requests = deriveRequestMetrics(multi, undefined);
		assert.deepStrictEqual(requests.byRoute, { chat: 62, embeddings: 30 });
		assert.deepStrictEqual(deriveRequestMetrics(undefined, undefined).byRoute, {});
	});

	test('served folds in cache hits and coalesced followers', () => {
		const requests = deriveRequestMetrics(registry, admission);
		assert.strictEqual(requests.served.value, 123);
	});

	test('client errors are not counted as service failures', () => {
		const withClientErrors = parsePrometheus(
			[
				'# TYPE kvstream_requests_total counter',
				'kvstream_requests_total{outcome="error",route="chat"} 2',
				'kvstream_requests_total{outcome="client_error",route="chat"} 9',
			].join('\n'),
		);
		const requests = deriveRequestMetrics(withClientErrors, undefined);
		assert.strictEqual(requests.failed.value, 2);
		assert.strictEqual(requests.byOutcome['client_error'], 9);
	});

	test('running requests come from the request count, never from in_flight budget', () => {
		const tokensAdmission = parseAdmission({
			unit: 'tokens',
			budget: 688,
			in_flight: 412,
			active: 5,
			waiting: 1,
		});
		const requests = deriveRequestMetrics(undefined, tokensAdmission);
		assert.strictEqual(requests.running.value, 5, 'must be the request count, not 412 tokens');
		assert.strictEqual(requests.queued.value, 1);
	});

	test('a missing metric is unavailable, not zero', () => {
		const requests = deriveRequestMetrics(parsePrometheus(METRICS_PARTIAL), undefined);
		assert.strictEqual(requests.totalRequests.value, undefined);
		assert.ok(requests.totalRequests.reason);
		assert.strictEqual(requests.running.value, undefined);
	});

	test('no metrics at all still reports a reason', () => {
		const requests = deriveRequestMetrics(undefined, undefined);
		assert.strictEqual(requests.totalRequests.value, undefined);
		assert.strictEqual(requests.totalRequests.reason, 'metrics endpoint unavailable');
	});

	test('budget carries its unit and the gateway rounding', () => {
		const budget = deriveBudget(registry, admission);
		assert.strictEqual(budget.unit, 'concurrency');
		assert.strictEqual(budget.total.value, 4);
		assert.strictEqual(budget.used.value, 3);
		assert.strictEqual(budget.remaining.value, 1);
		assert.strictEqual(budget.utilization.value, 0.75);
	});

	test('utilization is computed only when both parts are present', () => {
		const partial = parseAdmission({ unit: 'tokens', in_flight: 100 });
		const budget = deriveBudget(undefined, partial);
		assert.strictEqual(budget.total.value, undefined);
		assert.strictEqual(budget.utilization.value, undefined);
		assert.strictEqual(budget.remaining.value, undefined);
	});

	test('a zero budget does not produce a divide-by-zero utilization', () => {
		const zero = parseAdmission({ unit: 'tokens', budget: 0, in_flight: 0 });
		const budget = deriveBudget(undefined, zero);
		assert.strictEqual(budget.total.value, 0);
		assert.strictEqual(budget.utilization.value, undefined);
	});

	test('falls back to the gauges when /status has no admission block', () => {
		const budget = deriveBudget(registry, undefined);
		assert.strictEqual(budget.total.value, 4);
		assert.strictEqual(budget.used.value, 3);
		assert.strictEqual(budget.utilization.value, 0.75);
	});
});
