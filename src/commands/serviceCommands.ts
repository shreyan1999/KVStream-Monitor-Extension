import * as vscode from 'vscode';
import type { MonitorService } from '../monitoring/monitorService';
import type { ProcessManager } from '../processes/processManager';
import type { LogService } from '../services/logService';
import type { Logger } from '../logging';
import type { MonitorActions } from '../views/actions';
import type { ExtensionSettings } from '../config/settings';
import { validateUrl } from '../config/settings';
import { run, stripAnsi } from '../processes/run';
import { parseCacheList, parseJson, parseServerStatus, type CachedModel } from '../foundry/detector';

export interface ServiceCommandDeps {
	monitor: MonitorService;
	processes: ProcessManager;
	logs: LogService;
	logger: Logger;
	settings: () => ExtensionSettings;
	openDashboard: () => void;
	openLogs: () => void;
}

/**
 * The one implementation behind every button and every Command Palette entry.
 *
 * Two things every disruptive operation does, without exception:
 *
 *  - **Name the target before asking.** "Stop KVStream" is ambiguous when two
 *    gateways could be running; the prompt says which URL or pid is affected.
 *  - **Report what happened, not what was attempted.** Nothing here shows a
 *    success message before the operation returns, and a failure says what
 *    failed rather than falling back to a generic error.
 *
 * `busy` guards re-entry: while an operation is in flight the views disable
 * its control, and a second invocation from the Command Palette is refused,
 * so a double click cannot start two gateways or race a stop against a start.
 */
export class ServiceCommands implements MonitorActions {
	private readonly inFlight = new Set<string>();

	constructor(private readonly deps: ServiceCommandDeps) {}

	refresh(): void {
		this.deps.monitor.refresh();
	}

	openDashboard(): void {
		this.deps.openDashboard();
	}

	openOutput(): void {
		this.deps.logger.show();
	}

	openSettings(): void {
		void vscode.commands.executeCommand('workbench.action.openSettings', 'kvstream.');
	}

	openLogs(): void {
		this.deps.openLogs();
	}

	setAutoRefresh(enabled: boolean): void {
		this.deps.monitor.setAutoRefresh(enabled);
	}

	async checkHealth(): Promise<void> {
		await this.guard('checkHealth', async () => {
			const result = await this.deps.monitor.checkHealth();
			if (result.ok) {
				void vscode.window.showInformationMessage(result.detail);
			} else {
				void vscode.window.showWarningMessage(result.detail);
			}
		});
	}

	async configureEndpoint(): Promise<void> {
		const current = this.deps.settings().url;
		const value = await vscode.window.showInputBox({
			title: 'KVStream gateway URL',
			prompt: 'Base URL of the KVStream gateway (not the Foundry Local backend).',
			value: current,
			ignoreFocusOut: true,
			validateInput: (input) => validateUrl(input).error,
		});
		if (value === undefined) {
			return;
		}
		const checked = validateUrl(value);
		if (!checked.url) {
			void vscode.window.showErrorMessage(`Not a usable URL: ${checked.error}`);
			return;
		}
		const target = vscode.workspace.workspaceFolders?.length
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		await vscode.workspace.getConfiguration('kvstream').update('url', checked.url, target);
		void vscode.window.showInformationMessage(`KVStream endpoint set to ${checked.url}.`);
	}

