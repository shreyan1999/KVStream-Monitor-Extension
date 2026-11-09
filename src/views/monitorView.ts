import * as vscode from 'vscode';
import type { MonitorService } from '../monitoring/monitorService';
import type { LogService } from '../services/logService';
import type { Logger } from '../logging';
import type { MonitorActions } from './actions';
import { WebviewHost } from './webviewHost';

/** The Activity Bar sidebar view. */
export class MonitorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = 'kvstream.monitor';

	private host?: WebviewHost;
	private view?: vscode.WebviewView;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly monitor: MonitorService,
		private readonly logs: LogService,
		private readonly actions: MonitorActions,
		private readonly logger: Logger,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		this.host?.dispose();
		this.host = new WebviewHost(
			view.webview,
			this.extensionUri,
			'sidebar',
			this.monitor,
			this.logs,
			this.actions,
			this.logger,
		);

		// VS Code tears the webview down when the view is collapsed or hidden
		// in the background; polling follows visibility so a hidden sidebar
		// costs nothing.
		view.onDidChangeVisibility(() => this.host?.setActive(view.visible));
		view.onDidDispose(() => {
			this.host?.dispose();
			this.host = undefined;
			this.view = undefined;
		});

		this.host.setActive(view.visible);
	}

	reveal(): void {
		this.view?.show?.(true);
	}

	dispose(): void {
		this.host?.dispose();
		this.host = undefined;
	}
}
