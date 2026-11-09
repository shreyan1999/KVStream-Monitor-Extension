import * as vscode from 'vscode';
import { KVStreamClient } from '../kvstream/client';
import { RequestError } from '../kvstream/errors';
import {
	applyLiveness,
	FoundryDetector,
	pickBackendEndpoint,
	presentBackend,
	type FoundryLiveness,
	type FoundrySnapshot,
} from '../foundry/detector';
import type { ExtensionSettings } from '../config/settings';
import type { Logger } from '../logging';
import type { ProcessManager } from '../processes/processManager';
import type { HealthBody, StatusBody } from '../types/kvstream';
import type { PromRegistry } from '../types/metrics';
import type {
	BackendState,
	Capabilities,
	ErrorInfo,
	ServiceState,
	ViewModel,
} from '../types/viewModel';
import { deriveBudget, deriveRequestMetrics, historySample } from './derive';
import { HistoryStore } from './historyStore';
import { PollingScheduler } from './pollingScheduler';

/**
 * The single owner of polling and of the state every view renders.
 *
 * Views subscribe; they never call the gateway. That keeps the request rate
 * independent of how many views are open — the sidebar and the dashboard
 * showing at once produce exactly the same traffic as one of them — and means
 * both always show the same numbers from the same sample.
 *
 * Several cadences, because the sources differ in cost: `/health` and
 * `/status` are cheap JSON and move fastest; `/metrics` is a larger payload
 * parsed once here rather than in each view; the Foundry CLI spawns
 * processes, so only its one-call liveness check (`foundry server status`)
 * runs near the gateway cadence, while the full snapshot — version and
 * hardware inventory — is taken slowly.
 */
export class MonitorService implements vscode.Disposable {
	private readonly client: KVStreamClient;
	private readonly detector: FoundryDetector;
	private readonly history: HistoryStore;

	private readonly fastPoll: PollingScheduler;
	private readonly healthPoll: PollingScheduler;
	private readonly metricsPoll: PollingScheduler;
	private readonly foundryPoll: PollingScheduler;
	private readonly foundryLivePoll: PollingScheduler;

	private readonly emitter = new vscode.EventEmitter<ViewModel>();
	readonly onDidChange = this.emitter.event;

	private settings: ExtensionSettings;
	private subscribers = 0;

	/** Monotonic id; a response from an older generation is discarded. */
	private generation = 0;

	private health?: HealthBody;
	private healthOk = false;
	private status?: StatusBody;
	private metrics?: PromRegistry;
	private foundry?: FoundrySnapshot;
	/** The newest `foundry server status` reading; see `pollFoundry`. */
	private foundryLive?: FoundryLiveness;
	private lastSuccessAt?: number;
	private statusError?: ErrorInfo;
	private healthError?: ErrorInfo;
	private busy = new Set<string>();
	private disposed = false;
	/** The dashboard's auto-refresh switch. Off pauses polling, not views. */
	private autoRefresh = true;
	/** `/health` timed out; see `pollHealth`. */
	private healthStalled = false;

	/** Longest a stuck `/health` waits before it is asked again. */
	private static readonly HEALTH_MAX_BACKOFF_MS = 30_000;

	/** How far behind the newest successful poll may fall before it is stale. */
	private static readonly STALE_FACTOR = 4;

	/**
	 * Floor for the Foundry liveness poll. It spawns a process each time, so
	 * it never runs faster than this even if `/status` is polled every 500 ms.
	 */
	private static readonly FOUNDRY_LIVE_MIN_MS = 3_000;

	/** Full Foundry snapshot (version, hardware): three processes, so slow. */
	private static readonly FOUNDRY_SNAPSHOT_MS = 15_000;

	/** `foundry server status` state words for a daemon on its way up. */
	private static readonly DAEMON_BOOTING = new Set(['initializing', 'starting']);

	private static foundryLiveInterval(settings: ExtensionSettings): number {
		return Math.max(settings.refreshInterval, MonitorService.FOUNDRY_LIVE_MIN_MS);
	}

