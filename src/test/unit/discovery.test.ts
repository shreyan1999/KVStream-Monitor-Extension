import * as assert from 'assert';
import {
	applyLiveness,
	parseCacheList,
	parseServerStatus,
	parseSystemInfo,
	pickBackendEndpoint,
	presentBackend,
	sanitiseUrls,
	type FoundrySnapshot,
} from '../../foundry/detector';

function snapshot(overrides: Partial<FoundrySnapshot> = {}): FoundrySnapshot {
	return {
		cliAvailable: true,
		daemonState: 'ready',
		daemonRunning: true,
		candidates: [],
		staleCandidates: [],
		notes: [],
		collectedAt: Date.now(),
		...overrides,
	};
}

suite('Foundry URL sanitising', () => {
	test('keeps only http(s) origins and de-duplicates', () => {
		assert.deepStrictEqual(
			sanitiseUrls([
				'http://127.0.0.1:64524',
				'http://127.0.0.1:64524/openai/status',
				'https://host:1',
				'not a url',
				42,
				'file:///tmp/x',
			]),
			['http://127.0.0.1:64524', 'https://host:1'],
		);
	});

	test('a non-array yields nothing', () => {
		assert.deepStrictEqual(sanitiseUrls(undefined), []);
		assert.deepStrictEqual(sanitiseUrls('http://x'), []);
	});
});

suite('Foundry system info', () => {
	test('reads the shape `foundry status --output json` returns', () => {
		const info = parseSystemInfo({
			system: {
				gpus: [{ name: 'NVIDIA GeForce GTX 1660 SUPER', vendor: 'NVIDIA', videoMemoryBytes: 6255804416 }],
				totalMemoryBytes: 17098465280,
				availableMemoryBytes: 8791953408,
			},
		});
		assert.ok(info);
		assert.strictEqual(info.gpus[0].name, 'NVIDIA GeForce GTX 1660 SUPER');
		assert.strictEqual(info.gpus[0].videoMemoryBytes, 6255804416);
		assert.strictEqual(info.totalMemoryBytes, 17098465280);
	});

	test('bad entries are dropped, not guessed', () => {
		const info = parseSystemInfo({
			system: { gpus: [{ vendor: 'NVIDIA' }, 'x'], totalMemoryBytes: '17GB', availableMemoryBytes: -1 },
		});
		assert.ok(info);
		assert.strictEqual(info.gpus.length, 0);
		assert.strictEqual(info.totalMemoryBytes, undefined);
		assert.strictEqual(info.availableMemoryBytes, undefined);
	});

	test('a document with no system block yields nothing', () => {
		assert.strictEqual(parseSystemInfo({ service: {} }), undefined);
		assert.strictEqual(parseSystemInfo(null), undefined);
	});
});

suite('Backend endpoint choice', () => {
	test('KVStream wins over the CLI', () => {
		const choice = pickBackendEndpoint(
			'http://127.0.0.1:51264',
			'foundry-cli',
			snapshot({ candidates: ['http://127.0.0.1:9999'] }),
		);
		assert.strictEqual(choice.url, 'http://127.0.0.1:51264');
		assert.strictEqual(choice.source, 'kvstream');
	});

	test('a single CLI candidate is used when KVStream reported nothing', () => {
		const choice = pickBackendEndpoint(undefined, undefined, snapshot({ candidates: ['http://127.0.0.1:64524'] }));
		assert.strictEqual(choice.url, 'http://127.0.0.1:64524');
		assert.strictEqual(choice.source, 'foundry-cli');
	});

	test('several candidates are reported as ambiguous, never picked arbitrarily', () => {
		const choice = pickBackendEndpoint(
			undefined,
			undefined,
			snapshot({ candidates: ['http://127.0.0.1:1', 'http://127.0.0.1:2'] }),
		);
		assert.strictEqual(choice.url, undefined);
		assert.strictEqual(choice.source, 'ambiguous');
		assert.strictEqual(choice.candidates.length, 2);
	});

	test('a live daemon reporting state "ready" counts as running', () => {
		// Foundry Local CLI 0.12.1 reports a running daemon as state "ready";
		// only the `running` boolean says whether it is up.
		const choice = pickBackendEndpoint(undefined, undefined, snapshot({ daemonState: 'ready', daemonRunning: true }));
		assert.ok(choice.detail.includes('running but reported no endpoint'));
	});

	test('a stale URL from a stopped daemon is not offered as an endpoint', () => {
		const choice = pickBackendEndpoint(
			undefined,
			undefined,
			snapshot({ daemonState: 'not_running', daemonRunning: false, candidates: [], staleCandidates: ['http://127.0.0.1:64524'] }),
		);
		assert.strictEqual(choice.url, undefined);
		assert.ok(choice.detail.includes('not running'));
	});

	test('no CLI and no gateway data says so instead of inventing a port', () => {
		const choice = pickBackendEndpoint(undefined, undefined, snapshot({ cliAvailable: false, daemonState: 'unknown', daemonRunning: false }));
		assert.strictEqual(choice.url, undefined);
		assert.strictEqual(choice.source, 'none');
		assert.ok(choice.detail.includes('Foundry CLI is unavailable'));
	});
});

