import * as vscode from 'vscode';
import type { ViewModel } from '../types/viewModel';

/**
 * The Status Bar indicator.
 *
 * Shows counts only when the gateway actually reported them. A disconnected
 * gateway shows "disconnected", never "0 running · 0 queued", which would
 * read as a healthy idle service.
 *
 * The text is only assigned when it changes: the fast poll fires every couple
 * of seconds, and reassigning an identical string makes the item flicker in
 * some themes.
 */
export class StatusBarIndicator implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private lastText = '';
	private lastTooltip = '';

	constructor(openCommand: string) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = openCommand;
		this.item.name = 'KVStream Monitor';
		this.item.text = '$(pulse) KVStream: starting…';
		this.item.show();
	}

	update(state: ViewModel): void {
		const { text, tooltip, warn } = describe(state);
		if (text !== this.lastText) {
			this.item.text = text;
			this.lastText = text;
		}
		if (tooltip !== this.lastTooltip) {
			this.item.tooltip = tooltip;
			this.lastTooltip = tooltip;
		}
		this.item.backgroundColor = warn
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: undefined;
	}

	dispose(): void {
		this.item.dispose();
	}
}

export function describe(state: ViewModel): { text: string; tooltip: string; warn: boolean } {
	const url = state.connection.gatewayUrl;
	switch (state.service) {
		case 'loading':
			return { text: '$(sync~spin) KVStream: connecting…', tooltip: `Connecting to ${url}`, warn: false };
		case 'starting':
			return { text: '$(sync~spin) KVStream: starting…', tooltip: `Starting KVStream at ${url}`, warn: false };
		case 'disconnected':
		case 'stopped':
			return {
				text: '$(debug-disconnect) KVStream: disconnected',
				tooltip: `No gateway answering at ${url}`,
				warn: false,
			};
		case 'error':
			return {
				text: '$(warning) KVStream: error',
				tooltip: state.errors[0]?.message ?? `Error talking to ${url}`,
				warn: true,
			};
		case 'unknown':
			return { text: '$(circle-outline) KVStream: unknown', tooltip: `No data from ${url}`, warn: false };
		default:
			break;
	}

	const running = state.requests.running.value;
	const queued = state.requests.queued.value;
	const parts: string[] = [];
	if (running !== undefined) {
		parts.push(`${running} running`);
	}
	if (queued !== undefined) {
		parts.push(`${queued} queued`);
	}

	const icon = state.service === 'healthy' ? '$(pulse)' : '$(warning)';
	const label = parts.length > 0 ? parts.join(' · ') : state.service;
	const staleSuffix = state.stale ? ' (stale)' : '';

	return {
		text: `${icon} KVStream: ${label}${staleSuffix}`,
		tooltip:
			state.service === 'healthy'
				? `KVStream is serving at ${url}`
				: `KVStream is up at ${url} but the backend is not serving`,
		warn: state.service === 'degraded',
	};
}
