import { run, stripAnsi } from '../processes/run';
import type { BackendState } from '../types/viewModel';

/**
 * Foundry Local discovery and system inspection.
 *
 * KVStream finds the backend itself and reports the result in `/status`
 * (`backend.base_url` plus `backend.resolution.source`), so that is always the
 * first source — see `pickBackendEndpoint`. This module is the *second*
 * source: it asks the Foundry CLI directly, which is the only way to learn
 * anything when the gateway is not running.
 *
 * Verified against Foundry Local CLI 0.12.1 on Windows:
 *   foundry --version            -> "0.12.1"
 *   foundry server status -o json-> {running, state, pid, webUrls[], startedAt,
 *                                    uptime, logFile}
 *   foundry status -o json       -> {system:{gpus[],totalMemoryBytes,
 *                                    availableMemoryBytes,...},
 *                                    service:{state, ready, webUrls[], ...},
 *                                    models:{}, connectivity:{...}, warnings[]}
 *
 * Nothing here asserts a port. A URL is only reported when the CLI printed it,
 * and a URL printed by a daemon the CLI says is not running is reported as
 * stale rather than offered as an endpoint — `foundry server status` keeps the
 * last session's `webUrls` after the daemon exits, which would otherwise show
 * a dead address as a discovery result.
 */

export interface FoundryGpu {
	name: string;
	vendor?: string;
	videoMemoryBytes?: number;
}

export interface FoundrySystemInfo {
	gpus: FoundryGpu[];
	totalMemoryBytes?: number;
	availableMemoryBytes?: number;
}

export interface FoundrySnapshot {
	/** Whether the `foundry` executable could be run at all. */
	cliAvailable: boolean;
	cliVersion?: string;
	/**
	 * The state word the CLI printed, for display only — `not_running`,
	 * `ready` (what 0.12.1 reports for a live daemon), `unknown`, ...
	 */
	daemonState: string;
	/**
	 * Whether the daemon is up. Taken from the CLI's `running` boolean, never
	 * from the state word: 0.12.1 reports a live daemon as `state: "ready"`,
	 * so testing for the string `running` reads a working backend as stopped.
	 */
	daemonRunning: boolean;
	/** Endpoints the CLI reported for a daemon it also says is running. */
	candidates: string[];
	/** Endpoints reported for a daemon that is not running. */
	staleCandidates: string[];
	pid?: number;
	/** As printed by the CLI, e.g. `1d 20h 5m 22s`. Only set while running. */
	uptime?: string;
	system?: FoundrySystemInfo;
	/** Why something is missing. Shown verbatim; never invented. */
	notes: string[];
	collectedAt: number;
}

/** JSON from a CLI that colours its output even into a pipe; undefined when unreadable. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(stripAnsi(text).trim()) as unknown;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One entry of `foundry cache list --output json` (verified on CLI 0.10.3). */
export interface CachedModel {
	id: string;
	alias?: string;
	device?: string;
	fileSizeMb?: number;
	/** Absent when this CLI build does not say. */
	loaded?: boolean;
}

/**
 * Read `foundry cache list --output json`:
 * `{"models":[{"alias","id","device","fileSizeMb","loaded",...}]}`.
 * Undefined when the document is not that shape; entries without an id are
 * dropped rather than guessed at.
 */
export function parseCacheList(raw: unknown): CachedModel[] | undefined {
	if (!isRecord(raw) || !Array.isArray(raw['models'])) {
		return undefined;
	}
	return raw['models'].flatMap((entry): CachedModel[] => {
		if (!isRecord(entry) || typeof entry['id'] !== 'string' || entry['id'] === '') {
			return [];
		}
		return [
			{
				id: entry['id'],
				alias: typeof entry['alias'] === 'string' ? entry['alias'] : undefined,
				device: typeof entry['device'] === 'string' ? entry['device'] : undefined,
				fileSizeMb:
					typeof entry['fileSizeMb'] === 'number' && entry['fileSizeMb'] >= 0 ? entry['fileSizeMb'] : undefined,
				loaded: typeof entry['loaded'] === 'boolean' ? entry['loaded'] : undefined,
			},
		];
	});
}

