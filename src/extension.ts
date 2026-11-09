import * as vscode from 'vscode';
import { COMMANDS, registerCommands } from './commands/commandRegistry';
import { ServiceCommands } from './commands/serviceCommands';
import { readSettings, type ExtensionSettings } from './config/settings';
import { Logger } from './logging';
import { MonitorService } from './monitoring/monitorService';
import { ProcessManager } from './processes/processManager';
import { LogService } from './services/logService';
import { DashboardPanel } from './views/dashboardPanel';
import { MonitorViewProvider } from './views/monitorView';
import { StatusBarIndicator } from './views/statusBar';

let processes: ProcessManager | undefined;

/**
 * Returned from `activate` only under the test runner (`ExtensionMode.Test`);
 * an installed extension exposes nothing.
 */
export interface TestApi {
	monitor: MonitorService;
	logs: LogService;
	/** Open the dashboard and deliver `message` as if its page had posted it. */
	postFromDashboard(message: unknown): void;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
	const logger = new Logger();
	context.subscriptions.push(logger);

	const initial = readSettings();
	let settings: ExtensionSettings = initial.settings;
	reportIssues(initial.issues, logger);

	const logs = new LogService(settings.logBufferSize);
	processes = new ProcessManager(logs, logger);
	const monitor = new MonitorService(settings, processes, logger);
	context.subscriptions.push(logs, processes, monitor);

	const actions = new ServiceCommands({
		monitor,
		processes,
		logs,
		logger,
		settings: () => settings,
		openDashboard: () =>
			DashboardPanel.show(context.extensionUri, monitor, logs, actions, logger),
		openLogs: () =>
			DashboardPanel.show(context.extensionUri, monitor, logs, actions, logger).focus('logs'),
	});

	const sidebar = new MonitorViewProvider(context.extensionUri, monitor, logs, actions, logger);
	context.subscriptions.push(
		sidebar,
		vscode.window.registerWebviewViewProvider(MonitorViewProvider.viewType, sidebar, {
			// The sidebar is cheap to rebuild and polling stops when it hides,
			// so there is nothing worth retaining while it is not visible.
			webviewOptions: { retainContextWhenHidden: false },
		}),
	);

	const statusBar = new StatusBarIndicator(COMMANDS.openDashboard);
	context.subscriptions.push(statusBar);
	statusBar.update(monitor.state);
	context.subscriptions.push(monitor.onDidChange((state) => statusBar.update(state)));

	context.subscriptions.push(
		...registerCommands(actions, () => {
			void vscode.commands.executeCommand('workbench.view.extension.kvstream');
		}),
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration('kvstream')) {
				return;
			}
			const next = readSettings();
			reportIssues(next.issues, logger);
			settings = next.settings;
			logs.setCapacity(settings.logBufferSize);
			monitor.applySettings(settings);
		}),
	);

	// The Status Bar must say something before any view is opened, so take one
	// sample at activation rather than waiting for a subscriber.
	monitor.refresh();
	logger.info(`KVStream Monitor active. Gateway: ${settings.url}`);

	if (context.extensionMode !== vscode.ExtensionMode.Test) {
		return undefined;
	}
	return {
		monitor,
		logs,
		postFromDashboard: (message) =>
			DashboardPanel.show(context.extensionUri, monitor, logs, actions, logger).receive(message),
	};
}

function reportIssues(issues: { key: string; message: string }[], logger: Logger): void {
	for (const issue of issues) {
		logger.warn(`${issue.key}: ${issue.message}`);
	}
	if (issues.length > 0) {
		void vscode.window.showWarningMessage(
			`KVStream Monitor: ${issues.length} setting(s) were invalid and defaults were used. ` +
				'See the KVStream Monitor output channel.',
		);
	}
}

/**
 * Stop a gateway this extension started.
 *
 * Ownership policy, stated in the start confirmation: nothing else knows the
 * pid of a process spawned here, and KVStream has no stop command, so leaving
 * it running would strand a process the user cannot address. A gateway
 * started anywhere else is untouched — this only ever signals its own child.
 */
export function deactivate(): void {
	processes?.dispose();
	processes = undefined;
	DashboardPanel.disposeCurrent();
}