suite('Foundry daemon liveness', () => {
	test('reads a live daemon from `foundry server status --output json`', () => {
		const live = parseServerStatus(
			{ running: true, state: 'ready', pid: 4321, webUrls: ['http://127.0.0.1:64524/'], uptime: '0d 0h 2m 5s' },
			1000,
		);
		assert.ok(live);
		assert.strictEqual(live.daemonRunning, true);
		assert.strictEqual(live.daemonState, 'ready');
		assert.strictEqual(live.pid, 4321);
		assert.strictEqual(live.uptime, '0d 0h 2m 5s');
		assert.deepStrictEqual(live.candidates, ['http://127.0.0.1:64524']);
		assert.deepStrictEqual(live.staleCandidates, []);
		assert.strictEqual(live.collectedAt, 1000);
	});

	test('a stopped daemon keeps its old URL, pid and uptime out of the live fields', () => {
		// Verified on 0.12.1: all three survive the daemon exiting.
		const live = parseServerStatus({
			running: false,
			state: 'not_running',
			pid: 14524,
			webUrls: ['http://127.0.0.1:64524'],
			uptime: '1d 20h 5m 22s',
		});
		assert.ok(live);
		assert.strictEqual(live.daemonRunning, false);
		assert.strictEqual(live.pid, undefined);
		assert.strictEqual(live.uptime, undefined);
		assert.deepStrictEqual(live.candidates, []);
		assert.deepStrictEqual(live.staleCandidates, ['http://127.0.0.1:64524']);
	});

	test('an unreadable document is a miss, not "not running"', () => {
		assert.strictEqual(parseServerStatus(undefined), undefined);
		assert.strictEqual(parseServerStatus({ state: 'ready' }), undefined);
		assert.strictEqual(parseServerStatus({ running: 'yes' }), undefined);
	});

	test('a liveness reading replaces daemon fields and keeps hardware', () => {
		const base = snapshot({
			cliAvailable: false,
			cliVersion: '0.12.1',
			daemonRunning: false,
			daemonState: 'not_running',
			system: { gpus: [{ name: 'GPU' }], totalMemoryBytes: 1 },
			collectedAt: 5,
		});
		const merged = applyLiveness(base, {
			daemonState: 'ready',
			daemonRunning: true,
			candidates: ['http://127.0.0.1:1'],
			staleCandidates: [],
			uptime: '3s',
			collectedAt: 10,
		});
		assert.strictEqual(merged.cliAvailable, true);
		assert.strictEqual(merged.daemonRunning, true);
		assert.strictEqual(merged.uptime, '3s');
		assert.deepStrictEqual(merged.candidates, ['http://127.0.0.1:1']);
		assert.strictEqual(merged.cliVersion, '0.12.1');
		assert.strictEqual(merged.system?.gpus[0].name, 'GPU');
		assert.strictEqual(merged.collectedAt, 5);
	});

	test('a liveness reading with no prior snapshot stands on its own', () => {
		const merged = applyLiveness(undefined, {
			daemonState: 'not_running',
			daemonRunning: false,
			candidates: [],
			staleCandidates: [],
			collectedAt: 7,
		});
		assert.strictEqual(merged.cliAvailable, true);
		assert.strictEqual(merged.daemonRunning, false);
		assert.deepStrictEqual(merged.notes, []);
		assert.strictEqual(merged.collectedAt, 7);
	});
});

