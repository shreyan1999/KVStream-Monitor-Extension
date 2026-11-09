import type { HealthBody, StatusBody } from '../types/kvstream';
import type { PromRegistry } from '../types/metrics';
import { classifyFetchError, RequestError } from './errors';
import { parseHealth, parseStatus } from './parsers';
import { parsePrometheus } from './prometheus';

/**
 * HTTP client for the KVStream gateway.
 *
 * Endpoints (microsoft/KVstream, `src/kvstream/app.py`):
 *   GET /health   200 when the backend is serving, **503 when it is not** —
 *                 both carry the same JSON body, so a 503 is data, not a
 *                 failure. `?probe=true` forces a fresh readiness generation.
 *   GET /status   200, admission/queue/budget provenance/backend/drift/cache.
 *   GET /metrics  200, Prometheus text exposition format.
 *
 * The client performs no retries of its own: retry policy belongs to the
 * monitoring service, which knows whether a newer poll has already superseded
 * this one.
 */
export interface ClientOptions {
	baseUrl: string;
	/** Deadline for `/status` and `/metrics`, which answer from memory. */
	timeoutMs: number;
	/**
	 * Deadline for `/health`, which may run a real one-token generation as its
	 * readiness probe (3.2 s observed on KVStream 1.0.0 with a 0.5B model).
	 * Defaults to the larger of `timeoutMs` and 15 s.
	 */
	healthTimeoutMs?: number;
}

export type FetchLike = typeof globalThis.fetch;

export class KVStreamClient {
	constructor(
		private options: ClientOptions,
		private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
	) {}

	update(options: Partial<ClientOptions>): void {
		this.options = { ...this.options, ...options };
	}

	get baseUrl(): string {
		return this.options.baseUrl;
	}

	/**
	 * `/health`. A 503 is a documented, meaningful answer, so it is returned as
	 * data with `ok: false` rather than thrown.
	 */
	async health(opts: { probe?: boolean; signal?: AbortSignal } = {}): Promise<{
		ok: boolean;
		status: number;
		body: HealthBody;
	}> {
		const path = opts.probe ? '/health?probe=true' : '/health';
		const timeout = this.options.healthTimeoutMs ?? Math.max(this.options.timeoutMs, 15_000);
		const response = await this.request(path, opts.signal, timeout);
		if (response.status !== 200 && response.status !== 503) {
			throw new RequestError(
				'http',
				`GET /health returned HTTP ${response.status}`,
				response.status,
			);
		}
		const body = parseHealth(await this.json(response, '/health'));
		if (!body) {
			throw new RequestError('schema', '/health did not return a JSON object');
		}
		return { ok: response.status === 200, status: response.status, body };
	}

	async status(signal?: AbortSignal): Promise<StatusBody> {
		const response = await this.request('/status', signal);
		if (!response.ok) {
			throw new RequestError(
				'http',
				`GET /status returned HTTP ${response.status}`,
				response.status,
			);
		}
		const body = parseStatus(await this.json(response, '/status'));
		if (!body) {
			throw new RequestError('schema', '/status did not return a JSON object');
		}
		return body;
	}

	async metrics(signal?: AbortSignal): Promise<PromRegistry> {
		const response = await this.request('/metrics', signal);
		if (!response.ok) {
			throw new RequestError(
				'http',
				`GET /metrics returned HTTP ${response.status}`,
				response.status,
			);
		}
		const text = await response.text();
		return parsePrometheus(text);
	}

	private async request(path: string, signal?: AbortSignal, timeoutMs = this.options.timeoutMs): Promise<Response> {
		const url = `${this.options.baseUrl}${path}`;
		// Two deadlines: our own timeout and the caller's cancellation. Whichever
		// fires first aborts the request, and both surface as `timeout`.
		const timeout = AbortSignal.timeout(timeoutMs);
		const composed = signal ? anySignal([timeout, signal]) : timeout;
		try {
			return await this.fetchImpl(url, {
				signal: composed,
				headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' },
			});
		} catch (error) {
			throw classifyFetchError(error, url);
		}
	}

	private async json(response: Response, path: string): Promise<unknown> {
		const text = await response.text();
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new RequestError('schema', `${path} did not return valid JSON`);
		}
	}
}

/**
 * `AbortSignal.any` is only available on newer runtimes than the oldest
 * extension host this targets, so compose by hand.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
	const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFn === 'function') {
		return anyFn(signals);
	}
	const controller = new AbortController();
	const onAbort = (): void => controller.abort();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort();
			break;
		}
		signal.addEventListener('abort', onAbort, { once: true });
	}
	return controller.signal;
}
