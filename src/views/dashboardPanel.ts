import * as vscode from 'vscode';
import type { MonitorService } from '../monitoring/monitorService';
import type { LogService } from '../services/logService';
import type { Logger } from '../logging';
import type { MonitorActions } from './actions';
import { WebviewHost } from './webviewHost';

/**
 * The expanded dashboard, in an editor tab.
 *
 * A single instance: a second "Open Dashboard" reveals the existing tab
 * rather than opening a duplicate that would render the same state twice.
 */
export class DashboardPanel implements vscode.Disposable {
	private static readonly viewType = 'kvstream.dashboard';
	private static current?: DashboardPanel;

	private readonly panel: vscode.WebviewPanel;
	private readonly host: WebviewHost;

	private constructor(
		extensionUri: vscode.Uri,
		monitor: MonitorService,
		logs: LogService,
		actions: MonitorActions,
		logger: Logger,
	) {
		this.panel = vscode.window.createWebviewPanel(
			DashboardPanel.viewType,
			'KVStream Monitor',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				// Keeping the DOM alive across tab switches avoids re-running the
				// boot sequence and losing the chart history the view has drawn.
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(extensionUri, 'media'),
					vscode.Uri.joinPath(extensionUri, 'resources'),
				],
			},
		);
		this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'kvstream.svg');

		this.host = new WebviewHost(
			this.panel.webview,
			extensionUri,
			'dashboard',
			monitor,
			logs,
			actions,
			logger,
		);

		this.panel.onDidChangeViewState(() => this.host.setActive(this.panel.visible));
		this.panel.onDidDispose(() => this.dispose());
		this.host.setActive(true);
	}

	static show(
		extensionUri: vscode.Uri,
		monitor: MonitorService,
		logs: LogService,
		actions: MonitorActions,
		logger: Logger,
	): DashboardPanel {
		if (DashboardPanel.current) {
			DashboardPanel.current.panel.reveal();
			return DashboardPanel.current;
		}
		DashboardPanel.current = new DashboardPanel(extensionUri, monitor, logs, actions, logger);
		return DashboardPanel.current;
	}

	focus(section: 'logs'): void {
		this.host.focus(section);
	}

	/** Deliver a message as if this panel's page had posted it. */
	receive(message: unknown): void {
		this.host.receive(message);
	}

	static disposeCurrent(): void {
		DashboardPanel.current?.dispose();
	}

	dispose(): void {
		if (DashboardPanel.current === this) {
			DashboardPanel.current = undefined;
		}
		this.host.dispose();
		this.panel.dispose();
	}
}
