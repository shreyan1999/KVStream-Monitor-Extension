#!/usr/bin/env node
/**
 * Drive real traffic through KVStream to Foundry Local, to exercise the
 * KVStream Monitor dashboard.
 *
 *   node scripts/kvstream-load.mjs                 # every phase, ~3 minutes
 *   node scripts/kvstream-load.mjs --quick         # every phase, ~1 minute
 *   node scripts/kvstream-load.mjs --scenario burst
 *   npm run load-test -- --scenario ramp --max-tokens 32
 *
 * Needs Node 18+ and nothing else. Before running: Foundry Local started, a
 * model loaded and KVStream serving (Quick Actions: Start, Start, Load model…).
 *
 * Each phase prints what the dashboard should show while it runs, and the
 * live line shows the gateway's own /status figures beside the script's, so
 * the two can be compared. At the end the script reads KVStream's request
 * counter before and after and says how much the Requests card should have
 * grown.
 *
 * Every prompt carries a unique suffix: KVStream merges identical concurrent
 * requests ("coalescing"), which would otherwise hide the concurrency the
 * Running and Queue cards are meant to show.
 */

import { performance } from 'node:perf_hooks';

// -- options -------------------------------------------------------------

const HELP = `Drive traffic through KVStream to Foundry Local for the KVStream Monitor.

Usage: node scripts/kvstream-load.mjs [options]

  --url <url>          KVStream gateway (default: $KVSTREAM_URL or http://127.0.0.1:8080)
  --model <id>         model id (default: the one /health reports)
  --scenario <name>    all | smoke | ramp | burst | stream | errors   (default: all)
  --max-tokens <n>     max_tokens per request (default: 64)
  --step-seconds <n>   length of each ramp step and of the stream phase (default: 15)
  --burst <n>          requests fired at once in the burst (default: 3 x admission budget)
  --timeout <s>        per-request timeout in seconds (default: 180)
  --quick              shorter run: 8 s steps, 32 tokens, burst of 2 x budget
  --help               this text

Phases:
  smoke   3 sequential chat requests, replies printed
  ramp    closed-loop load at concurrency 1, 2, 4 and the admission budget
  burst   a wave of requests larger than the budget, so the queue fills and drains
  stream  streaming chat at concurrency 4, with time to first token
  errors  2 requests the gateway must refuse (unknown model, malformed body)

Ctrl+C stops starting new requests, waits for the ones in flight and prints the summary.`;

function parseArgs(argv) {
	const opts = {
		url: process.env.KVSTREAM_URL || 'http://127.0.0.1:8080',
		model: undefined,
		scenario: 'all',
		maxTokens: 64,
		stepSeconds: 15,
		burst: undefined,
		timeoutMs: 180_000,
		quick: false,
	};
	const take = (i, name) => {
		const value = argv[i + 1];
		if (value === undefined || value.startsWith('--')) {
			fail(`${name} needs a value`);
		}
		return value;
	};
	const positive = (value, name) => {
		const n = Number(value);
		if (!Number.isFinite(n) || n <= 0) {
			fail(`${name} must be a positive number, got "${value}"`);
		}
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--help':
			case '-h':
				console.log(HELP);
				process.exit(0);
				break;
			case '--url':
				opts.url = take(i++, arg);
				break;
			case '--model':
				opts.model = take(i++, arg);
				break;
			case '--scenario':
				opts.scenario = take(i++, arg);
				break;
			case '--max-tokens':
				opts.maxTokens = Math.round(positive(take(i++, arg), arg));
				break;
			case '--step-seconds':
				opts.stepSeconds = positive(take(i++, arg), arg);
				break;
			case '--burst':
				opts.burst = Math.round(positive(take(i++, arg), arg));
				break;
			case '--timeout':
				opts.timeoutMs = positive(take(i++, arg), arg) * 1000;
				break;
			case '--quick':
				opts.quick = true;
				break;
			default:
				fail(`unknown option ${arg} (see --help)`);
		}
	}
	if (opts.quick) {
		opts.stepSeconds = Math.min(opts.stepSeconds, 8);
		opts.maxTokens = Math.min(opts.maxTokens, 32);
	}
	const scenarios = ['all', 'smoke', 'ramp', 'burst', 'stream', 'errors'];
	if (!scenarios.includes(opts.scenario)) {
		fail(`--scenario must be one of ${scenarios.join(', ')}`);
	}
	try {
		const parsed = new URL(opts.url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error('not http(s)');
		}
		opts.url = opts.url.replace(/\/+$/, '');
	} catch {
		fail(`--url is not an http(s) URL: ${opts.url}`);
	}
	return opts;
}

