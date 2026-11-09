import * as assert from 'assert';
import { PollingScheduler } from '../../monitoring/pollingScheduler';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

suite('Polling scheduler', () => {
	test('never runs two cycles at once, even when the task is slower than the interval', async () => {
		let concurrent = 0;
		let peak = 0;
		let runs = 0;
		const scheduler = new PollingScheduler(async () => {
			concurrent++;
			peak = Math.max(peak, concurrent);
			runs++;
			await sleep(60);
			concurrent--;
			return true;
		}, 10);

		scheduler.start();
		await sleep(260);
		scheduler.stop();

		assert.strictEqual(peak, 1, 'cycles must not overlap');
		assert.ok(runs >= 2, `expected several cycles, saw ${runs}`);
	});

	test('stops scheduling after stop()', async () => {
		let runs = 0;
		const scheduler = new PollingScheduler(async () => {
			runs++;
			return true;
		}, 10);
		scheduler.start();
		await sleep(50);
		scheduler.stop();
		const settled = runs;
		await sleep(60);
		assert.strictEqual(runs, settled, 'no cycles after stop');
	});

	test('backs off after consecutive failures', async () => {
		const times: number[] = [];
		const scheduler = new PollingScheduler(async () => {
			times.push(Date.now());
			return false;
		}, 20);
		scheduler.start();
		await sleep(220);
		scheduler.stop();

		assert.ok(times.length >= 3, 'should have run at least three times');
		const first = times[1] - times[0];
		const later = times[times.length - 1] - times[times.length - 2];
		assert.ok(later > first, `expected backoff, got ${first}ms then ${later}ms`);
	});

	test('a trigger forgets the backoff, so a target that came back is polled at the normal rate', async () => {
		// Fail until `up`, as a gateway does while it is not running.
		let up = false;
		const times: number[] = [];
		const scheduler = new PollingScheduler(
			async () => {
				times.push(Date.now());
				return up;
			},
			10,
			10_000,
		);
		scheduler.start();
		await sleep(200); // several failures: the next delay is now 160 ms or more
		up = true;
		scheduler.trigger();
		const triggeredAt = Date.now();
		await sleep(80);
		scheduler.stop();

		const after = times.filter((t) => t >= triggeredAt);
		assert.ok(after.length >= 3, `expected normal-rate polling after the trigger, saw ${after.length} cycles in 80 ms`);
	});

	test('a trigger during a cycle runs once afterwards rather than concurrently', async () => {
		let concurrent = 0;
		let peak = 0;
		let runs = 0;
		const scheduler = new PollingScheduler(async () => {
			concurrent++;
			peak = Math.max(peak, concurrent);
			runs++;
			await sleep(40);
			concurrent--;
			return true;
		}, 10_000);
		scheduler.start();
		await sleep(10);
		scheduler.trigger();
		scheduler.trigger();
		await sleep(150);
		scheduler.stop();
		assert.strictEqual(peak, 1);
		assert.strictEqual(runs, 2, 'repeated triggers collapse into one extra cycle');
	});

	test('a throwing task counts as a failure instead of escaping', async () => {
		let runs = 0;
		const scheduler = new PollingScheduler(async () => {
			runs++;
			throw new Error('boom');
		}, 15);
		scheduler.start();
		await sleep(80);
		scheduler.stop();
		assert.ok(runs >= 2, 'the scheduler keeps going after a throw');
	});
});