	constructor(
		settings: ExtensionSettings,
		private readonly processes: ProcessManager,
		private readonly logger: Logger,
	) {
		this.settings = settings;
		this.client = new KVStreamClient({ baseUrl: settings.url, timeoutMs: settings.requestTimeout });
		this.detector = new FoundryDetector(settings.foundryPath, settings.enableFoundryCli);
		this.history = new HistoryStore(settings.historyWindow);

		this.fastPoll = new PollingScheduler(() => this.pollStatus(), settings.refreshInterval);
		this.healthPoll = new PollingScheduler(
			() => this.pollHealth(),
			settings.refreshInterval,
			MonitorService.HEALTH_MAX_BACKOFF_MS,
		);
		this.metricsPoll = new PollingScheduler(() => this.pollMetrics(), settings.metricsRefreshInterval);
		// Whether the daemon is up is checked often, so starting or stopping
		// Foundry Local from anywhere shows within seconds. The full snapshot is
		// three processes and its answers (version, hardware) rarely change.
		this.foundryLivePoll = new PollingScheduler(
			() => this.pollFoundryLiveness(),
			MonitorService.foundryLiveInterval(settings),
			30_000,
		);
		this.foundryPoll = new PollingScheduler(
			() => this.pollFoundry(),
			MonitorService.FOUNDRY_SNAPSHOT_MS,
			120_000,
		);

		this.processes.onDidChange(() => this.publish());
	}

	/**
	 * Register a view. Polling runs only while at least one view wants it.
	 *
	 * Returned disposable must be called when the view is hidden or disposed;
	 * a closed sidebar should not keep the gateway awake.
	 */
	subscribe(): vscode.Disposable {
		this.subscribers++;
		if (this.subscribers === 1) {
			this.resume();
		}
		let released = false;
		return new vscode.Disposable(() => {
			if (released) {
				return;
			}
			released = true;
			this.subscribers = Math.max(0, this.subscribers - 1);
			if (this.subscribers === 0) {
				this.pause();
			}
		});
	}

	private resume(): void {
		if (this.disposed || !this.autoRefresh) {
			return;
		}
		// Resuming after a pause leaves a hole in the counter history; starting
		// a new interval avoids reporting an average across the dead time.
		this.history.breakContinuity();
		this.fastPoll.start();
		this.healthPoll.start();
		this.metricsPoll.start();
		this.foundryPoll.start();
		this.foundryLivePoll.start();
	}

	private pause(): void {
		this.fastPoll.stop();
		this.healthPoll.stop();
		this.metricsPoll.stop();
		this.foundryPoll.stop();
		this.foundryLivePoll.stop();
	}

	get isPolling(): boolean {
		return this.fastPoll.isRunning;
	}

	/**
	 * Pause or resume polling from the dashboard switch.
	 *
	 * Paused, the views keep their last sample and the staleness marker comes
	 * on as it ages, so a frozen screen is never mistaken for a live one.
	 * Refresh still takes a one-off sample.
	 */
	setAutoRefresh(enabled: boolean): void {
		if (this.autoRefresh === enabled) {
			return;
		}
		this.autoRefresh = enabled;
		if (!enabled) {
			this.pause();
		} else if (this.subscribers > 0) {
			this.resume();
		}
		this.publish();
	}

	/** Poll all sources now. Used by the Refresh command and the view buttons. */
	refresh(): void {
		if (!this.fastPoll.isRunning) {
			// A refresh from the command palette with no view open, or with
			// auto-refresh off, should still work: one sample, then quiet.
			void this.pollStatus();
			void this.pollHealth();
			void this.pollMetrics();
			void this.pollFoundry();
			return;
		}
		this.fastPoll.trigger();
		this.healthPoll.trigger();
		this.metricsPoll.trigger();
		this.foundryPoll.trigger();
		this.foundryLivePoll.trigger();
	}

