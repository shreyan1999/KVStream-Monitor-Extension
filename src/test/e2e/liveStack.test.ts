import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../extension';
import type { ViewModel } from '../../types/viewModel';
import { describe as describeStatusBar } from '../../views/statusBar';

/**
 * Live end-to-end run against the real Foundry Local and KVStream on this
 * machine, driven through the dashboard's Quick Actions.
 *
 * Each step delivers the exact message a Quick Actions button posts
 * (`{ action: 'startFoundry' }`, ...) to the open dashboard's host, so it goes
 * through the same validation and dispatch as a click. Modal confirmations are
 * answered with their confirm button and recorded.
 *
 * It starts and stops machine-wide services, so it only runs when asked:
 *
 *   KVSTREAM_E2E=1 npx vscode-test --run out/test/e2e/liveStack.test.js
 *
 * Optional: KVSTREAM_E2E_MODEL (a cached Foundry model id to load) and
 * KVSTREAM_E2E_OUT (where the JSON report goes).
 */

const ENABLED = process.env.KVSTREAM_E2E === '1';
const MODEL = process.env.KVSTREAM_E2E_MODEL ?? 'Phi-3-mini-4k-instruct-generic-gpu:2';
const OUT_DIR = process.env.KVSTREAM_E2E_OUT ?? path.join(os.tmpdir(), 'kvstream-e2e');

interface Exec {
	code: number | null;
	stdout: string;
	stderr: string;
}