	async startService(): Promise<void> {
		await this.guard('startService', async () => {
			const settings = this.deps.settings();
			if (this.deps.processes.state.state === 'running') {
				void vscode.window.showInformationMessage(
					'A KVStream gateway started by this extension is already running.',
				);
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				`Start KVStream with "${settings.kvstreamPath} serve"?`,
				{
					modal: true,
					detail:
						'The gateway runs as a child process of VS Code and its output appears in the ' +
						'Logs panel. KVStream has no stop command, so this extension stops the process ' +
						'it started when the extension deactivates (for example when the window closes).',
				},
				'Start',
			);
			if (confirm !== 'Start') {
				return;
			}

			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Starting KVStream…' },
				async () => {
					const result = await this.deps.processes.start({
						executable: settings.kvstreamPath,
						args: settings.kvstreamArgs,
						cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
					});
					if (result.ok) {
						void vscode.window.showInformationMessage(result.detail);
					} else {
						void vscode.window.showErrorMessage(result.detail);
					}
					this.deps.monitor.refresh();
				},
			);
		});
	}

	async stopService(): Promise<void> {
		await this.guard('stopService', async () => {
			const state = this.deps.processes.state;
			if (state.state !== 'running' || !state.ownedByExtension) {
				void vscode.window.showWarningMessage(
					'This extension did not start the gateway it is monitoring, so it cannot stop it. ' +
						'KVStream has no stop command — stop it where it was started (Ctrl+C).',
				);
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Stop the KVStream gateway (pid ${state.pid ?? 'unknown'})?`,
				{
					modal: true,
					detail:
						process.platform === 'win32'
							? 'On Windows the process is terminated directly: requests still in flight are ' +
								'cut off rather than drained.'
							: 'KVStream drains in-flight requests and refuses queued ones on SIGTERM.',
				},
				'Stop',
			);
			if (confirm !== 'Stop') {
				return;
			}
			const result = await this.deps.processes.stop();
			if (result.ok) {
				void vscode.window.showInformationMessage(result.detail);
			} else {
				void vscode.window.showErrorMessage(result.detail);
			}
			this.deps.monitor.refresh();
		});
	}

	async restartService(): Promise<void> {
		await this.guard('restartService', async () => {
			const state = this.deps.processes.state;
			if (state.state !== 'running' || !state.ownedByExtension) {
				void vscode.window.showWarningMessage(
					'Only a gateway started by this extension can be restarted from here.',
				);
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Restart the KVStream gateway (pid ${state.pid ?? 'unknown'})?`,
				{ modal: true, detail: 'In-flight requests will be interrupted.' },
				'Restart',
			);
			if (confirm !== 'Restart') {
				return;
			}
			const settings = this.deps.settings();
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Restarting KVStream…' },
				async () => {
					const result = await this.deps.processes.restart({
						executable: settings.kvstreamPath,
						args: settings.kvstreamArgs,
						cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
					});
					if (result.ok) {
						void vscode.window.showInformationMessage(result.detail);
					} else {
						void vscode.window.showErrorMessage(result.detail);
					}
					this.deps.monitor.refresh();
				},
			);
		});
	}

	startFoundry(): Promise<void> {
		return this.foundryCommand('startFoundry', 'start', 'Start Foundry Local?', 'Start', undefined);
	}

	stopFoundry(): Promise<void> {
		return this.foundryCommand(
			'stopFoundry',
			'stop',
			'Stop the Foundry Local daemon?',
			'Stop',
			'Foundry Local is a machine-wide service. Anything else using it — other editors, ' +
				'agents, or a KVStream gateway outside this window — loses its backend.',
		);
	}

	restartFoundry(): Promise<void> {
		return this.foundryCommand(
			'restartFoundry',
			'restart',
			'Restart the Foundry Local daemon?',
			'Restart',
			'Foundry Local is a machine-wide service, and it takes a new ephemeral port on almost ' +
				'every restart. Anything holding its current address will need to rediscover it.',
		);
	}

	/**
	 * Pick a downloaded model and load it into Foundry Local.
	 *
	 * Foundry Local starts — and restarts — with no model in memory, and
	 * KVStream cannot serve until one is loaded, so Start alone never gets the
	 * stack serving. Offered only while the daemon is up: on CLI 0.10.3 both
	 * `cache list` and `model load` start a stopped daemon as a side effect,
	 * and starting it is the Start button's job, behind its own confirmation.
	 * The pick list is the confirmation here; loading changes no files.
	 */
	async loadFoundryModel(): Promise<void> {
		await this.guard('loadFoundryModel', async () => {
			const settings = this.deps.settings();
			if (!settings.enableFoundryCli) {
				void vscode.window.showWarningMessage('Foundry CLI use is disabled by kvstream.enableFoundryCli.');
				return;
			}
			const exe = settings.foundryPath;

			const server = await run(exe, ['server', 'status', '--output', 'json'], { timeoutMs: 15_000 });
			if (server.spawnError && server.spawnError !== 'timed out') {
				void vscode.window.showErrorMessage(`Could not run "${exe}": ${server.spawnError}`);
				return;
			}
			const live = server.code === 0 ? parseServerStatus(parseJson(server.stdout)) : undefined;
			if (!live?.daemonRunning) {
				void vscode.window.showWarningMessage(
					'Foundry Local is not running. Start it from Quick Actions first, then load a model.',
				);
				return;
			}

			const cache = await run(exe, ['cache', 'list', '--output', 'json'], { timeoutMs: 30_000 });
			const models = cache.code === 0 ? parseCacheList(parseJson(cache.stdout)) : undefined;
			if (!models) {
				void vscode.window.showErrorMessage(
					'Could not read the downloaded models (`foundry cache list --output json`).',
				);
				return;
			}
			if (models.length === 0) {
				void vscode.window.showInformationMessage(
					'No models are downloaded yet. Download one with `foundry model download <alias>`, then load it here.',
				);
				return;
			}

			const pick = await vscode.window.showQuickPick(
				models.map((model) => ({
					label: `${model.loaded ? '$(check) ' : ''}${model.alias ?? model.id}`,
					description: model.id,
					detail: describeCachedModel(model),
					model,
				})),
				{
					title: 'Load a Foundry Local model',
					placeHolder: 'Downloaded models. Loading one uses GPU or system memory until it is unloaded.',
					ignoreFocusOut: true,
				},
			);
			if (!pick) {
				return;
			}

			const id = pick.model.id;
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Loading ${id} into Foundry Local…` },
				async () => {
					const result = await run(exe, ['model', 'load', id], { timeoutMs: 15 * 60_000 });
					if (result.spawnError) {
						void vscode.window.showErrorMessage(`Could not load ${id}: ${result.spawnError}`);
					} else if (result.code === 0) {
						this.deps.logs.note(`foundry model load ${id} completed.`, 'info', 'foundry');
						void vscode.window.showInformationMessage(`Loaded ${id} into Foundry Local.`);
					} else {
						const message = stripAnsi(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
						this.deps.logs.note(`foundry model load ${id} failed: ${message}`, 'error', 'foundry');
						void vscode.window.showErrorMessage(
							`foundry model load exited with code ${result.code}. ${message}`.trim(),
						);
					}
					// KVStream looks for a newly loaded model on every /health, so
					// a refresh is enough for the dashboard to turn Healthy.
					this.deps.monitor.refresh();
				},
			);
		});
	}

	/**
	 * Run one `foundry server <verb>`.
	 *
	 * Foundry Local is shared, so every verb is confirmed and the confirmation
	 * says who else is affected. The CLI is invoked with an argv array and no
	 * shell, and its own exit code decides what the user is told — the
	 * extension never reports success because it managed to spawn something.
	 */
	private async foundryCommand(
		id: string,
		verb: 'start' | 'stop' | 'restart',
		question: string,
		confirmLabel: string,
		detail: string | undefined,
	): Promise<void> {
		await this.guard(id, async () => {
			const settings = this.deps.settings();
			if (!settings.enableFoundryCli) {
				void vscode.window.showWarningMessage(
					'Foundry CLI use is disabled by kvstream.enableFoundryCli.',
				);
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				question,
				{ modal: true, detail },
				confirmLabel,
			);
			if (confirm !== confirmLabel) {
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `foundry server ${verb}…` },
				async () => {
					const result = await run(settings.foundryPath, ['server', verb], { timeoutMs: 120_000 });
					if (result.spawnError) {
						void vscode.window.showErrorMessage(
							`Could not run "${settings.foundryPath}": ${result.spawnError}`,
						);
						return;
					}
					if (result.code === 0) {
						this.deps.logs.note(`foundry server ${verb} completed.`, 'info', 'foundry');
						void vscode.window.showInformationMessage(`Foundry Local ${verb} completed.`);
					} else {
						const message = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
						this.deps.logs.note(`foundry server ${verb} failed: ${message}`, 'error', 'foundry');
						void vscode.window.showErrorMessage(
							`foundry server ${verb} exited with code ${result.code}. ${message}`.trim(),
						);
					}
					this.deps.monitor.refresh();
				},
			);
		});
	}

	/**
	 * `kvstream calibrate`, in a terminal.
	 *
	 * Calibration drives real load through the backend for up to a minute and
	 * writes a budget record, so it belongs somewhere the user can watch it
	 * and press Ctrl+C — not behind a notification spinner. The terminal is
	 * created with an explicit executable and argv, so no shell parses it.
	 */
	async calibrate(): Promise<void> {
		await this.guard('calibrate', async () => {
			const settings = this.deps.settings();
			const confirm = await vscode.window.showWarningMessage(
				'Run `kvstream calibrate`?',
				{
					modal: true,
					detail:
						'Calibration sends a sweep of real requests to Foundry Local to measure the ' +
						'admission budget, and stores the result. It can take a minute or more and will ' +
						'load the backend. It runs in a terminal you can interrupt.',
				},
				'Run calibration',
			);
			if (confirm !== 'Run calibration') {
				return;
			}
			const terminal = vscode.window.createTerminal({
				name: 'kvstream calibrate',
				shellPath: settings.kvstreamPath,
				shellArgs: ['calibrate'],
				cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
			});
			terminal.show();
		});
	}

	private async guard(id: string, body: () => Promise<void>): Promise<void> {
		if (this.inFlight.has(id)) {
			return;
		}
		this.inFlight.add(id);
		this.deps.monitor.setBusy(id, true);
		try {
			await body();
		} catch (error) {
			this.deps.logger.error(`Command ${id} failed`, error);
			void vscode.window.showErrorMessage(
				`KVStream: ${id} failed. See the KVStream Monitor output channel for details.`,
			);
		} finally {
			this.inFlight.delete(id);
			this.deps.monitor.setBusy(id, false);
		}
	}
}

/** `GPU · 2.1 GB · not loaded`, from whatever the CLI reported. */
function describeCachedModel(model: CachedModel): string {
	const parts: string[] = [];
	if (model.device) {
		parts.push(model.device);
	}
	if (model.fileSizeMb !== undefined) {
		parts.push(`${(model.fileSizeMb / 1024).toFixed(1)} GB`);
	}
	if (model.loaded !== undefined) {
		parts.push(model.loaded ? 'loaded' : 'not loaded');
	}
	return parts.join(' · ');
}
