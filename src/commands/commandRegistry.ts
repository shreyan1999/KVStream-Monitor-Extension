import * as vscode from 'vscode';
import type { MonitorActions } from '../views/actions';

/** Command ids, declared once and used by the manifest, menus and the UI. */
export const COMMANDS = {
	openMonitor: 'kvstream-monitor.openMonitor',
	openDashboard: 'kvstream-monitor.openDashboard',
	refresh: 'kvstream-monitor.refresh',
	checkHealth: 'kvstream-monitor.checkHealth',
	configureEndpoint: 'kvstream-monitor.configureEndpoint',
	start: 'kvstream-monitor.start',
	stop: 'kvstream-monitor.stop',
	restart: 'kvstream-monitor.restart',
	startFoundry: 'kvstream-monitor.startFoundry',
	stopFoundry: 'kvstream-monitor.stopFoundry',
	restartFoundry: 'kvstream-monitor.restartFoundry',
	loadFoundryModel: 'kvstream-monitor.loadFoundryModel',
	calibrate: 'kvstream-monitor.calibrate',
	showLogs: 'kvstream-monitor.showLogs',
} as const;

/**
 * Register every command the manifest declares.
 *
 * The two lists must match exactly: a declared command with no handler shows
 * in the palette and fails when run, and a handler with no declaration cannot
 * be reached. `test/extension.test.ts` asserts the correspondence.
 */
export function registerCommands(
	actions: MonitorActions,
	revealSidebar: () => void,
): vscode.Disposable[] {
	const register = (id: string, handler: () => unknown): vscode.Disposable =>
		vscode.commands.registerCommand(id, handler);

	return [
		register(COMMANDS.openMonitor, revealSidebar),
		register(COMMANDS.openDashboard, () => actions.openDashboard()),
		register(COMMANDS.refresh, () => actions.refresh()),
		register(COMMANDS.checkHealth, () => actions.checkHealth()),
		register(COMMANDS.configureEndpoint, () => actions.configureEndpoint()),
		register(COMMANDS.start, () => actions.startService()),
		register(COMMANDS.stop, () => actions.stopService()),
		register(COMMANDS.restart, () => actions.restartService()),
		register(COMMANDS.startFoundry, () => actions.startFoundry()),
		register(COMMANDS.stopFoundry, () => actions.stopFoundry()),
		register(COMMANDS.restartFoundry, () => actions.restartFoundry()),
		register(COMMANDS.loadFoundryModel, () => actions.loadFoundryModel()),
		register(COMMANDS.calibrate, () => actions.calibrate()),
		register(COMMANDS.showLogs, () => actions.openOutput()),
	];
}
