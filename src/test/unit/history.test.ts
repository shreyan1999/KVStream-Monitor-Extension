import * as assert from 'assert';
import { HistoryStore, RateTracker, Series } from '../../monitoring/historyStore';

suite('History store', () => {
	test('drops points outside the window', () => {
		const series = new Series(1000);
		series.push(0, 1);
		series.push(500, 2);
		// Window is measured back from the newest sample: at t=1200 the cutoff
		// is t=200, so the first point ages out and the second does not.
		series.push(1200, 3);
		assert.deepStrictEqual(
			series.snapshot().map((p) => p.v),
			[2, 3],
		);
		series.push(1700, 4);
		assert.deepStrictEqual(
			series.snapshot().map((p) => p.v),
			[3, 4],
		);
	});

	test('enforces a hard point cap as well as the window', () => {
		const series = new Series(10_000_000, 5);
		for (let i = 0; i < 50; i++) {
			series.push(i, i);
		}
		assert.strictEqual(series.size, 5);
		assert.strictEqual(series.last?.v, 49);
	});

	test('ignores out-of-order samples', () => {
		const series = new Series(10_000);
		series.push(1000, 1);
		series.push(500, 99);
		assert.strictEqual(series.size, 1);
		assert.strictEqual(series.last?.v, 1);
	});

	test('ignores non-finite values', () => {
		const series = new Series(10_000);
		series.push(1, Number.NaN);
		series.push(2, Number.POSITIVE_INFINITY);
		assert.strictEqual(series.size, 0);
	});
});

suite('Rate tracker', () => {
	test('first sample establishes a baseline and yields nothing', () => {
		const tracker = new RateTracker();
		assert.strictEqual(tracker.observe(0, 10), undefined);
	});

	test('computes units per second', () => {
		const tracker = new RateTracker();
		tracker.observe(0, 10);
		assert.strictEqual(tracker.observe(2000, 30), 10);
	});

	test('a counter reset produces no rate for that interval', () => {
		const tracker = new RateTracker();
		tracker.observe(0, 100);
		assert.strictEqual(tracker.observe(1000, 5), undefined, 'restart must not report a rate');
		assert.strictEqual(tracker.observe(2000, 15), 10, 'the next interval is measurable again');
	});

	test('a zero or negative interval yields nothing', () => {
		const tracker = new RateTracker();
		tracker.observe(1000, 10);
		assert.strictEqual(tracker.observe(1000, 20), undefined);
	});
});

suite('History store wiring', () => {
	test('records throughput only once a rate can be computed', () => {
		const store = new HistoryStore(60_000);
		store.record(0, { totalRequests: 10, queueDepth: 1, utilization: 0.5 });
		assert.strictEqual(store.throughput.size, 0);
		assert.strictEqual(store.queueDepth.size, 1);
		store.record(1000, { totalRequests: 15, queueDepth: 2, utilization: 0.6 });
		assert.strictEqual(store.throughput.size, 1);
		assert.strictEqual(store.throughput.last?.v, 5);
	});

	test('a gap in continuity does not average across dead time', () => {
		const store = new HistoryStore(600_000);
		store.record(0, { totalRequests: 10 });
		store.record(1000, { totalRequests: 20 });
		store.breakContinuity();
		store.record(300_000, { totalRequests: 5000 });
		assert.strictEqual(store.throughput.size, 1, 'no rate across the gap');
		store.record(301_000, { totalRequests: 5010 });
		assert.strictEqual(store.throughput.size, 2);
		assert.strictEqual(store.throughput.last?.v, 10);
	});

	test('a missing total resets the baseline rather than guessing', () => {
		const store = new HistoryStore(60_000);
		store.record(0, { totalRequests: 10 });
		store.record(1000, {});
		store.record(2000, { totalRequests: 40 });
		assert.strictEqual(store.throughput.size, 0);
	});

	test('records running requests as its own series', () => {
		const store = new HistoryStore(60_000);
		store.record(0, { running: 3 });
		store.record(1000, { running: 5 });
		assert.deepStrictEqual(store.running.snapshot().map((p) => p.v), [3, 5]);
	});

	test('clear empties every series', () => {
		const store = new HistoryStore(60_000);
		store.record(0, { totalRequests: 1, queueDepth: 1, utilization: 0.1 });
		store.record(1000, { totalRequests: 2, queueDepth: 1, utilization: 0.1 });
		store.clear();
		assert.strictEqual(store.throughput.size, 0);
		assert.strictEqual(store.queueDepth.size, 0);
		assert.strictEqual(store.utilization.size, 0);
	});
});
