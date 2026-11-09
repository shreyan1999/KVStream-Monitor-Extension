import * as assert from 'assert';
import { parseAdmission, parseHealth, parseStatus } from '../../kvstream/parsers';
import {
	HEALTH_BACKEND_DOWN,
	HEALTH_DEGRADED,
	HEALTH_SERVING,
	STATUS_CONCURRENCY,
	STATUS_MINIMAL,
} from '../fixtures/gatewayFixtures';

suite('Response validators', () => {
	test('reads a serving /health body', () => {
		const body = parseHealth(HEALTH_SERVING);
		assert.ok(body);
		assert.strictEqual(body.backendServing, true);
		assert.strictEqual(body.backendReachable, true);
		assert.strictEqual(body.model, 'Phi-3-mini-4k-instruct-generic-gpu:2');
		assert.strictEqual(body.readiness?.ready, true);
		assert.strictEqual(body.circuitBreaker?.state, 'closed');
		assert.strictEqual(body.drift?.ratio, 1.066);
	});

	test('reads the 503 body, including the hint', () => {
		const body = parseHealth(HEALTH_DEGRADED);
		assert.ok(body);
		assert.strictEqual(body.backendReachable, true);
		assert.strictEqual(body.backendServing, false);
		assert.ok(body.hint && body.hint.includes('not serving'));
	});

	test('a null model is absent rather than the string "null"', () => {
		const body = parseHealth(HEALTH_BACKEND_DOWN);
		assert.ok(body);
		assert.strictEqual(body.model, undefined);
		assert.strictEqual(body.circuitBreaker?.state, 'open');
	});

	test('rejects a body that is not an object', () => {
		assert.strictEqual(parseHealth('ok'), undefined);
		assert.strictEqual(parseHealth(null), undefined);
		assert.strictEqual(parseHealth([1, 2]), undefined);
		assert.strictEqual(parseStatus(42), undefined);
	});

	test('reads the admission block', () => {
		const status = parseStatus(STATUS_CONCURRENCY);
		assert.ok(status);
		assert.strictEqual(status.admission?.unit, 'concurrency');
		assert.strictEqual(status.admission?.budget, 4);
		assert.strictEqual(status.admission?.active, 3);
		assert.strictEqual(status.admission?.waiting, 2);
		assert.strictEqual(status.admission?.queue?.oldestWaitSeconds, 1.42);
		assert.strictEqual(status.backend?.resolution?.source, 'foundry-cli');
		assert.strictEqual(status.budgetSource?.source, 'fallback:concurrency');
		assert.strictEqual(status.runtimeProfile?.regime, 'unknown');
		assert.deepStrictEqual(status.model?.inventory?.loaded, ['Phi-3-mini-4k-instruct-generic-gpu:2']);
	});

	test('a build that reports no admission block yields undefined, not zeros', () => {
		const status = parseStatus(STATUS_MINIMAL);
		assert.ok(status);
		assert.strictEqual(status.admission, undefined);
		assert.strictEqual(status.backend, undefined);
	});

	test('fields of the wrong type are dropped, not coerced', () => {
		const admission = parseAdmission({
			unit: 'tokens',
			budget: '600',
			in_flight: 12,
			waiting: null,
			active: true,
		});
		assert.ok(admission);
		assert.strictEqual(admission.budget, undefined);
		assert.strictEqual(admission.inFlight, 12);
		assert.strictEqual(admission.waiting, undefined);
		assert.strictEqual(admission.active, undefined);
	});

	test('negative counts are rejected as impossible', () => {
		const admission = parseAdmission({ unit: 'tokens', budget: -5, in_flight: 3, waiting: -1 });
		assert.ok(admission);
		assert.strictEqual(admission.budget, undefined);
		assert.strictEqual(admission.waiting, undefined);
		assert.strictEqual(admission.inFlight, 3);
	});

	test('NaN and Infinity are rejected', () => {
		const admission = parseAdmission({ budget: Number.NaN, in_flight: Number.POSITIVE_INFINITY });
		assert.ok(admission);
		assert.strictEqual(admission.budget, undefined);
		assert.strictEqual(admission.inFlight, undefined);
	});
});
