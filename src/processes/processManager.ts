import * as vscode from 'vscode';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

/** `stdio: ['ignore', 'pipe', 'pipe']` — no stdin, both output streams piped. */
type GatewayProcess = ChildProcessByStdio<null, Readable, Readable>;
import type { ProcessInfo } from '../types/viewModel';
import type { LogService } from '../services/logService';
import type { Logger } from '../logging';

export interface StartOptions {
	executable: string;
	args: string[];
	cwd?: string;
}

export interface OperationResult {
	ok: boolean;
	detail: string;
}

/**
 * Lifecycle of the one `kvstream serve` process this extension may own.
 *
 * The rules this enforces, in order of how much damage they prevent:
 *
 *  - **Only our own process is ever signalled.** KVStream has no `stop` or
 *    `restart` subcommand — the CLI is `serve | health | status | calibrate |
 *    bench` — so stopping it means terminating a pid. Terminating a pid we did
 *    not start, chosen because its command line looked right, could kill
 *    anything; the extension refuses and says why instead.
 *  - **No shell.** `spawn` with an argv array and `shell: false`, so a
 *    configured path or argument cannot become a second command.
 *  - **One at a time.** A second start while one is running or starting is
 *    refused rather than queued, so a double click cannot bind two gateways
 *    to the same port (KVStream also refuses to run more than one process
 *    against the same admission state).
 *
 * Ownership policy, which the UI states before starting: a gateway this
 * extension started is stopped when the extension deactivates. There is no
 * other way to stop it — nothing else knows the pid — so leaving it running
 * would strand a process the user cannot address.
 */
export class ProcessManager implements vscode.Disposable {
	private child?: GatewayProcess;
	private info: ProcessInfo = { ownedByExtension: false, state: 'none' };
	private readonly emitter = new vscode.EventEmitter<ProcessInfo>();

	readonly onDidChange = this.emitter.event;

	constructor(
		private readonly logs: LogService,
		private readonly logger: Logger,
	) {}

	get state(): ProcessInfo {
		return { ...this.info };
	}

	get isOwned(): boolean {
		return this.child !== undefined && this.info.state === 'running';
	}

	private set(next: Partial<ProcessInfo>): void {
		this.info = { ...this.info, ...next };
		this.emitter.fire(this.state);
	}

	async start(options: StartOptions): Promise<OperationResult> {
		if (this.info.state === 'running' || this.info.state === 'starting') {
			return { ok: false, detail: 'A gateway started by this extension is already running.' };
		}

		const args = ['serve', ...options.args];
		this.set({ ownedByExtension: true, state: 'starting', exitDetail: undefined, pid: undefined });
		this.logs.note(`Starting: ${options.executable} ${args.join(' ')}`, 'info', 'extension');

		let child: GatewayProcess;
		try {
			child = spawn(options.executable, args, {
				shell: false,
				cwd: options.cwd,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
				// KVStream widens stdout/stderr to UTF-8 itself, but only once it
				// is running; forcing it here keeps the first lines readable too.
				env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.set({ ownedByExtension: false, state: 'exited', exitDetail: detail });
			return { ok: false, detail: `Could not start "${options.executable}": ${detail}` };
		}

		this.child = child;

		child.stdout.on('data', (chunk: Buffer) => this.logs.ingest(chunk.toString('utf8'), 'kvstream'));
		child.stderr.on('data', (chunk: Buffer) => this.logs.ingest(chunk.toString('utf8'), 'kvstream'));

		return await new Promise<OperationResult>((resolve) => {
			let settled = false;
			const settle = (result: OperationResult): void => {
				if (!settled) {
					settled = true;
					resolve(result);
				}
			};

			child.on('error', (error) => {
				// ENOENT arrives here, not from spawn(), because spawn is async.
				this.child = undefined;
				this.logs.flush('kvstream');
				this.logs.note(`Failed to start KVStream: ${error.message}`, 'error', 'extension');
				this.set({ ownedByExtension: false, state: 'exited', exitDetail: error.message, pid: undefined });
				settle({
					ok: false,
					detail:
						`Could not start "${options.executable}": ${error.message}. ` +
						'Install KVStream (`pip install -e .` from the repository) or set kvstream.kvstreamPath.',
				});
			});

			child.on('exit', (code, signal) => {
				const detail = signal ? `terminated by ${signal}` : `exited with code ${code ?? 'unknown'}`;
				this.child = undefined;
				this.logs.flush('kvstream');
				this.logs.note(`KVStream process ${detail}.`, code === 0 || signal ? 'info' : 'error', 'extension');
				this.logger.info(`kvstream serve ${detail}`);
				this.set({ ownedByExtension: false, state: 'exited', exitDetail: detail, pid: undefined, startedAt: undefined });
				// An exit before the grace period is a start failure, not a stop.
				settle({ ok: false, detail: `KVStream ${detail}. See the log panel for output.` });
			});

			// There is no "started" signal to wait for: the process is up when it
			// has not died immediately. Readiness is the monitor's job, and it
			// reports it from /health rather than from the process being alive.
			setTimeout(() => {
				if (this.child === child) {
					this.set({ state: 'running', pid: child.pid, ownedByExtension: true, startedAt: Date.now() });
					settle({ ok: true, detail: `KVStream started (pid ${child.pid ?? 'unknown'}).` });
				}
			}, 700);
		});
	}

	async stop(): Promise<OperationResult> {
		const child = this.child;
		if (!child) {
			return {
				ok: false,
				detail:
					'This extension did not start the running gateway, so it cannot stop it. ' +
					'KVStream has no stop command; stop the process where it was started (Ctrl+C).',
			};
		}
		this.set({ state: 'stopping' });
		this.logs.note('Stopping the KVStream process started by this extension.', 'info', 'extension');

		const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
		// On POSIX this is the graceful path: KVStream turns away queued
		// requests on SIGTERM and gives in-flight ones drain_timeout_seconds.
		// Node on Windows has no SIGTERM to deliver — kill() calls
		// TerminateProcess — so there the shutdown is abrupt and in-flight
		// requests are cut off. That difference is documented, not papered over.
		child.kill('SIGTERM');

		const timedOut = await Promise.race([
			exited.then(() => false),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 8000)),
		]);

		if (timedOut && this.child) {
			this.logs.note('Process did not exit within 8s; forcing termination.', 'warn', 'extension');
			child.kill('SIGKILL');
			await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
		}

		this.child = undefined;
		this.set({ ownedByExtension: false, state: 'exited', pid: undefined, startedAt: undefined });
		return { ok: true, detail: 'KVStream stopped.' };
	}

	async restart(options: StartOptions): Promise<OperationResult> {
		if (!this.child) {
			return {
				ok: false,
				detail:
					'This extension did not start the running gateway, so it cannot restart it. ' +
					'Start one from here first, or restart it where it was started.',
			};
		}
		const stopped = await this.stop();
		if (!stopped.ok) {
			return stopped;
		}
		return await this.start(options);
	}

	/**
	 * Stop an owned process on deactivation.
	 *
	 * Fire-and-forget: VS Code does not wait indefinitely for `deactivate`, and
	 * an orphaned gateway is worse than an abrupt one — nothing else knows its
	 * pid, so the user would have no way to stop it.
	 */
	dispose(): void {
		const child = this.child;
		this.child = undefined;
		if (child) {
			try {
				child.kill('SIGTERM');
			} catch {
				// Already gone. Nothing to clean up.
			}
		}
		this.emitter.dispose();
	}
}
