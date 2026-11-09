import * as assert from 'assert';
import { describe } from '../../views/statusBar';
import type { ViewModel } from '../../types/viewModel';

function model(overrides: Partial<ViewModel> = {}): ViewModel {
	return {
		service: 'healthy',
		backend: 'serving',
		connection: { gatewayUrl: 'http://127.0.0.1:8080', foundryCandidates: [] },
		requests: {
			totalRequests: { value: 128 },
			byOutcome: {},
			byRoute: {},
			running: { value: 8 },
			queued: { value: 2 },
			failed: { value: 0 },
			served: { value: 123 },
			rejected: { value: 3 },
		},
		budget: { used: {}, total: {}, remaining: {}, utilization: {} },
		queueOldestWaitSeconds: {},
		drainRatePerSecond: {},
		resources: {},
		trends: { throughput: [], queueDepth: [], running: [], utilization: [], windowMs: 1000, maxGapMs: 1000 },
		process: { ownedByExtension: false, state: 'none' },
		capabilities: {
			canStopKvstream: false,
			canRestartKvstream: false,
			canStartKvstream: true,
			canControlFoundry: false,
		canLoadModel: false,
			liveLogs: false,
			calibrate: true,
			reasons: {},
		},
		stale: false,
		autoRefresh: true,
		errors: [],
		busy: [],
		...overrides,
	};
}

suite('Status bar text', () => {
	test('shows counts when the gateway reported them', () => {
		assert.strictEqual(describe(model()).text, '$(pulse) KVStream: 8 running · 2 queued');
	});

	test('a disconnected gateway never shows zeros', () => {
		const text = describe(model({ service: 'disconnected' })).text;
		assert.ok(text.includes('disconnected'));
		assert.ok(!text.includes('0 running'));
	});

	test('unavailable counts are omitted rather than rendered as zero', () => {
		const state = model();
		state.requests.running = { reason: 'not reported' };
		state.requests.queued = { reason: 'not reported' };
		assert.strictEqual(describe(state).text, '$(pulse) KVStream: healthy');
	});

	test('a reported zero is shown as zero', () => {
		const state = model();
		state.requests.running = { value: 0 };
		state.requests.queued = { value: 0 };
		assert.strictEqual(describe(state).text, '$(pulse) KVStream: 0 running · 0 queued');
	});

	test('degraded is flagged as a warning', () => {
		const result = describe(model({ service: 'degraded' }));
		assert.strictEqual(result.warn, true);
	});

	test('stale data is marked', () => {
		assert.ok(describe(model({ stale: true })).text.endsWith('(stale)'));
	});

	test('an error surfaces its message as the tooltip', () => {
		const result = describe(
			model({ service: 'error', errors: [{ kind: 'schema', message: '/status did not return valid JSON' }] }),
		);
		assert.strictEqual(result.tooltip, '/status did not return valid JSON');
		assert.strictEqual(result.warn, true);
	});
});