/** Keep only values that are syntactically http(s) URLs with a host. */
export function sanitiseUrls(values: unknown): string[] {
	if (!Array.isArray(values)) {
		return [];
	}
	const out: string[] = [];
	for (const item of values) {
		if (typeof item !== 'string') {
			continue;
		}
		try {
			const url = new URL(item);
			if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) {
				out.push(`${url.protocol}//${url.host}`);
			}
		} catch {
			// Not a URL. A parse failure is a miss, not an error.
		}
	}
	return [...new Set(out)];
}

export function parseSystemInfo(raw: unknown): FoundrySystemInfo | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const system = raw['system'];
	if (!isRecord(system)) {
		return undefined;
	}
	const gpusRaw = system['gpus'];
	const gpus: FoundryGpu[] = Array.isArray(gpusRaw)
		? gpusRaw.flatMap((entry) => {
				if (!isRecord(entry) || typeof entry['name'] !== 'string') {
					return [];
				}
				return [
					{
						name: entry['name'],
						vendor: typeof entry['vendor'] === 'string' ? entry['vendor'] : undefined,
						videoMemoryBytes:
							typeof entry['videoMemoryBytes'] === 'number' && entry['videoMemoryBytes'] >= 0
								? entry['videoMemoryBytes']
								: undefined,
					},
				];
			})
		: [];
	const total = system['totalMemoryBytes'];
	const available = system['availableMemoryBytes'];
	return {
		gpus,
		totalMemoryBytes: typeof total === 'number' && total >= 0 ? total : undefined,
		availableMemoryBytes: typeof available === 'number' && available >= 0 ? available : undefined,
	};
}

/** The daemon-liveness half of a snapshot: what `foundry server status` says. */
export interface FoundryLiveness {
	daemonState: string;
	daemonRunning: boolean;
	candidates: string[];
	staleCandidates: string[];
	pid?: number;
	uptime?: string;
	collectedAt: number;
}

/**
 * Read `foundry server status --output json`. Undefined when the document is
 * not the shape this build understands, so a format change is a miss rather
 * than a false "not running".
 */
export function parseServerStatus(raw: unknown, collectedAt = Date.now()): FoundryLiveness | undefined {
	if (!isRecord(raw) || typeof raw['running'] !== 'boolean') {
		return undefined;
	}
	const running = raw['running'];
	const urls = sanitiseUrls(raw['webUrls']);
	return {
		daemonState: typeof raw['state'] === 'string' ? raw['state'] : running ? 'running' : 'not_running',
		daemonRunning: running,
		// `webUrls`, `pid` and `uptime` all survive the daemon exiting (verified
		// on 0.12.1), so they are only meaningful while `running` is true.
		candidates: running ? urls : [],
		staleCandidates: running ? [] : urls,
		pid: running && typeof raw['pid'] === 'number' ? raw['pid'] : undefined,
		uptime: running && typeof raw['uptime'] === 'string' ? raw['uptime'] : undefined,
		collectedAt,
	};
}

/**
 * Overlay a newer liveness reading onto a snapshot. Hardware and version
 * details are kept; everything about whether the daemon is up is replaced.
 */
export function applyLiveness(base: FoundrySnapshot | undefined, live: FoundryLiveness): FoundrySnapshot {
	return {
		notes: [],
		...base,
		// `server status` answered, so the CLI is demonstrably runnable.
		cliAvailable: true,
		daemonState: live.daemonState,
		daemonRunning: live.daemonRunning,
		candidates: live.candidates,
		staleCandidates: live.staleCandidates,
		pid: live.pid,
		uptime: live.uptime,
		collectedAt: base?.collectedAt ?? live.collectedAt,
	};
}