	/** Force a fresh readiness generation on the backend (`/health?probe=true`). */
	async checkHealth(): Promise<{ ok: boolean; detail: string }> {
		try {
			const result = await this.client.health({ probe: true });
			this.applyHealth(result.body, result.ok);
			this.lastSuccessAt = Date.now();
			this.healthError = undefined;
			this.healthStalled = false;
			this.publish();
			const readiness = result.body.readiness?.detail;
			return {
				ok: result.ok,
				detail: result.ok
					? `KVStream is serving (${result.body.model ?? 'model not reported'}).`
					: `KVStream is not serving: ${result.body.hint ?? readiness ?? 'no detail reported'}`,
			};
		} catch (error) {
			const info = this.toErrorInfo(error);
			if (info.kind === 'timeout' && this.status) {
				// The gateway is up (/status answers); /health is held open while
				// KVStream looks for its backend. Say that, not "no response".
				const detail = this.status.backend?.resolution?.detail;
				return {
					ok: false,
					detail:
						this.status.backend?.resolution?.source === 'unresolved'
							? `KVStream is running but has not found Foundry Local, so /health did not answer in time.${detail ? ` ${detail}` : ''}`
							: 'KVStream is running, but its readiness probe did not finish in time. The backend may be busy or stalled.',
				};
			}
			this.healthError = info;
			this.publish();
			return { ok: false, detail: info.message };
		}
	}

	applySettings(settings: ExtensionSettings): void {
		const endpointChanged = settings.url !== this.settings.url;
		this.settings = settings;
		this.client.update({ baseUrl: settings.url, timeoutMs: settings.requestTimeout });
		this.detector.update(settings.foundryPath, settings.enableFoundryCli);
		this.history.setWindow(settings.historyWindow);
		this.fastPoll.setInterval(settings.refreshInterval);
		this.healthPoll.setInterval(settings.refreshInterval);
		this.metricsPoll.setInterval(settings.metricsRefreshInterval);
		this.foundryLivePoll.setInterval(MonitorService.foundryLiveInterval(settings));
		// A different executable, or the CLI switched off, makes the last
		// reading meaningless; the next snapshot starts clean.
		this.foundryLive = undefined;

		if (endpointChanged) {
			// A different gateway has different counters. Keeping the old series
			// would draw one service's history as if it were another's.
			this.history.clear();
			this.health = undefined;
			this.status = undefined;
			this.metrics = undefined;
			this.lastSuccessAt = undefined;
			this.statusError = undefined;
			this.healthError = undefined;
			this.healthStalled = false;
			this.logger.info(`Endpoint changed to ${settings.url}; history reset.`);
		}
		this.generation++;
		this.publish();
		this.refresh();
	}

	setBusy(operation: string, value: boolean): void {
		if (value) {
			this.busy.add(operation);
		} else {
			this.busy.delete(operation);
		}
		this.publish();
	}

	get state(): ViewModel {
		return this.buildViewModel();
	}

	// -- polling ---------------------------------------------------------

	/**
	 * `/status` — the fast, cheap source of truth for "is the gateway up".
	 *
	 * It is polled separately from `/health` because of measured gateway
	 * behaviour (KVStream 1.0.0): `/health` runs a real one-token generation
	 * as its readiness probe (3.2 s observed, against a 0.002 s `/status`), and
	 * while it cannot find Foundry Local it re-scans localhost and does not
	 * answer for over a minute. Coupling the two would freeze the dashboard
	 * behind whichever probe is slowest.
	 */
	private async pollStatus(): Promise<boolean> {
		const generation = this.generation;
		try {
			const status = await this.client.status();
			if (generation !== this.generation) {
				return false;
			}
			const cameUp = this.status === undefined;
			this.status = status;
			this.statusError = undefined;
			this.lastSuccessAt = Date.now();
			this.publish();
			if (cameUp) {
				// The gateway just started answering. /health and /metrics may be
				// deep in a backoff from while it was down; ask them now rather
				// than leave the dashboard half-empty for up to a minute.
				this.healthPoll.trigger();
				this.metricsPoll.trigger();
			}
			return true;
		} catch (error) {
			if (generation !== this.generation) {
				return false;
			}
			this.status = undefined;
			this.statusError = this.toErrorInfo(error);
			this.publish();
			// A gateway this extension just started is booting, not absent: keep
			// the normal cadence so it shows up as soon as it listens.
			const process = this.processes.state;
			return process.ownedByExtension && (process.state === 'starting' || process.state === 'running');
		}
	}