function fail(message, code = 2) {
	console.error(`error: ${message}`);
	process.exit(code);
}

const opts = parseArgs(process.argv.slice(2));

// -- output --------------------------------------------------------------

const tty = process.stdout.isTTY === true;
const paint = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const cyan = paint('36');

let liveLineShown = false;
function clearLive() {
	if (tty && liveLineShown) {
		process.stdout.write('\r\x1b[2K');
		liveLineShown = false;
	}
}
function log(text = '') {
	clearLive();
	console.log(text);
}

// -- gateway helpers -----------------------------------------------------

async function getJson(path, timeoutMs = 10_000) {
	const res = await fetch(`${opts.url}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	return { status: res.status, body, text };
}

/** Sum of every `kvstream_requests_total` series: what the Requests card shows. */
async function gatewayRequestTotal() {
	try {
		const res = await fetch(`${opts.url}/metrics`, { signal: AbortSignal.timeout(10_000) });
		const text = await res.text();
		let sum = 0;
		let seen = false;
		for (const line of text.split('\n')) {
			const match = /^kvstream_requests_total(?:\{[^}]*\})?\s+([0-9.eE+-]+)/.exec(line);
			if (match) {
				sum += Number(match[1]);
				seen = true;
			}
		}
		return seen ? sum : 0;
	} catch {
		return undefined;
	}
}

/** Latest /status admission figures, refreshed once a second while running. */
const gateway = { active: undefined, waiting: undefined, utilization: undefined, peakWaiting: 0, peakActive: 0 };
let statusTimer;
function startGatewayPoll() {
	const poll = async () => {
		try {
			const { body } = await getJson('/status', 3000);
			const a = body?.admission;
			if (a) {
				gateway.active = a.active;
				gateway.waiting = a.waiting ?? a.queue?.depth;
				gateway.utilization = a.utilization;
				gateway.peakWaiting = Math.max(gateway.peakWaiting, gateway.waiting ?? 0);
				gateway.peakActive = Math.max(gateway.peakActive, gateway.active ?? 0);
			}
		} catch {
			gateway.active = gateway.waiting = gateway.utilization = undefined;
		}
	};
	void poll();
	statusTimer = setInterval(poll, 1000);
}

// -- requests ------------------------------------------------------------

const PROMPTS = [
	'Explain what a KV cache is in one sentence.',
	'Name three uses of a load balancer.',
	'Write a haiku about GPUs.',
	'What is admission control in a web service?',
	'Give two tips for writing readable code.',
	'Summarise what an API gateway does.',
	'List three prime numbers greater than 50.',
	'What does latency mean in networking?',
	'Describe a queue in one sentence.',
	'Why do language models need memory for context?',
	'Suggest a name for a monitoring dashboard.',
	'What is the difference between throughput and latency?',
];

let sequence = 0;
let inFlight = 0;
let stopping = false;
/**
 * Malformed bodies sent. KVStream rejects those (HTTP 400) before its request
 * accounting, so they never reach kvstream_requests_total. Verified on 1.0.0;
 * an unknown model, by contrast, is counted as outcome="client_error".
 */
let uncounted = 0;

function makePhase(name) {
	return { name, sent: 0, ok: 0, errors: new Map(), latencies: [], ttfts: [], tokens: 0, startedAt: performance.now(), endedAt: 0 };
}

/**
 * One chat completion. `variant` is 'chat', 'stream', 'unknown-model' or
 * 'malformed'. Returns the result; never throws.
 */
async function chat(phase, variant = 'chat') {
	const id = ++sequence;
	const prompt = `${PROMPTS[id % PROMPTS.length]} (request #${id})`;
	const stream = variant === 'stream';
	let body;
	if (variant === 'malformed') {
		body = '{"model": "x", "messages": [';
		uncounted++;
	} else {
		body = JSON.stringify({
			model: variant === 'unknown-model' ? 'kvstream-load-test/no-such-model' : opts.model,
			messages: [{ role: 'user', content: prompt }],
			max_tokens: opts.maxTokens,
			temperature: 0.7,
			stream,
			...(stream ? { stream_options: { include_usage: true } } : {}),
		});
	}

	phase.sent++;
	inFlight++;
	const started = performance.now();
	let status = 0;
	let error;
	let ttft;
	let tokens;
	let reply;
	try {
		const res = await fetch(`${opts.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			signal: AbortSignal.timeout(opts.timeoutMs),
		});
		status = res.status;
		if (stream && res.ok && res.body) {
			const decoder = new TextDecoder();
			let buffer = '';
			reply = '';
			for await (const chunk of res.body) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline;
				while ((newline = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line.startsWith('data:')) {
						continue;
					}
					const data = line.slice(5).trim();
					if (data === '[DONE]') {
						continue;
					}
					try {
						const event = JSON.parse(data);
						const delta = event.choices?.[0]?.delta?.content;
						if (delta) {
							ttft ??= performance.now() - started;
							reply += delta;
						}
						if (event.usage?.completion_tokens) {
							tokens = event.usage.completion_tokens;
						}
					} catch {
						// A partial or non-JSON event line: ignore it, as clients do.
					}
				}
			}
		} else {
			const text = await res.text();
			let json;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			if (res.ok) {
				reply = json?.choices?.[0]?.message?.content;
				tokens = json?.usage?.completion_tokens;
			} else {
				error = json?.error?.message ?? json?.detail ?? (text.slice(0, 160) || res.statusText);
			}
		}
	} catch (e) {
		error = e?.name === 'TimeoutError' ? `timed out after ${opts.timeoutMs / 1000} s` : String(e?.message ?? e);
	} finally {
		inFlight--;
	}

	const elapsed = performance.now() - started;
	const ok = status >= 200 && status < 300 && error === undefined;
	if (ok) {
		phase.ok++;
		phase.latencies.push(elapsed);
		if (ttft !== undefined) {
			phase.ttfts.push(ttft);
		}
		phase.tokens += tokens ?? 0;
	} else {
		const key = status ? `HTTP ${status}` : 'no response';
		const entry = phase.errors.get(key) ?? { count: 0, example: error };
		entry.count++;
		phase.errors.set(key, entry);
	}
	return { ok, status, elapsed, ttft, tokens, reply, error };
}

/** `concurrency` workers, each sending back to back until time is up. */
async function closedLoop(phase, concurrency, seconds, variant = 'chat') {
	const until = performance.now() + seconds * 1000;
	const worker = async () => {
		while (!stopping && performance.now() < until) {
			await chat(phase, variant);
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
}

// -- live line and summaries ---------------------------------------------

function percentile(values, p) {
	if (values.length === 0) {
		return undefined;
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const secs = (ms) => (ms === undefined ? '  -  ' : `${(ms / 1000).toFixed(2)}s`);

let currentPhase;
let currentLabel = '';
let liveTimer;
function startLive() {
	const render = () => {
		if (!currentPhase) {
			return;
		}
		const p = currentPhase;
		const errors = [...p.errors.values()].reduce((n, e) => n + e.count, 0);
		const elapsed = (performance.now() - p.startedAt) / 1000;
		const rate = elapsed > 0 ? p.ok / elapsed : 0;
		const g =
			gateway.active === undefined
				? dim('gateway /status: unavailable')
				: `gateway ${cyan(`running ${gateway.active}`)} ${cyan(`queued ${gateway.waiting ?? 0}`)} ${cyan(
						`budget ${Math.round((gateway.utilization ?? 0) * 100)}%`,
					)}`;
		const line =
			`${bold(`[${currentLabel}]`)} sent ${p.sent} ok ${green(p.ok)} err ${errors ? red(errors) : 0} ` +
			`in-flight ${inFlight} | ${g} | p50 ${secs(percentile(p.latencies, 50))} ` +
			`p95 ${secs(percentile(p.latencies, 95))} | ${rate.toFixed(2)} req/s`;
		if (tty) {
			process.stdout.write(`\r\x1b[2K${line}`);
			liveLineShown = true;
		} else if (Math.round(elapsed) % 5 === 0) {
			console.log(line);
		}
	};
	liveTimer = setInterval(render, tty ? 500 : 1000);
}

const results = [];
function beginPhase(name, label, expectation) {
	currentPhase = makePhase(name);
	currentLabel = label;
	log();
	log(bold(`== ${name} ==`) + (expectation ? `  ${dim('Dashboard:')} ${expectation}` : ''));
	return currentPhase;
}
function endPhase(phase) {
	phase.endedAt = performance.now();
	results.push(phase);
	const errors = [...phase.errors.values()].reduce((n, e) => n + e.count, 0);
	const seconds = (phase.endedAt - phase.startedAt) / 1000;
	log(
		`   ${phase.ok}/${phase.sent} ok in ${seconds.toFixed(1)}s` +
			(phase.latencies.length ? `, latency p50 ${secs(percentile(phase.latencies, 50))} p95 ${secs(percentile(phase.latencies, 95))}` : '') +
			(phase.ttfts.length ? `, first token p50 ${secs(percentile(phase.ttfts, 50))}` : '') +
			(phase.tokens ? `, ${(phase.tokens / seconds).toFixed(1)} tokens/s` : '') +
			(errors ? `, ${errors} refused/failed` : ''),
	);
	for (const [key, entry] of phase.errors) {
		log(`   ${yellow(key)} x${entry.count}: ${dim(entry.example ?? '')}`);
	}
}

// -- phases --------------------------------------------------------------

async function smoke() {
	const phase = beginPhase('smoke', 'smoke', 'Requests +3, one small step in throughput.');
	for (let i = 0; i < 3 && !stopping; i++) {
		const r = await chat(phase);
		const text = (r.reply ?? r.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
		log(`   ${r.ok ? green('ok ') : red('err')} ${secs(r.elapsed)} ${r.tokens ?? '?'} tokens  ${dim(text)}`);
	}
	endPhase(phase);
}

async function ramp(budget) {
	const steps = [...new Set([1, 2, 4, budget])].filter((n) => n <= budget).sort((a, b) => a - b);
	for (const concurrency of steps) {
		if (stopping) {
			break;
		}
		const phase = beginPhase(
			`ramp x${concurrency}`,
			`ramp c=${concurrency}`,
			`Running ≈ ${concurrency}, Queue 0, Admission budget ≈ ${Math.round((concurrency / budget) * 100)}%.`,
		);
		await closedLoop(phase, concurrency, opts.stepSeconds);
		endPhase(phase);
	}
}

async function burst(budget) {
	const size = opts.burst ?? budget * (opts.quick ? 2 : 3);
	const phase = beginPhase(
		'burst',
		`burst ${size}`,
		`Running pinned at ${budget}, Queue jumps to ~${Math.max(0, size - budget)} then drains, budget 100%.`,
	);
	gateway.peakWaiting = 0;
	gateway.peakActive = 0;
	await Promise.all(Array.from({ length: size }, () => (stopping ? undefined : chat(phase))));
	endPhase(phase);
	log(`   gateway peak while bursting: running ${gateway.peakActive}, queued ${gateway.peakWaiting}`);
}

async function streaming() {
	const phase = beginPhase('stream', 'stream c=4', 'Running ≈ 4; streamed requests count like any other.');
	await closedLoop(phase, 4, opts.stepSeconds, 'stream');
	endPhase(phase);
}

async function errors() {
	const phase = beginPhase(
		'errors',
		'errors',
		'Requests +1 (unknown model, counted as a client error; a malformed body is refused before KVStream counts it). Health stays Healthy.',
	);
	for (const variant of ['unknown-model', 'malformed']) {
		if (stopping) {
			break;
		}
		const r = await chat(phase, variant);
		const expected = r.status >= 400 && r.status < 500;
		log(`   ${variant}: HTTP ${r.status || '-'} ${expected ? green('(refused, as expected)') : red('(expected a 4xx)')}  ${dim((r.error ?? '').slice(0, 100))}`);
	}
	endPhase(phase);
	return phase;
}

// -- main ----------------------------------------------------------------

async function main() {
	log(bold('KVStream load test') + dim(`  ${opts.url}`));

	// Preflight: the gateway must answer and be serving.
	let health;
	try {
		health = await getJson('/health', 60_000);
	} catch (e) {
		fail(
			`cannot reach ${opts.url}/health (${e?.cause?.code ?? e?.message ?? e}).\n` +
				'       Start KVStream: in VS Code use Quick Actions → KVStream → Start, or run `kvstream serve`.',
			3,
		);
	}
	const h = health.body ?? {};
	if (h.backend_serving !== true) {
		fail(
			`KVStream is up but not serving (status: ${h.status ?? health.status}).\n` +
				`       KVStream says: ${h.hint ?? h.readiness?.detail ?? 'no detail'}\n` +
				'       In VS Code: Quick Actions → Foundry Local → Start, then Load model….',
			3,
		);
	}
	opts.model ??= h.model;
	if (!opts.model) {
		fail('the gateway reported no model; pass --model <id>', 3);
	}

	const { body: status } = await getJson('/status');
	const admission = status?.admission ?? {};
	const unit = admission.unit ?? 'concurrency';
	// In tokens mode the budget is a token estimate, not a request count; a
	// concurrency of 8 still exercises it without guessing a conversion.
	const budget = unit === 'concurrency' && Number.isInteger(admission.budget) && admission.budget > 0 ? admission.budget : 8;

	log(`model ${bold(opts.model)}, KVStream ${h.version ?? '?'}, admission ${unit} budget ${admission.budget ?? '?'}, max_tokens ${opts.maxTokens}`);
	log(dim('Open the KVStream dashboard (status bar → KVStream) to watch. Ctrl+C stops early.'));

	const before = await gatewayRequestTotal();
	startGatewayPoll();
	startLive();

	const run = (name) => opts.scenario === 'all' || opts.scenario === name;
	let errorPhase;
	if (run('smoke')) await smoke();
	if (run('ramp') && !stopping) await ramp(budget);
	if (run('burst') && !stopping) await burst(budget);
	if (run('stream') && !stopping) await streaming();
	if (run('errors') && !stopping) errorPhase = await errors();

	if (opts.scenario === 'all' && !stopping) {
		currentPhase = undefined;
		log();
		log(bold('== cooldown ==') + `  ${dim('Dashboard:')} Running and Queue fall to 0; the throughput line drops.`);
		await new Promise((r) => setTimeout(r, 6000));
	}

	clearInterval(liveTimer);
	clearInterval(statusTimer);
	currentPhase = undefined;

	// Let the last responses reach /metrics before reading it.
	await new Promise((r) => setTimeout(r, 1500));
	const after = await gatewayRequestTotal();

	const sent = results.reduce((n, p) => n + p.sent, 0);
	const ok = results.reduce((n, p) => n + p.ok, 0);
	const failed = results
		.filter((p) => p !== errorPhase)
		.reduce((n, p) => n + [...p.errors.values()].reduce((m, e) => m + e.count, 0), 0);
	const all = results.flatMap((p) => p.latencies);

	log();
	log(bold('== summary =='));
	log(`   requests sent ${sent}, succeeded ${green(ok)}, unexpected failures ${failed ? red(failed) : green(0)}`);
	if (all.length) {
		log(`   latency p50 ${secs(percentile(all, 50))}  p95 ${secs(percentile(all, 95))}  max ${secs(Math.max(...all))}`);
	}
	if (before !== undefined && after !== undefined) {
		const delta = after - before;
		const expected = sent - uncounted;
		const note = uncounted ? ` (${sent} sent, minus ${uncounted} malformed that KVStream does not count)` : '';
		log(
			`   kvstream_requests_total ${before} → ${after} (${delta >= 0 ? '+' : ''}${delta}) ` +
				(delta === expected
					? green(`— matches the ${expected} expected${note}`)
					: yellow(`— expected +${expected}${note}; other clients or a gateway restart can account for the difference`)),
		);
		log(`   ${dim('Dashboard check:')} the Requests card should read ${bold(after)}.`);
	}
	if (stopping) {
		log(yellow('   stopped early (Ctrl+C)'));
	}
	process.exitCode = failed > 0 ? 1 : 0;
}

process.on('SIGINT', () => {
	if (stopping) {
		log(red('\nforced exit'));
		process.exit(130);
	}
	stopping = true;
	log(yellow(`\nstopping: no new requests; waiting for ${inFlight} in flight (Ctrl+C again to quit now)`));
});

main().catch((e) => {
	clearInterval(liveTimer);
	clearInterval(statusTimer);
	fail(String(e?.stack ?? e), 1);
});
