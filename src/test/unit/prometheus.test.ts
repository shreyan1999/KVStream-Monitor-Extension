import * as assert from 'assert';
import { gaugeValue, groupByLabel, parsePrometheus, sumFamily, sumWhere } from '../../kvstream/prometheus';
import { METRICS_PARTIAL, METRICS_TEXT } from '../fixtures/gatewayFixtures';

suite('Prometheus parser', () => {
	test('parses labelled counters into one family', () => {
		const registry = parsePrometheus(METRICS_TEXT);
		const family = registry.get('kvstream_requests_total');
		assert.ok(family, 'family should exist');
		assert.strictEqual(family.type, 'counter');
		assert.strictEqual(family.samples.length, 4);
		assert.strictEqual(sumFamily(registry, 'kvstream_requests_total'), 128);
	});

	test('reads gauge values', () => {
		const registry = parsePrometheus(METRICS_TEXT);
		assert.strictEqual(gaugeValue(registry, 'kvstream_budget'), 4);
		assert.strictEqual(gaugeValue(registry, 'kvstream_queue_depth'), 2);
		assert.strictEqual(gaugeValue(registry, 'kvstream_active_requests'), 3);
	});

	test('groups by label and filters by label match', () => {
		const registry = parsePrometheus(METRICS_TEXT);
		const byOutcome = groupByLabel(registry, 'kvstream_requests_total', 'outcome');
		assert.deepStrictEqual(byOutcome, { served: 118, rejected: 3, error: 2, cache_hit: 5 });
		assert.strictEqual(sumWhere(registry, 'kvstream_requests_total', { outcome: 'served' }), 118);
		assert.strictEqual(sumWhere(registry, 'kvstream_requests_total', { outcome: 'nope' }), undefined);
	});

	test('absent families read as undefined, not zero', () => {
		const registry = parsePrometheus(METRICS_PARTIAL);
		assert.strictEqual(sumFamily(registry, 'kvstream_requests_total'), undefined);
		assert.strictEqual(gaugeValue(registry, 'kvstream_budget'), undefined);
		assert.strictEqual(gaugeValue(registry, 'kvstream_backend_up'), 0, 'a reported zero is still zero');
	});

	test('drops +Inf and NaN samples', () => {
		const registry = parsePrometheus(
			['# TYPE a gauge', 'a +Inf', 'b NaN', 'c 1.5'].join('\n'),
		);
		assert.strictEqual(registry.get('a')?.samples.length, 0);
		assert.strictEqual(registry.get('b'), undefined);
		assert.strictEqual(gaugeValue(registry, 'c'), 1.5);
	});

	test('handles escaped quotes and braces inside label values', () => {
		const registry = parsePrometheus('m{detail="a \\"b\\" }c",k="v"} 7');
		const sample = registry.get('m')?.samples[0];
		assert.ok(sample);
		assert.strictEqual(sample.value, 7);
		assert.strictEqual(sample.labels['detail'], 'a "b" }c');
		assert.strictEqual(sample.labels['k'], 'v');
	});

	test('skips malformed lines without discarding the rest', () => {
		const registry = parsePrometheus(['garbage{unclosed 1', 'good 2', '', '  ', '#'].join('\n'));
		assert.strictEqual(gaugeValue(registry, 'good'), 2);
		assert.strictEqual(registry.get('garbage'), undefined);
	});

	test('histogram children stay addressable by their own names', () => {
		const registry = parsePrometheus(METRICS_TEXT);
		assert.strictEqual(gaugeValue(registry, 'kvstream_request_seconds_count'), 118);
		assert.strictEqual(registry.get('kvstream_request_seconds_bucket')?.samples.length, 2);
	});
});