	/**
	 * `/health` — the gateway's verdict on whether the backend can serve.
	 *
	 * A timeout here while `/status` answers means "up, still looking for or
	 * probing its backend": degraded, not broken. Returning `false` lets the
	 * scheduler back off, so a stuck `/health` is re-asked rarely rather than
	 * every cycle — each abandoned call may leave a scan running in the gateway.
	 */
	private async pollHealth(): Promise<boolean> {
		const generation = this.generation;
		try {
			const result = await this.client.health();
			if (generation !== this.generation) {
				return false;
			}
			this.applyHealth(result.body, result.ok);
			this.healthStalled = false;
			this.healthError = undefined;
			this.lastSuccessAt = Date.now();
			this.publish();
			return true;
		} catch (error) {
			if (generation !== this.generation) {
				return false;
			}
			this.health = undefined;
			this.healthOk = false;
			const info = this.toErrorInfo(error);
			this.healthStalled = info.kind === 'timeout';
			this.healthError = info;
			this.publish();
			return false;
		}
	}

	/**
	 * The banners to show, built from the latest outcome of each source.
	 *
	 * When `/status` answers, a `/health` failure is reported as a notice with
	 * KVStream's own explanation rather than as a red error: the gateway is
	 * demonstrably up. When both fail for one reason it is said once.
	 */
	private currentErrors(): ErrorInfo[] {
		const errors: ErrorInfo[] = [];
		if (this.statusError) {
			errors.push(this.statusError);
		}
		if (this.healthError) {
			if (this.status && this.healthStalled) {
				errors.push({
					kind: 'notice',
					message: '/health is not answering in time, so health is read from /status for now.',
					hint:
						this.status.backend?.resolution?.source === 'unresolved'
							? `KVStream holds /health open while it searches for Foundry Local. ${this.status.backend.resolution.detail ?? ''}`.trim()
							: 'KVStream runs a real generation to answer /health; the backend may be busy or stalled.',
				});
			} else if (!errors.some((e) => e.kind === this.healthError?.kind)) {
				errors.push(this.healthError);
			}
		}
		return errors;
	}

	private async pollMetrics(): Promise<boolean> {
		const generation = this.generation;
		try {
			const registry = await this.client.metrics();
			if (generation !== this.generation) {
				return false;
			}
			this.metrics = registry;
			const requests = deriveRequestMetrics(registry, this.status?.admission);
			const budget = deriveBudget(registry, this.status?.admission);
			this.history.record(Date.now(), historySample(requests, budget));
			this.publish();
			return true;
		} catch (error) {
			if (generation !== this.generation) {
				return false;
			}
			// A failing /metrics must not blank health or status, so this is
			// recorded and the rest of the dashboard carries on.
			this.metrics = undefined;
			this.history.breakContinuity();
			this.logger.debug(`/metrics unavailable: ${error instanceof Error ? error.message : String(error)}`);
			this.publish();
			return false;
		}
	}

	private async pollFoundry(): Promise<boolean> {
		const generation = this.generation;
		const snapshot = await this.detector.snapshot();
		if (generation !== this.generation || this.disposed) {
			return false;
		}
		// The snapshot takes seconds; a liveness reading taken after it began
		// is newer about whether the daemon is up, so it is kept on top.
		const live = this.foundryLive;
		this.foundry =
			live && live.collectedAt > snapshot.collectedAt ? applyLiveness(snapshot, live) : snapshot;
		this.publish();
		return this.foundry.cliAvailable;
	}

