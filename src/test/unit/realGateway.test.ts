import * as assert from 'assert';
import { parseStatus } from '../../kvstream/parsers';
import { parsePrometheus } from '../../kvstream/prometheus';
import { deriveBudget, deriveRequestMetrics } from '../../monitoring/derive';
import { pickBackendEndpoint } from '../../foundry/detector';
import { REAL_METRICS_NO_TRAFFIC, REAL_STATUS_NO_BACKEND } from '../fixtures/realKvstream';

/**
 * Contract tests against payloads recorded from a real KVStream 1.0.0
 * gateway. These pin the behaviours that the source-derived fixtures did not
 * reveal and that only a live gateway did.
 */
suite('Real KVStream 1.0.0 payloads', () => {
	const status = parseStatus(REAL_STATUS_NO_BACKEND);
	const registry = parsePrometheus(REAL_METRICS_NO_TRAFFIC);

	test('/status parses, including the admission block', () => {
		assert.ok(status);
		assert.strictEqual(status.version, '1.0.0');
		assert.strictEqual(status.admission?.unit, 'concurrency');
		assert.strictEqual(status.admission?.budget, 8);
		assert.strictEqual(status.admission?.active, 0);
		assert.strictEqual(status.budgetSource?.source, 'config');
	});

	test('resolution.attempts is a list of strategy names', () => {
		assert.deepStrictEqual(status?.backend?.resolution?.attempts, ['foundry-cli(0.10.x)', 'scan']);
		assert.strictEqual(status?.backend?.resolution?.source, 'unresolved');
	});

	test('an unresolved backend is not shown at the configured default address', () => {
		// base_url is the default "http://localhost:5273" even though nothing
		// was found there. It must not be presented as a discovered endpoint.
		assert.strictEqual(status?.backend?.baseUrl, 'http://localhost:5273');
		const choice = pickBackendEndpoint(undefined, 'unresolved', undefined, status?.backend?.resolution?.detail);
		assert.strictEqual(choice.url, undefined);
		assert.ok(choice.detail.startsWith('KVStream: No Foundry Local endpoint found'));
	});

	test('a declared counter with no series yet is zero, not unavailable', () => {
		const requests = deriveRequestMetrics(registry, status?.admission);
		assert.strictEqual(requests.totalRequests.value, 0);
		assert.strictEqual(requests.served.value, 0);
		assert.strictEqual(requests.failed.value, 0);
		assert.strictEqual(requests.rejected.value, 0);
		assert.deepStrictEqual(requests.byRoute, {});
	});

	test('running and queued come from the admission block', () => {
		const requests = deriveRequestMetrics(registry, status?.admission);
		assert.strictEqual(requests.running.value, 0);
		assert.strictEqual(requests.queued.value, 0);
	});

	test('the budget is read in its reported unit', () => {
		const budget = deriveBudget(registry, status?.admission);
		assert.strictEqual(budget.unit, 'concurrency');
		assert.strictEqual(budget.total.value, 8);
		assert.strictEqual(budget.used.value, 0);
		assert.strictEqual(budget.utilization.value, 0);
	});

	test('prometheus_client _created gauges do not leak into request totals', () => {
		const created = [...registry.keys()].filter((name) => name.endsWith('_created'));
		assert.ok(created.length > 0, 'the real exposition carries _created families');
		const requests = deriveRequestMetrics(registry, undefined);
		assert.strictEqual(requests.totalRequests.value, 0);
	});
});
