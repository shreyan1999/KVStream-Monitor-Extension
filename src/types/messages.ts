/**
 * The webview <-> extension-host protocol.
 *
 * Everything crossing the boundary is validated by `webview/messageRouter.ts`
 * against the action allowlist below; nothing else is acted upon.
 */

import type { ViewModel } from './viewModel';

/** Actions a webview may ask the host to perform. */
export const WEBVIEW_ACTIONS = [
	'ready',
	'refresh',
	'checkHealth',
	'configureEndpoint',
	'openDashboard',
	'openOutput',
	'openSettings',
	'openLogs',
	'setAutoRefresh',
	'startService',
	'stopService',
	'restartService',
	'startFoundry',
	'stopFoundry',
	'restartFoundry',
	'loadFoundryModel',
	'calibrate',
	'clearLogs',
	'setLogPaused',
	'setLogFilter',
] as const;

export type WebviewAction = (typeof WEBVIEW_ACTIONS)[number];

export interface WebviewMessage {
	action: WebviewAction;
	/** Optional scalar payload; shapes are checked per action by the router. */
	payload?: unknown;
}

export type HostMessage =
	| { type: 'state'; state: ViewModel }
	| { type: 'logs'; entries: LogEntryDTO[]; append: boolean; truncated: boolean }
	| { type: 'busy'; operations: string[] }
	/** Scroll a section into view, e.g. after "Open Logs" from the sidebar. */
	| { type: 'focus'; section: 'logs' };

export interface LogEntryDTO {
	/** Epoch milliseconds. */
	t: number;
	level: LogLevel;
	message: string;
	source: string;
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