export type LivenessResult =
	| { status: 'ok'; live: FoundryLiveness }
	/** The CLI is disabled or could not be started. */
	| { status: 'unavailable' }
	/** It ran but timed out or printed something unreadable; keep the last answer. */
	| { status: 'inconclusive' };

/** A spawn failure that means "no such executable", as opposed to a slow one. */
function isMissing(result: { spawnError?: string }): boolean {
	return result.spawnError !== undefined && result.spawnError !== 'timed out';
}

export class FoundryDetector {
	constructor(
		private executable: string,
		private enabled: boolean,
	) {}

	update(executable: string, enabled: boolean): void {
		this.executable = executable;
		this.enabled = enabled;
	}

	/**
	 * Just `foundry server status` — one process, cheap enough to run at the
	 * same cadence as the gateway poll, so a daemon started or stopped from a
	 * terminal shows up within seconds rather than at the next full snapshot.
	 */
	async liveness(timeoutMs = 5000): Promise<LivenessResult> {
		if (!this.enabled) {
			return { status: 'unavailable' };
		}
		const startedAt = Date.now();
		const server = await run(this.executable, ['server', 'status', '--output', 'json'], { timeoutMs });
		if (isMissing(server)) {
			return { status: 'unavailable' };
		}
		const live = server.code === 0 ? parseServerStatus(parseJson(server.stdout), startedAt) : undefined;
		return live ? { status: 'ok', live } : { status: 'inconclusive' };
	}

	async snapshot(timeoutMs = 6000): Promise<FoundrySnapshot> {
		const base: FoundrySnapshot = {
			cliAvailable: false,
			daemonState: 'unknown',
			daemonRunning: false,
			candidates: [],
			staleCandidates: [],
			notes: [],
			collectedAt: Date.now(),
		};

		if (!this.enabled) {
			base.notes.push('Foundry CLI lookups are disabled by kvstream.enableFoundryCli.');
			return base;
		}

		const version = await run(this.executable, ['--version'], { timeoutMs });
		const versionTimedOut = version.spawnError === 'timed out';
		if (isMissing(version) || (!versionTimedOut && version.code !== 0)) {
			base.notes.push(
				`Foundry Local CLI not found (tried "${this.executable}"). ` +
					'Install Foundry Local, or set kvstream.foundryPath.',
			);
			return base;
		}
		// A timeout is a slow CLI (the first .NET start on a cold machine can
		// take several seconds), not a missing one. Carry on: the calls below
		// decide whether it is usable.
		if (!versionTimedOut) {
			base.cliAvailable = true;
			base.cliVersion = stripAnsi(version.stdout).trim().split('\n')[0] || undefined;
		}

		// `foundry status --output json` is the 0.10+ surface and carries both
		// the service state and the hardware inventory in one call.
		const status = await run(this.executable, ['status', '--output', 'json'], { timeoutMs });
		const statusJson = status.code === 0 ? parseJson(status.stdout) : undefined;
		if (isRecord(statusJson)) {
			base.cliAvailable = true;
			base.system = parseSystemInfo(statusJson);
			const service = statusJson['service'];
			if (isRecord(service)) {
				if (typeof service['state'] === 'string') {
					base.daemonState = service['state'];
				}
				base.daemonRunning = service['ready'] === true;
				base.candidates = sanitiseUrls(service['webUrls']);
			}
		} else {
			base.notes.push('`foundry status --output json` returned nothing this build could read.');
		}

		// `foundry server status` is the authority on whether the daemon is up,
		// and it is the only call that reports the pid.
		const server = await run(this.executable, ['server', 'status', '--output', 'json'], { timeoutMs });
		const live = server.code === 0 ? parseServerStatus(parseJson(server.stdout), base.collectedAt) : undefined;
		if (live) {
			base.cliAvailable = true;
			base.daemonRunning = live.daemonRunning;
			base.daemonState = live.daemonState;
			base.pid = live.pid;
			base.uptime = live.uptime;
			if (live.daemonRunning) {
				base.candidates = [...new Set([...base.candidates, ...live.candidates])];
			} else {
				base.candidates = [];
				base.staleCandidates = live.staleCandidates;
			}
		}

		if (!base.cliAvailable) {
			base.notes.push(`The Foundry CLI ("${this.executable}") did not answer within ${timeoutMs} ms.`);
			return base;
		}

		if (!base.daemonRunning && base.candidates.length === 0 && base.staleCandidates.length > 0) {
			base.notes.push(
				'The Foundry CLI still reports a URL from a previous session; the daemon is not running, ' +
					'so it is shown as stale rather than as a live endpoint.',
			);
		}

		return base;
	}
}