suite('Foundry Local card: address and model', () => {
	const resolved = pickBackendEndpoint('http://127.0.0.1:54419', 'foundry-cli', snapshot());
	const model = { id: 'Phi-3-mini-4k-instruct-generic-gpu:2', source: 'auto-detected' };

	test('a serving backend shows what KVStream reported', () => {
		const shown = presentBackend('serving', resolved, model);
		assert.strictEqual(shown.url, 'http://127.0.0.1:54419');
		assert.strictEqual(shown.source, 'kvstream');
		assert.strictEqual(shown.model, model.id);
		assert.strictEqual(shown.modelSource, 'auto-detected');
	});

	test('a stopped daemon hides the dead address and model KVStream still reports', () => {
		const shown = presentBackend('stopped', resolved, model);
		assert.strictEqual(shown.url, undefined);
		assert.strictEqual(shown.model, undefined);
		assert.strictEqual(shown.modelSource, undefined);
		assert.strictEqual(shown.source, 'none');
		assert.strictEqual(shown.detail, 'Foundry Local is not running');
	});

	test('a booting daemon hides them too: it comes up on a new port with nothing loaded', () => {
		const shown = presentBackend('starting', resolved, model);
		assert.strictEqual(shown.url, undefined);
		assert.strictEqual(shown.model, undefined);
		assert.strictEqual(shown.detail, 'Foundry Local is starting');
	});

	test('a running daemon with no gateway still shows the CLI-reported address', () => {
		const viaCli = pickBackendEndpoint(undefined, undefined, snapshot({ candidates: ['http://127.0.0.1:64524'] }));
		const shown = presentBackend('running', viaCli, {});
		assert.strictEqual(shown.url, 'http://127.0.0.1:64524');
		assert.strictEqual(shown.source, 'foundry-cli');
		assert.strictEqual(shown.model, undefined);
	});
});

suite('Foundry model cache', () => {
	test('reads `foundry cache list --output json` as CLI 0.10.3 prints it', () => {
		// Recorded on this machine, with Foundry Local running and nothing loaded.
		const models = parseCacheList({
			models: [
				{ alias: 'phi-3-mini-4k', id: 'Phi-3-mini-4k-instruct-generic-gpu:2', device: 'Gpu', fileSizeMb: 2181, cached: true, loaded: false },
				{ alias: 'qwen2.5-7b', id: 'qwen2.5-7b-instruct-cuda-gpu:4', device: 'Gpu', fileSizeMb: 4843, cached: true, loaded: true },
			],
		});
		assert.deepStrictEqual(models, [
			{ id: 'Phi-3-mini-4k-instruct-generic-gpu:2', alias: 'phi-3-mini-4k', device: 'Gpu', fileSizeMb: 2181, loaded: false },
			{ id: 'qwen2.5-7b-instruct-cuda-gpu:4', alias: 'qwen2.5-7b', device: 'Gpu', fileSizeMb: 4843, loaded: true },
		]);
	});

	test('entries without an id are dropped; a missing loaded flag stays unknown', () => {
		const models = parseCacheList({ models: [{ alias: 'x' }, 'junk', { id: '' }, { id: 'm:1', fileSizeMb: -5 }] });
		assert.deepStrictEqual(models, [{ id: 'm:1', alias: undefined, device: undefined, fileSizeMb: undefined, loaded: undefined }]);
	});

	test('a document of another shape is unreadable, not an empty cache', () => {
		assert.strictEqual(parseCacheList({ items: [] }), undefined);
		assert.strictEqual(parseCacheList(undefined), undefined);
		assert.deepStrictEqual(parseCacheList({ models: [] }), []);
	});

	test('with no model loaded the card keeps the live address but shows no model', () => {
		const resolved = pickBackendEndpoint('http://127.0.0.1:56303', 'foundry-cli', snapshot());
		const shown = presentBackend('no_model', resolved, {});
		assert.strictEqual(shown.url, 'http://127.0.0.1:56303');
		assert.strictEqual(shown.model, undefined);
	});
});
