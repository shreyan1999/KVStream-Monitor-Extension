/**
 * The one shape both the sidebar and the dashboard render.
 *
 * The monitoring service owns it; views are pure consumers. Anything the
 * gateway did not report is absent here rather than zeroed, so the UI can tell
 * "the service said zero" from "we could not measure this".
 */

import type { BudgetMetrics, Measured, RequestMetrics, Sample } from './metrics';
import type { RuntimeProfile } from './kvstream';

export type ServiceState =
	| 'loading'
	| 'healthy'
	| 'degraded'
	| 'starting'
	| 'stopped'
	| 'disconnected'
	| 'error'
	| 'unknown';

export type BackendState =
	| 'serving'
	| 'reachable'
	/** The Foundry CLI says the daemon is up; nothing has probed it with a request. */
	| 'running'
	/** The daemon is initializing: `running` is still false, but it is on its way up. */
	| 'starting'
	/** Up and reachable, but KVStream's inventory says no model is loaded, so nothing can be served. */
	| 'no_model'
	| 'unreachable'
	| 'not_installed'
	| 'stopped'
	| 'unknown';

export interface ConnectionInfo {
	/** The configured gateway base URL. */
	gatewayUrl: string;
	/** Backend URL as reported by KVStream, when it reported one. */
	backendUrl?: string;
	/** How KVStream found it: `configured`, `foundry-cli`, `scan`, ... */
	backendUrlSource?: string;
	backendUrlDetail?: string;
	/** Candidate endpoints the extension found via the Foundry CLI. */
	foundryCandidates: string[];
	foundryCliVersion?: string;
	foundryDaemonState?: string;
	/** Daemon uptime exactly as `foundry server status` printed it. */
	foundryUptime?: string;
	/** Model ids KVStream's inventory says Foundry Local has loaded; absent when not reported. */
	loadedModels?: string[];
	model?: string;
	modelSource?: string;
	gatewayVersion?: string;
}

export interface ErrorInfo {
	/** Short, user-facing. Never a raw stack. */
	message: string;
	/** `offline` | `timeout` | `http` | `schema` | `config`, or `notice` for an informational banner */
	kind: string;
	/** What the user can do about it. */
	hint?: string;
}

export interface SystemResources {
	/** From `foundry status --output json`; absent when the CLI is unavailable. */
	gpuName?: string;
	gpuTotalBytes?: number;
	systemTotalBytes?: number;
	systemAvailableBytes?: number;
	collectedAt?: number;
	unavailableReason?: string;
}

export interface TrendSeries {
	throughput: Sample[];
	queueDepth: Sample[];
	running: Sample[];
	utilization: Sample[];
	/** Samples older than this are outside the retained window. */
	windowMs: number;
	/** A gap longer than this must be drawn as a break, not a straight line. */
	maxGapMs: number;
}

export interface ProcessInfo {
	/** True only for a `kvstream serve` this extension spawned. */
	ownedByExtension: boolean;
	pid?: number;
	/**
	 * Epoch ms the owned process was spawned. KVStream reports no uptime of
	 * its own, so this is the only uptime the UI can show for the gateway, and
	 * only for a process started here.
	 */
	startedAt?: number;
	state: 'running' | 'starting' | 'stopping' | 'exited' | 'none';
	exitDetail?: string;
}

export interface Capabilities {
	/** Stopping/restarting KVStream needs a process the extension owns. */
	canStopKvstream: boolean;
	canRestartKvstream: boolean;
	canStartKvstream: boolean;
	canControlFoundry: boolean;
	/** Loading a model needs the CLI and a running daemon. */
	canLoadModel: boolean;
	/** KVStream exposes no logs endpoint; live logs need an owned process. */
	liveLogs: boolean;
	calibrate: boolean;
	/** Why each unavailable capability is unavailable, keyed by capability. */
	reasons: Record<string, string>;
}

export interface ViewModel {
	service: ServiceState;
	backend: BackendState;
	connection: ConnectionInfo;
	requests: RequestMetrics;
	budget: BudgetMetrics;
	budgetSource?: string;
	runtimeProfile?: RuntimeProfile;
	circuitBreakerState?: string;
	/** KVStream's own explanation of why the backend is not serving, verbatim. */
	backendHint?: string;
	driftState?: string;
	queueOldestWaitSeconds: Measured;
	drainRatePerSecond: Measured;
	resources: SystemResources;
	trends: TrendSeries;
	process: ProcessInfo;
	capabilities: Capabilities;
	/** Epoch ms of the last poll that produced usable data. */
	lastSuccessAt?: number;
	/** True when the newest data is older than the staleness threshold. */
	stale: boolean;
	/** False while the user has paused polling from the dashboard. */
	autoRefresh: boolean;
	errors: ErrorInfo[];
	/** Operation ids currently running, so views can disable their controls. */
	busy: string[];
}