export interface EndpointChoice {
	url?: string;
	/** `kvstream` | `foundry-cli` | `ambiguous` | `none` */
	source: string;
	detail: string;
	candidates: string[];
}

/**
 * Choose the backend endpoint to display.
 *
 * KVStream wins outright: it resolved the endpoint it is actually using, and
 * second-guessing it would show the user an address no traffic goes to. Only
 * when the gateway reported nothing does the CLI get a say, and then only if
 * it named exactly one live candidate — several candidates are reported as
 * ambiguous rather than resolved by picking the first.
 */
export function pickBackendEndpoint(
	kvstreamBackendUrl: string | undefined,
	kvstreamSource: string | undefined,
	foundry: FoundrySnapshot | undefined,
	/** KVStream's own explanation when it reports `resolution.source: unresolved`. */
	kvstreamUnresolvedDetail?: string,
): EndpointChoice {
	const candidates = foundry?.candidates ?? [];
	if (!kvstreamBackendUrl && kvstreamUnresolvedDetail && candidates.length === 0) {
		return { source: 'none', detail: `KVStream: ${kvstreamUnresolvedDetail}`, candidates };
	}
	if (kvstreamBackendUrl) {
		return {
			url: kvstreamBackendUrl,
			source: 'kvstream',
			detail: kvstreamSource
				? `reported by KVStream (resolved via ${kvstreamSource})`
				: 'reported by KVStream',
			candidates,
		};
	}
	if (candidates.length === 1) {
		return {
			url: candidates[0],
			source: 'foundry-cli',
			detail: 'reported by the Foundry Local CLI',
			candidates,
		};
	}
	if (candidates.length > 1) {
		return {
			source: 'ambiguous',
			detail: `the Foundry CLI reported ${candidates.length} endpoints; pin one with kvstream serve --backend-url`,
			candidates,
		};
	}
	if (!foundry?.cliAvailable) {
		return { source: 'none', detail: 'no backend reported, and the Foundry CLI is unavailable', candidates };
	}
	return {
		source: 'none',
		detail:
			foundry.daemonRunning
				? 'Foundry Local is running but reported no endpoint'
				: 'Foundry Local is not running',
		candidates,
	};
}

export interface BackendPresentation {
	url?: string;
	source: string;
	detail: string;
	model?: string;
	modelSource?: string;
}

/**
 * What the Foundry Local card may show as its address and model.
 *
 * KVStream keeps reporting the backend URL it resolved and the model it
 * detected after Foundry Local stops (seen live: both stayed on the card after
 * `foundry server stop`). Once the CLI says the daemon is down or still
 * booting — a restart takes a new ephemeral port and loads no model — they are
 * dead values, so the reason is shown instead.
 */
export function presentBackend(
	backend: BackendState,
	endpoint: EndpointChoice,
	model: { id?: string; source?: string },
): BackendPresentation {
	if (backend === 'stopped' || backend === 'starting') {
		return {
			source: 'none',
			detail: backend === 'starting' ? 'Foundry Local is starting' : 'Foundry Local is not running',
		};
	}
	return {
		url: endpoint.url,
		source: endpoint.source,
		detail: endpoint.detail,
		model: model.id,
		modelSource: model.source,
	};
}
