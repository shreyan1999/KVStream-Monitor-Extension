import * as assert from 'assert';
import { KVStreamClient } from '../../kvstream/client';
import { RequestError } from '../../kvstream/errors';
import { deriveBudget, deriveRequestMetrics } from '../../monitoring/derive';
import { HistoryStore } from '../../monitoring/historyStore';
import { MockGateway } from './mockGateway';

suite('Client against a mock gateway', function () {
	this.timeout(20_000);

	let gateway: MockGateway;
	let baseUrl: string;
	let client: KVStreamClient;

	setup(async () => {
		gateway = new MockGateway();
		baseUrl = await gateway.start();
		client = new KVStreamClient({ baseUrl, timeoutMs: 2000 });
	});

	teardown(async () => {
		await gateway.stop();
	});

	test('healthy gateway and backend', async () => {
		const health = await client.health();
		assert.strictEqual(health.ok, true);
		assert.strictEqual(health.status, 200);
		assert.strictEqual(health.body.backendServing, true);

		const status = await client.status();
		assert.strictEqual(status.admission?.budget, 4);

		const metrics = await client.metrics();
		const requests = deriveRequestMetrics(metrics, status.admission);
		assert.strictEqual(requests.running.value, 3);
		assert.strictEqual(requests.queued.value, 2);
		assert.strictEqual(deriveBudget(metrics, status.admission).utilization.value, 0.75);
	});

	test('a 503 from /health is data, not a failure', async () => {
		gateway.scenario = 'backendDegraded';
		const health = await client.health();
		assert.strictEqual(health.ok, false);
		assert.strictEqual(health.status, 503);
		assert.strictEqual(health.body.backendReachable, true);
		assert.strictEqual(health.body.backendServing, false);
		assert.ok(health.body.hint);
	});

	test('backend unreachable is reported by the gateway, not inferred', async () => {
		gateway.scenario = 'backendDown';
		const health = await client.health();
		assert.strictEqual(health.body.backendReachable, false);
		assert.strictEqual(health.body.circuitBreaker?.state, 'open');
	});

	test('a missing /metrics does not break /health or /status', async () => {
		gateway.scenario = 'noMetrics';
		const health = await client.health();
		assert.strictEqual(health.ok, true);
		const status = await client.status();
		assert.ok(status.admission);
		await assert.rejects(
			() => client.metrics(),
			(error: unknown) => error instanceof RequestError && error.kind === 'http' && error.status === 404,
		);
	});

	test('partial metrics yield unavailable values rather than zeros', async () => {
		gateway.scenario = 'partialMetrics';
		const metrics = await client.metrics();
		const requests = deriveRequestMetrics(metrics, undefined);
		assert.strictEqual(requests.totalRequests.value, undefined);
		assert.ok(requests.totalRequests.reason);
	});

	test('HTTP 500 is classified as an http error', async () => {
		gateway.scenario = 'serverError';
		await assert.rejects(
			() => client.status(),
			(error: unknown) => error instanceof RequestError && error.kind === 'http' && error.status === 500,
		);
	});

	test('invalid JSON is classified as a schema error', async () => {
		gateway.scenario = 'invalidJson';
		await assert.rejects(
			() => client.health(),
			(error: unknown) => error instanceof RequestError && error.kind === 'schema',
		);
	});

	test('a slow response times out as a timeout, not an outage', async () => {
		gateway.scenario = 'slow';
		gateway.slowMs = 1500;
		const impatient = new KVStreamClient({ baseUrl, timeoutMs: 200, healthTimeoutMs: 200 });
		await assert.rejects(
			() => impatient.health(),
			(error: unknown) => error instanceof RequestError && error.kind === 'timeout',
		);
	});

	test('/health gets a longer deadline than /status, for its readiness probe', async () => {
		// Measured on KVStream 1.0.0: /health ran a 1-token generation and took
		// 3.2 s while /status took 2 ms. A shared short deadline would time out
		// a perfectly healthy gateway.
		gateway.scenario = 'slow';
		gateway.slowMs = 600;
		const client2 = new KVStreamClient({ baseUrl, timeoutMs: 200 });
		const health = await client2.health();
		assert.strictEqual(health.ok, true);
		await assert.rejects(
			() => client2.status(),
			(error: unknown) => error instanceof RequestError && error.kind === 'timeout',
		);
	});

	test('a stopped gateway is classified as offline', async () => {
		await gateway.stop();
		await assert.rejects(
			() => client.health(),
			(error: unknown) => error instanceof RequestError && error.kind === 'offline',
		);
	});

	test('a restart mid-session resets the counter without inventing a rate', async () => {
		const history = new HistoryStore(600_000);
		const sample = async (t: number): Promise<void> => {
			const metrics = await client.metrics();
			const status = await client.status();
			const requests = deriveRequestMetrics(metrics, status.admission);
			history.record(t, { totalRequests: requests.totalRequests.value });
		};

		await sample(0);
		gateway.servedCounter = 128;
		await sample(1000);
		assert.strictEqual(history.throughput.size, 1);
		assert.strictEqual(history.throughput.last?.v, 10);

		// The gateway restarts: counters go back to a low value.
		gateway.servedCounter = 2;
		await sample(2000);
		assert.strictEqual(history.throughput.size, 1, 'no rate is reported across a reset');

		gateway.servedCounter = 7;
		await sample(3000);
		assert.strictEqual(history.throughput.size, 2);
		assert.strictEqual(history.throughput.last?.v, 5);
	});

	test('increasing queue depth is tracked over time', async () => {
		const history = new HistoryStore(600_000);
		for (let i = 0; i < 3; i++) {
			const status = await client.status();
			const requests = deriveRequestMetrics(undefined, status.admission);
			history.record(i * 1000, { queueDepth: requests.queued.value });
		}
		assert.strictEqual(history.queueDepth.size, 3);
		assert.strictEqual(history.queueDepth.last?.v, 2);
	});
});
