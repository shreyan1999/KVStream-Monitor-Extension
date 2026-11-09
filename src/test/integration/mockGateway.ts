import * as http from 'http';
import { AddressInfo } from 'net';
import {
	HEALTH_BACKEND_DOWN,
	HEALTH_DEGRADED,
	HEALTH_SERVING,
	METRICS_PARTIAL,
	METRICS_TEXT,
	STATUS_CONCURRENCY,
} from '../fixtures/gatewayFixtures';

export type Scenario =
	| 'healthy'
	| 'backendDegraded'
	| 'backendDown'
	| 'partialMetrics'
	| 'noMetrics'
	| 'serverError'
	| 'invalidJson'
	| 'slow';

/**
 * A stand-in for the gateway, reproducing the documented contract.
 *
 * Lives under `src/test/` and is imported by nothing in `src/` outside it, so
 * it cannot become a production data source. It reproduces the behaviour that
 * actually matters for the client: `/health` answers **503 with a body** when
 * the backend is not serving, which a naive client would treat as a failure.
 */
export class MockGateway {
	private server?: http.Server;
	scenario: Scenario = 'healthy';
	/** Artificial delay applied in the `slow` scenario. */
	slowMs = 500;
	requestCount = 0;
	/** Incremented into `kvstream_requests_total` so throughput can be tested. */
	servedCounter = 118;

	async start(): Promise<string> {
		this.server = http.createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		const address = this.server.address() as AddressInfo;
		return `http://127.0.0.1:${address.port}`;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) {
			return;
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		this.requestCount++;
		const path = (req.url ?? '/').split('?')[0];

		const send = (status: number, body: string, type = 'application/json'): void => {
			res.writeHead(status, { 'content-type': type });
			res.end(body);
		};

		if (this.scenario === 'slow') {
			setTimeout(() => send(200, JSON.stringify(HEALTH_SERVING)), this.slowMs);
			return;
		}
		if (this.scenario === 'serverError') {
			send(500, JSON.stringify({ error: { message: 'internal', type: 'server_error' } }));
			return;
		}
		if (this.scenario === 'invalidJson') {
			send(200, '{ this is not json');
			return;
		}

		if (path === '/health') {
			if (this.scenario === 'backendDown') {
				send(503, JSON.stringify(HEALTH_BACKEND_DOWN));
			} else if (this.scenario === 'backendDegraded') {
				send(503, JSON.stringify(HEALTH_DEGRADED));
			} else {
				send(200, JSON.stringify(HEALTH_SERVING));
			}
			return;
		}

		if (path === '/status') {
			send(200, JSON.stringify(STATUS_CONCURRENCY));
			return;
		}

		if (path === '/metrics') {
			if (this.scenario === 'noMetrics') {
				send(404, JSON.stringify({ error: { message: 'not found' } }));
				return;
			}
			if (this.scenario === 'partialMetrics') {
				send(200, METRICS_PARTIAL, 'text/plain');
				return;
			}
			const text = METRICS_TEXT.replace(
				'kvstream_requests_total{outcome="served",route="chat"} 118.0',
				`kvstream_requests_total{outcome="served",route="chat"} ${this.servedCounter}.0`,
			);
			send(200, text, 'text/plain; version=0.0.4');
			return;
		}

		send(404, JSON.stringify({ error: { message: `no route ${path}` } }));
	}
}