function foundry(args: string[], timeoutMs = 120_000): Promise<Exec> {
	// Asynchronous on purpose: a blocking spawn would freeze the extension
	// host, and with it the very polling this test is watching.
	return new Promise((resolve) => {
		execFile('foundry', args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
			const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** `running`, `booting` (CLI 0.10.3: `running: false, state: "initializing"`) or `stopped`. */
async function daemonPhase(): Promise<'running' | 'booting' | 'stopped'> {
	const result = await foundry(['server', 'status', '--output', 'json'], 30_000);
	try {
		const status = JSON.parse(result.stdout.trim()) as { running?: boolean; state?: string };
		if (status.running === true) {
			return 'running';
		}
		return status.state === 'initializing' || status.state === 'starting' ? 'booting' : 'stopped';
	} catch {
		return 'stopped';
	}
}

async function daemonRunning(): Promise<boolean> {
	return (await daemonPhase()) !== 'stopped';
}

function summary(s: ViewModel): string {
	return JSON.stringify({
		service: s.service,
		backend: s.backend,
		daemon: s.connection.foundryDaemonState,
		backendUrl: s.connection.backendUrl,
		model: s.connection.model,
		process: s.process.state,
		total: s.requests.totalRequests.value,
		busy: s.busy,
		errors: s.errors.map((e) => e.message),
	});
}

(ENABLED ? suite : suite.skip)('Live stack: Quick Actions against real Foundry Local and KVStream', function () {
	this.timeout(20 * 60_000);

	let api: TestApi;
	const startedAt = Date.now();
	const timeline: { t: number; service: string; backend: string; daemon?: string; uptime?: string; process: string; total?: number; busy: string[] }[] = [];
	const frames: Record<string, ViewModel> = {};
	const prompts: { t: number; text: string }[] = [];
	const notices: { t: number; kind: string; text: string }[] = [];
	const quickPicks: { t: number; title?: string; items: string[]; chose?: string }[] = [];
	const results: Record<string, unknown> = {};
	let foundryWasRunning = false;
	let recorder: vscode.Disposable | undefined;

	const window = vscode.window as unknown as Record<string, unknown>;
	const originals = {
		warn: window['showWarningMessage'],
		info: window['showInformationMessage'],
		error: window['showErrorMessage'],
		quickPick: window['showQuickPick'],
	};

	function waitFor(predicate: (s: ViewModel) => boolean, timeoutMs: number, what: string): Promise<{ state: ViewModel; ms: number }> {
		const begin = Date.now();
		return new Promise((resolve, reject) => {
			let done = false;
			let subscription: vscode.Disposable | undefined;
			const finish = (state: ViewModel): void => {
				done = true;
				subscription?.dispose();
				clearTimeout(timer);
				resolve({ state, ms: Date.now() - begin });
			};
			const timer = setTimeout(() => {
				subscription?.dispose();
				if (!done) {
					reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${what}. Last state: ${summary(api.monitor.state)}`));
				}
			}, timeoutMs);
			subscription = api.monitor.onDidChange((s) => {
				if (!done && predicate(s)) {
					finish(s);
				}
			});
			const now = api.monitor.state;
			if (!done && predicate(now)) {
				finish(now);
			}
		});
	}

	/** The first notification matching `pattern` raised at or after `since`. */
	async function waitForNotice(pattern: RegExp, since: number, timeoutMs: number): Promise<{ kind: string; text: string; ms: number }> {
		const begin = Date.now();
		while (Date.now() - begin < timeoutMs) {
			const hit = notices.find((n) => n.t >= since && pattern.test(n.text));
			if (hit) {
				return { kind: hit.kind, text: hit.text, ms: Date.now() - begin };
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		throw new Error(`No notification matching ${pattern} within ${timeoutMs} ms. Seen: ${JSON.stringify(notices.slice(-5))}`);
	}

	async function waitForPrompt(pattern: RegExp, since: number, timeoutMs = 10_000): Promise<string> {
		const begin = Date.now();
		while (Date.now() - begin < timeoutMs) {
			const hit = prompts.find((p) => p.t >= since && pattern.test(p.text));
			if (hit) {
				return hit.text;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(
			`The confirmation ${pattern} never appeared. If no prompt was recorded at all, the dialog stub ` +
				'is not shared with the extension and a real modal is open in the test window.',
		);
	}

	function click(action: string): number {
		const t = Date.now();
		api.postFromDashboard({ action });
		return t;
	}

	suiteSetup(async function () {
		this.timeout(120_000);
		fs.mkdirSync(OUT_DIR, { recursive: true });

		// Answer modal confirmations with their confirm button; record everything.
		window['showWarningMessage'] = (message: string, ...rest: unknown[]) => {
			const options = rest[0] as { modal?: boolean } | undefined;
			if (options && typeof options === 'object' && options.modal) {
				prompts.push({ t: Date.now(), text: message });
				return Promise.resolve(rest[rest.length - 1]);
			}
			notices.push({ t: Date.now(), kind: 'warning', text: message });
			return Promise.resolve(undefined);
		};
		window['showInformationMessage'] = (message: string) => {
			notices.push({ t: Date.now(), kind: 'info', text: message });
			return Promise.resolve(undefined);
		};
		window['showErrorMessage'] = (message: string) => {
			notices.push({ t: Date.now(), kind: 'error', text: message });
			return Promise.resolve(undefined);
		};
		// "Load model…" asks which model: choose MODEL, as a user would.
		window['showQuickPick'] = async (items: unknown, options?: { title?: string }) => {
			const list = (await items) as { label: string; description?: string }[];
			const chosen = list.find((item) => item.description === MODEL);
			quickPicks.push({
				t: Date.now(),
				title: options?.title,
				items: list.map((item) => `${item.label} | ${item.description ?? ''}`),
				chose: chosen?.description,
			});
			return chosen;
		};

		const extension = vscode.extensions.all.find((item) => item.id.endsWith('.kvstream-monitor'));
		assert.ok(extension, 'extension not installed in the test host');
		const exported = (await extension.activate()) as TestApi | undefined;
		assert.ok(exported, 'activate() returned no test API; is the host in ExtensionMode.Test?');
		api = exported;

		recorder = api.monitor.onDidChange((s) => {
			timeline.push({
				t: Date.now() - startedAt,
				service: s.service,
				backend: s.backend,
				daemon: s.connection.foundryDaemonState,
				uptime: s.connection.foundryUptime,
				process: s.process.state,
				total: s.requests.totalRequests.value,
				busy: s.busy,
			});
		});

		foundryWasRunning = await daemonRunning();
		results['foundryRunningBeforeTest'] = foundryWasRunning;

		// The sidebar (now a menu) and the dashboard, as a user would have them.
		await vscode.commands.executeCommand('kvstream-monitor.openMonitor');
		await vscode.commands.executeCommand('kvstream-monitor.openDashboard');
	});

	suiteTeardown(async function () {
		this.timeout(120_000);
		recorder?.dispose();
		window['showWarningMessage'] = originals.warn;
		window['showInformationMessage'] = originals.info;
		window['showErrorMessage'] = originals.error;
		window['showQuickPick'] = originals.quickPick;

		// Leave the machine as it was found. A daemon something else revived
		// may still be booting; wait for it to settle before stopping it.
		if (!foundryWasRunning) {
			for (let i = 0; i < 30; i++) {
				const phase = await daemonPhase();
				if (phase === 'stopped') {
					break;
				}
				if (phase === 'running') {
					const stop = await foundry(['server', 'stop']);
					results['teardownStoppedFoundry'] = stop.code === 0;
					break;
				}
				await new Promise((r) => setTimeout(r, 2000));
			}
			results['foundryAfterTeardown'] = await daemonPhase();
		}

		const logs = api?.logs.snapshot();
		fs.writeFileSync(
			path.join(OUT_DIR, 'e2e-report.json'),
			JSON.stringify({ model: MODEL, results, prompts, notices, quickPicks, timeline, frames, logs: logs?.entries.slice(-200) }, null, 2),
		);
	});

	test('1. before: Foundry Local stopped and no gateway, as the extension sees it', async () => {
		assert.strictEqual(foundryWasRunning, false, 'Foundry Local must be stopped before this test starts');
		const { state, ms } = await waitFor(
			(s) => s.backend === 'stopped' && (s.service === 'disconnected' || s.service === 'stopped'),
			30_000,
			'Foundry "Not running" and KVStream disconnected',
		);
		frames['1-before'] = state;
		results['initialStateMs'] = ms;
		assert.strictEqual(state.capabilities.canControlFoundry, true, 'the Foundry CLI should have been found');
		assert.strictEqual(state.capabilities.canStartKvstream, true);
		assert.strictEqual(state.capabilities.canLoadModel, false, 'Load model needs a running daemon');
	});

	test('2. Quick Actions → Foundry Local → Start', async () => {
		const clickedAt = click('startFoundry');
		const prompt = await waitForPrompt(/Start Foundry Local\?/, clickedAt);
		// The daemon boots for 15 s or more; the card should say so meanwhile.
		const booting = await waitFor((s) => s.backend === 'starting' || s.backend === 'running', 30_000, 'Foundry Local card to show Starting');
		results['foundryStartingShownAfterClickMs'] = Date.now() - clickedAt;
		results['foundryFirstStateAfterClick'] = booting.state.backend;
		const done = await waitForNotice(/Foundry Local start completed|foundry server start exited|Could not run/, clickedAt, 180_000);
		results['foundryStart'] = { prompt, notice: done.text, commandMs: Date.now() - clickedAt };
		assert.strictEqual(done.kind, 'info', done.text);

		const completedAt = Date.now();
		const { state } = await waitFor((s) => s.backend === 'running', 20_000, 'Foundry Local card to show Running');
		results['foundryRunningShownAfterCompleteMs'] = Date.now() - completedAt;
		frames['2-foundry-started'] = state;
		assert.ok(state.connection.backendUrl, 'the CLI-reported endpoint should be shown');
		assert.ok(await daemonRunning(), 'foundry server status should agree the daemon is up');
	});

	test('3. Quick Actions → KVStream → Start, with no model loaded yet', async () => {
		// What a user gets from the two Start buttons alone: Foundry Local comes
		// up with nothing in memory, so KVStream is up but cannot serve.
		const clickedAt = click('startService');
		const prompt = await waitForPrompt(/Start KVStream with/, clickedAt);
		const started = await waitForNotice(/KVStream started|Could not start|KVStream exited/, clickedAt, 60_000);
		results['kvstreamStart'] = { prompt, notice: started.text, ms: Date.now() - clickedAt };
		assert.strictEqual(started.kind, 'info', started.text);

		const { state, ms } = await waitFor(
			(s) => s.service === 'degraded' && s.backend === 'no_model',
			60_000,
			'Degraded with Foundry Local showing No model loaded',
		);
		results['noModelShownAfterStartMs'] = ms;
		results['backendHint'] = state.backendHint;
		frames['3-degraded-no-model'] = state;
		const firstAnswer = timeline.find((e) => e.t + startedAt >= clickedAt && e.service !== 'disconnected' && e.service !== 'starting' && e.process === 'running');
		results['gatewayFirstShownAfterClickMs'] = firstAnswer ? firstAnswer.t + startedAt - clickedAt : null;
		assert.match(state.backendHint ?? '', /no model is loaded/i, "KVStream's own explanation should reach the dashboard");
		assert.deepStrictEqual(state.connection.loadedModels, []);
		assert.strictEqual(state.capabilities.canLoadModel, true, 'Load model should be offered');
		assert.ok(state.connection.backendUrl, 'the daemon is up, so its address is shown');
	});

	test('4. Quick Actions → Foundry Local → Load model… turns it Healthy', async () => {
		const clickedAt = click('loadFoundryModel');
		const loaded = await waitForNotice(/Loaded .* into Foundry Local|foundry model load exited|Could not/, clickedAt, 15 * 60_000);
		results['modelLoad'] = { model: MODEL, notice: loaded.text, ms: Date.now() - clickedAt, pick: quickPicks[quickPicks.length - 1] };
		assert.strictEqual(loaded.kind, 'info', loaded.text);

		const loadedAt = Date.now();
		const { state } = await waitFor(
			(s) => s.service === 'healthy' && s.backend === 'serving',
			120_000,
			'KVStream Healthy and Foundry Local Serving',
		);
		results['healthyAfterLoadMs'] = Date.now() - loadedAt;
		frames['4-kvstream-healthy'] = state;
		assert.strictEqual(state.process.ownedByExtension, true);
		assert.strictEqual(state.capabilities.canStopKvstream, true);
		assert.ok(state.connection.gatewayVersion, 'gateway version should be reported');
		assert.strictEqual(state.connection.model, MODEL, 'the loaded model should be reported');
		assert.strictEqual(state.connection.backendUrlSource, 'kvstream');
		assert.strictEqual(state.backendHint, undefined, 'no explanation is needed once serving');

		const logs = api.logs.snapshot().entries;
		results['logLinesAfterStart'] = logs.length;
		assert.ok(logs.some((e) => e.source === 'kvstream'), 'kvstream serve output should reach the Logs panel');
	});

	test('5. a real request through the gateway is counted on the dashboard', async () => {
		const before = api.monitor.state;
		const baseline = before.requests.totalRequests.value ?? 0;
		const response = await fetch(`${before.connection.gatewayUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: before.connection.model,
				messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
				max_tokens: 8,
			}),
		});
		const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
		results['chatCompletion'] = { status: response.status, reply: body.choices?.[0]?.message?.content };
		assert.strictEqual(response.status, 200);

		const { state, ms } = await waitFor(
			(s) => (s.requests.totalRequests.value ?? 0) >= baseline + 1,
			30_000,
			'the Requests card to count the request',
		);
		results['requestCountedMs'] = ms;
		frames['5-after-request'] = state;
		// One /metrics interval (5 s by default) plus margin: no leftover backoff.
		assert.ok(ms <= 12_000, `the Requests card took ${ms} ms to count the request`);
	});

	test('6. Quick Actions → Health check', async () => {
		const clickedAt = click('checkHealth');
		const notice = await waitForNotice(/KVStream is (serving|not serving|running)/, clickedAt, 90_000);
		results['healthCheck'] = notice;
		assert.strictEqual(notice.kind, 'info', notice.text);
	});

	test('7. status bar reports live counts', () => {
		const bar = describeStatusBar(api.monitor.state);
		results['statusBar'] = bar;
		assert.match(bar.text, /KVStream: \d+ running · \d+ queued/);
	});

	test('8. Quick Actions → Foundry Local → Stop shows within seconds, gateway still up', async () => {
		const clickedAt = click('stopFoundry');
		await waitForPrompt(/Stop the Foundry Local daemon\?/, clickedAt);
		const done = await waitForNotice(/Foundry Local stop completed|foundry server stop exited/, clickedAt, 120_000);
		assert.strictEqual(done.kind, 'info', done.text);
		const completedAt = Date.now();
		const { state } = await waitFor((s) => s.backend === 'stopped', 20_000, 'Foundry Local card to show Not running');
		results['foundryStoppedShownAfterCompleteMs'] = Date.now() - completedAt;
		frames['8-foundry-stopped'] = state;
		assert.ok(results['foundryStoppedShownAfterCompleteMs'] as number <= 10_000, 'stop should show within the liveness interval');
		// KVStream still reports its last backend URL and model; the card must not.
		assert.strictEqual(state.connection.backendUrl, undefined, 'a stopped daemon has no live address');
		assert.strictEqual(state.connection.model, undefined, 'a stopped daemon has no loaded model');
		assert.strictEqual(state.connection.backendUrlDetail, 'Foundry Local is not running');

		// Observation, not an assertion about this extension: KVStream 1.0's
		// model inventory runs `foundry cache list`, which on CLI 0.10.3 starts
		// a stopped daemon. Record whether that happens while the gateway runs.
		const watch = await waitFor((s) => s.backend !== 'stopped', 15_000, 'daemon to come back').catch(() => undefined);
		results['foundryRestartedByOtherAfterMs'] = watch ? watch.ms : null;
		if (watch) {
			frames['8b-foundry-restarted-by-kvstream'] = watch.state;
		}
	});

	test('9. Quick Actions → KVStream → Stop', async () => {
		const clickedAt = click('stopService');
		await waitForPrompt(/Stop the KVStream gateway/, clickedAt);
		const done = await waitForNotice(/KVStream stopped/, clickedAt, 30_000);
		assert.strictEqual(done.kind, 'info', done.text);
		const { state, ms } = await waitFor(
			(s) => s.process.state === 'exited' && (s.service === 'disconnected' || s.service === 'stopped'),
			30_000,
			'KVStream to show stopped',
		);
		results['kvstreamStoppedShownMs'] = ms;
		frames['9-end'] = state;
	});
});