	/** `foundry server status` only: is the daemon up right now? */
	private async pollFoundryLiveness(): Promise<boolean> {
		const generation = this.generation;
		const result = await this.detector.liveness();
		if (generation !== this.generation || this.disposed) {
			return false;
		}
		if (result.status !== 'ok') {
			// A missing CLI or an unreadable answer is explained by the full
			// snapshot; here it only slows this poll down.
			return false;
		}
		this.foundryLive = result.live;
		this.foundry = applyLiveness(this.foundry, result.live);
		this.publish();
		return true;
	}

	private applyHealth(body: HealthBody, ok: boolean): void {
		this.health = body;
		this.healthOk = ok;
	}

	private toErrorInfo(error: unknown): ErrorInfo {
		if (error instanceof RequestError) {
			return { kind: error.kind, message: error.message, hint: error.hint };
		}
		this.logger.error('Unexpected monitoring failure', error);
		return { kind: 'error', message: 'Unexpected error while polling; see the output channel.' };
	}

	// -- view model ------------------------------------------------------

	private publish(): void {
		if (!this.disposed) {
			this.emitter.fire(this.buildViewModel());
		}
	}

	private buildViewModel(): ViewModel {
		const admission = this.status?.admission;
		const requests = deriveRequestMetrics(this.metrics, admission);
		const budget = deriveBudget(this.metrics, admission);
		const process = this.processes.state;

		// `backend.base_url` is not a discovery result on its own: verified on
		// KVStream 1.0.0, it holds the configured default (`localhost:5273`)
		// while `resolution.source` is `unresolved`. Only a resolved URL is
		// shown as the backend address.
		const resolution = this.status?.backend?.resolution;
		const unresolved = resolution?.source === 'unresolved';
		const kvstreamBackendUrl = unresolved
			? undefined
			: (resolution?.url ?? this.health?.backendUrl ?? this.status?.backend?.baseUrl);
		const endpoint = pickBackendEndpoint(
			kvstreamBackendUrl,
			resolution?.source,
			this.foundry,
			unresolved ? resolution?.detail : undefined,
		);

		const service = this.deriveServiceState(process.state);
		const backend = this.deriveBackendState();
		const shown = presentBackend(backend, endpoint, {
			id: this.health?.model ?? this.status?.model?.id ?? undefined,
			source: this.health?.modelSource ?? this.status?.model?.source,
		});

		const staleAfter = Math.max(
			this.settings.refreshInterval * MonitorService.STALE_FACTOR,
			this.settings.metricsRefreshInterval * 2,
		);
		const stale =
			this.lastSuccessAt !== undefined && Date.now() - this.lastSuccessAt > staleAfter;

		return {
			service,
			backend,
			connection: {
				gatewayUrl: this.settings.url,
				backendUrl: shown.url,
				backendUrlSource: shown.source,
				backendUrlDetail: shown.detail,
				foundryCandidates: endpoint.candidates,
				foundryCliVersion: this.foundry?.cliVersion,
				foundryDaemonState: this.foundry?.daemonState,
				foundryUptime: this.foundry?.uptime,
				loadedModels: this.status?.model?.inventory?.loaded ?? undefined,
				model: shown.model,
				modelSource: shown.modelSource,
				gatewayVersion: this.health?.version ?? this.status?.version,
			},
			requests,
			budget,
			budgetSource: this.status?.budgetSource?.source,
			runtimeProfile: this.status?.runtimeProfile,
			circuitBreakerState: this.health?.circuitBreaker?.state ?? this.status?.backendHealth?.circuitBreaker?.state,
			backendHint: backend === 'serving' ? undefined : this.backendExplanation(),
			driftState: this.health?.drift?.state ?? this.status?.drift?.state,
			queueOldestWaitSeconds:
				admission?.queue?.oldestWaitSeconds === undefined
					? { reason: 'not reported by this gateway' }
					: { value: admission.queue.oldestWaitSeconds },
			drainRatePerSecond:
				admission?.drainRatePerSecond === undefined
					? { reason: 'not reported by this gateway' }
					: { value: admission.drainRatePerSecond },
			resources: this.buildResources(),
			trends: {
				throughput: this.history.throughput.snapshot(),
				queueDepth: this.history.queueDepth.snapshot(),
				running: this.history.running.snapshot(),
				utilization: this.history.utilization.snapshot(),
				windowMs: this.history.window,
				// Two missed metric polls is a gap, not a line.
				maxGapMs: this.settings.metricsRefreshInterval * 2.5,
			},
			process,
			capabilities: this.buildCapabilities(),
			lastSuccessAt: this.lastSuccessAt,
			stale,
			autoRefresh: this.autoRefresh,
			errors: this.currentErrors(),
			busy: [...this.busy],
		};
	}

