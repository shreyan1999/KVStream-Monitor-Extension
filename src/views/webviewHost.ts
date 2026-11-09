import * as vscode from 'vscode';
import type { MonitorService } from '../monitoring/monitorService';
import type { LogService } from '../services/logService';
import type { Logger } from '../logging';
import type { HostMessage, LogEntryDTO } from '../types/messages';
import { isFailure, validateMessage } from '../webview/messageRouter';
import { renderHtml, type ViewMode } from '../webview/html';
import type { MonitorActions } from './actions';

/**
 * Wiring shared by the sidebar view and the dashboard panel.
 *
 * Holds the subscription lifecycle (so a hidden view stops costing requests),
 * the message loop, and log streaming. Both views render the same document
 * and the same state; only `mode` differs, and the stylesheet keys its layout
 * off that.
 */
export class WebviewHost implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private monitorSubscription?: vscode.Disposable;
	private ready = false;
	private logsPaused = false;
	private disposed = false;

	constructor(
		private readonly webview: vscode.Webview,
		private readonly extensionUri: vscode.Uri,
		private readonly mode: ViewMode,
		private readonly monitor: MonitorService,
		private readonly logs: LogService,
		private readonly actions: MonitorActions,
		private readonly logger: Logger,
	) {
		this.webview.options = {
			enableScripts: true,
			// The webview may only read from the two asset folders it needs.
			localResourceRoots: [
				vscode.Uri.joinPath(extensionUri, 'media'),
				vscode.Uri.joinPath(extensionUri, 'resources'),
			],
		};
		this.webview.html = renderHtml(this.webview, this.extensionUri, this.mode);

		this.disposables.push(
			this.webview.onDidReceiveMessage((raw) => this.receive(raw)),
			this.monitor.onDidChange((state) => this.post({ type: 'state', state })),
			this.logs.onDidAppend((entries) => this.handleLogs(entries)),
		);
	}

	/** Called by the owning view when it becomes visible or hidden. */
	setActive(active: boolean): void {
		if (this.disposed) {
			return;
		}
		if (active && !this.monitorSubscription) {
			this.monitorSubscription = this.monitor.subscribe();
			this.post({ type: 'state', state: this.monitor.state });
			this.sendLogSnapshot();
		} else if (!active && this.monitorSubscription) {
			this.monitorSubscription.dispose();
			this.monitorSubscription = undefined;
		}
	}

	/** The sidebar is a menu with a status word; only the dashboard shows logs. */
	private get showsLogs(): boolean {
		return this.mode === 'dashboard';
	}

	private handleLogs(entries: LogEntryDTO[]): void {
		if (!this.ready || this.logsPaused || !this.showsLogs) {
			return;
		}
		if (entries.length === 0) {
			// An empty append is the signal that the buffer was cleared.
			this.sendLogSnapshot();
			return;
		}
		this.post({ type: 'logs', entries, append: true, truncated: false });
	}

	private sendLogSnapshot(): void {
		if (!this.showsLogs) {
			return;
		}
		const snapshot = this.logs.snapshot();
		this.post({
			type: 'logs',
			entries: snapshot.entries,
			append: false,
			truncated: snapshot.truncated,
		});
	}

	/** Ask the page to scroll a section into view. */
	focus(section: 'logs'): void {
		this.pendingFocus = section;
		if (this.ready) {
			this.post({ type: 'focus', section });
			this.pendingFocus = undefined;
		}
	}

	/** A focus requested before the page booted is delivered on `ready`. */
	private pendingFocus?: 'logs';

	private post(message: HostMessage): void {
		if (this.disposed || !this.ready) {
			return;
		}
		// A webview disposed between the state change and this call rejects the
		// post; that is expected, not an error worth reporting.
		void this.webview.postMessage(message).then(undefined, () => undefined);
	}

	/**
	 * Handle one message posted by the page. Public so the live end-to-end
	 * test can deliver exactly what a button click posts, through the same
	 * validation and dispatch.
	 */
	receive(raw: unknown): void {
		if (this.disposed) {
			return;
		}
		const result = validateMessage(raw);
		if (isFailure(result)) {
			this.logger.warn(`Ignored a webview message: ${result.error}`);
			return;
		}

		switch (result.action) {
			case 'ready':
				this.ready = true;
				this.post({ type: 'state', state: this.monitor.state });
				this.sendLogSnapshot();
				if (this.pendingFocus) {
					this.post({ type: 'focus', section: this.pendingFocus });
					this.pendingFocus = undefined;
				}
				return;
			case 'refresh':
				this.actions.refresh();
				return;
			case 'checkHealth':
				void this.actions.checkHealth();
				return;
			case 'configureEndpoint':
				void this.actions.configureEndpoint();
				return;
			case 'openDashboard':
				this.actions.openDashboard();
				return;
			case 'openOutput':
				this.actions.openOutput();
				return;
			case 'openSettings':
				this.actions.openSettings();
				return;
			case 'openLogs':
				this.actions.openLogs();
				return;
			case 'setAutoRefresh':
				this.actions.setAutoRefresh(result.enabled);
				return;
			case 'startService':
				void this.actions.startService();
				return;
			case 'stopService':
				void this.actions.stopService();
				return;
			case 'restartService':
				void this.actions.restartService();
				return;
			case 'startFoundry':
				void this.actions.startFoundry();
				return;
			case 'stopFoundry':
				void this.actions.stopFoundry();
				return;
			case 'restartFoundry':
				void this.actions.restartFoundry();
				return;
			case 'loadFoundryModel':
				void this.actions.loadFoundryModel();
				return;
			case 'calibrate':
				void this.actions.calibrate();
				return;
			case 'clearLogs':
				this.logs.clear();
				return;
			case 'setLogPaused':
				this.logsPaused = result.paused;
				if (!result.paused) {
					this.sendLogSnapshot();
				}
				return;
			case 'setLogFilter':
				// Filtering is presentation and stays in the webview; the host
				// validates the message so an out-of-range payload cannot reach
				// anything, and otherwise has nothing to do with it.
				return;
			default: {
				// Exhaustiveness: a new action must be handled here to compile.
				const unhandled: never = result;
				this.logger.warn(`Unhandled webview action: ${JSON.stringify(unhandled)}`);
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.monitorSubscription?.dispose();
		this.monitorSubscription = undefined;
		for (const item of this.disposables) {
			item.dispose();
		}
		this.disposables.length = 0;
	}
}