	private deriveServiceState(processState: string): ServiceState {
		if (processState === 'starting') {
			return 'starting';
		}
		if (this.health) {
			if (this.healthOk) {
				return 'healthy';
			}
			// A 503 from /health is the gateway answering: it is up, the backend
			// is not serving. That is degraded, not disconnected.
			return 'degraded';
		}
		if (this.status) {
			// The gateway is up. Until /health answers, use the verdict the
			// gateway itself last recorded in /status (`backend_health`), which
			// comes from the same readiness probe — never a guess of ours.
			if (this.healthStalled || this.healthError) {
				return 'degraded';
			}
			const backend = this.status.backendHealth;
			if (backend?.reachable === undefined) {
				return 'loading';
			}
			const serving =
				backend.reachable === true &&
				backend.readiness?.ready === true &&
				backend.circuitBreaker?.state !== 'open';
			return serving ? 'healthy' : 'degraded';
		}
		const failure = this.statusError ?? this.healthError;
		if (failure?.kind === 'offline') {
			return processState === 'exited' ? 'stopped' : 'disconnected';
		}
		if (failure) {
			return 'error';
		}
		return this.lastSuccessAt === undefined ? 'loading' : 'unknown';
	}

	private deriveBackendState(): BackendState {
		// The CLI saying the daemon is down is direct evidence, read every few
		// seconds, and it outranks anything the gateway says. Plain /health
		// answers from KVStream's readiness cache, so for a while after Foundry
		// Local stops it still reports "serving" (seen live: the card stayed on
		// Serving after `foundry server stop` had completed). A stopped daemon
		// serves nothing, whatever the cache says.
		if (this.foundry?.cliAvailable === true && !this.foundry.daemonRunning) {
			// CLI 0.10.3 reports a booting daemon as `running: false` with
			// `state: "initializing"` for 15 s or more; that is not "stopped".
			return MonitorService.DAEMON_BOOTING.has(this.foundry.daemonState) ? 'starting' : 'stopped';
		}

		// Otherwise the gateway is the authority on serving: it is the only
		// thing that probes the backend with a generation. The CLI only says a
		// daemon process exists, so it never upgrades to "serving".
		if (this.health?.backendServing === true) {
			return 'serving';
		}
		if (this.health?.backendReachable === true) {
			return this.noModelLoaded() ? 'no_model' : 'reachable';
		}
		if (this.health?.backendReachable === false) {
			return 'unreachable';
		}
		// Without /health, /status carries the verdict the gateway last
		// recorded.
		const backendHealth = this.status?.backendHealth;
		if (backendHealth?.reachable === true) {
			if (backendHealth.readiness?.ready === true) {
				return 'serving';
			}
			return this.noModelLoaded() ? 'no_model' : 'reachable';
		}
		if (this.status?.backend?.resolution?.source === 'unresolved') {
			return 'unreachable';
		}
		// No verdict from the gateway (typically: it is not running). The
		// daemon being up is still worth showing, as "running", not "serving".
		if (this.foundry?.cliAvailable && this.foundry.daemonRunning) {
			return 'running';
		}
		return 'unknown';
	}

	/**
	 * KVStream's own words for why the backend is not serving.
	 *
	 * `/health`'s `hint` is the deliberate explanation, but /health answers a
	 * few seconds after /status. Until then /status already carries the
	 * model-detection verdict ("undetermined: no model is loaded in Foundry
	 * Local…"). Readiness placeholders — seen live: "not probed yet" — explain
	 * nothing and are skipped rather than shown as a reason.
	 */
	private backendExplanation(): string | undefined {
		const model = this.status?.model;
		const candidates = [
			this.health?.hint,
			model && !model.id ? model.source : undefined,
			this.health?.readiness?.detail,
			this.status?.backendHealth?.readiness?.detail,
		];
		return candidates.find((text) => !!text && !MonitorService.PLACEHOLDER_DETAIL.test(text.trim()));
	}

	/** Readiness and model-source words that are a state, not an explanation. */
	private static readonly PLACEHOLDER_DETAIL = /^(not probed yet|not yet detected)\.?$/i;

	/**
	 * KVStream's inventory (from `foundry cache list`) reports nothing loaded.
	 * The commonest reason for "reachable but not serving": Foundry Local
	 * starts and restarts with no model in memory.
	 */
	private noModelLoaded(): boolean {
		const loaded = this.status?.model?.inventory?.loaded;
		return Array.isArray(loaded) && loaded.length === 0;
	}

	private buildResources(): ViewModel['resources'] {
		const system = this.foundry?.system;
		if (!system) {
			return {
				unavailableReason: this.foundry?.cliAvailable
					? 'the Foundry CLI did not report hardware information'
					: 'requires the Foundry Local CLI',
			};
		}
		const gpu = system.gpus[0];
		return {
			gpuName: gpu?.name,
			gpuTotalBytes: gpu?.videoMemoryBytes,
			systemTotalBytes: system.totalMemoryBytes,
			systemAvailableBytes: system.availableMemoryBytes,
			collectedAt: this.foundry?.collectedAt,
		};
	}

	private buildCapabilities(): Capabilities {
		const owned = this.processes.state.state === 'running' && this.processes.state.ownedByExtension;
		const reasons: Record<string, string> = {};

		if (!owned) {
			const why =
				'KVStream has no stop or restart command, so this is only possible for a gateway ' +
				'this extension started itself.';
			reasons['canStopKvstream'] = why;
			reasons['canRestartKvstream'] = why;
			reasons['liveLogs'] =
				'KVStream exposes no logs endpoint. Live logs are only available for a gateway ' +
				'started from here.';
		}
		if (!this.foundry?.cliAvailable) {
			reasons['canControlFoundry'] = this.settings.enableFoundryCli
				? 'The Foundry Local CLI was not found.'
				: 'Foundry CLI use is disabled by kvstream.enableFoundryCli.';
			reasons['canLoadModel'] = reasons['canControlFoundry'];
		} else if (!this.foundry.daemonRunning) {
			// `foundry cache list` and `model load` would start a stopped daemon
			// as a side effect; starting it is the Start button's job.
			reasons['canLoadModel'] = 'Foundry Local is not running. Start it first.';
		}

		// A second `kvstream serve` against an address that already answers
		// would only fail on the port bind, so Start is refused up front.
		const processBusy = this.processes.state.state === 'running' || this.processes.state.state === 'starting';
		const externalGatewayUp = this.health !== undefined && !owned;
		if (processBusy) {
			reasons['canStartKvstream'] = 'a gateway started here is already running';
		} else if (externalGatewayUp) {
			reasons['canStartKvstream'] = `a gateway is already answering at ${this.settings.url}`;
		}

		return {
			canStartKvstream: !processBusy && !externalGatewayUp,
			canStopKvstream: owned,
			canRestartKvstream: owned,
			canControlFoundry: this.foundry?.cliAvailable === true,
			canLoadModel: this.foundry?.cliAvailable === true && this.foundry.daemonRunning,
			liveLogs: owned,
			// `kvstream calibrate` exists in the CLI, but it drives real load
			// through the backend for up to a minute. Offered only as a command
			// that runs in a terminal the user can watch and interrupt.
			calibrate: true,
			reasons,
		};
	}

	dispose(): void {
		this.disposed = true;
		this.pause();
		this.emitter.dispose();
	}
}
