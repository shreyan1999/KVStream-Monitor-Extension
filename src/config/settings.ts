import * as vscode from 'vscode';

export interface ExtensionSettings {
	/** Validated, normalised gateway base URL with no trailing slash. */
	url: string;
	/** `/health` + `/status` poll period, ms. */
	refreshInterval: number;
	/** `/metrics` poll period, ms. */
	metricsRefreshInterval: number;
	/** Per-request timeout, ms. */
	requestTimeout: number;
	/** Retained trend window, ms. */
	historyWindow: number;
	/** Maximum buffered log lines. */
	logBufferSize: number;
	/** Executable used for `kvstream serve`. */
	kvstreamPath: string;
	/** Extra arguments for `kvstream serve`, as an argv array. */
	kvstreamArgs: string[];
	/** Executable used for `foundry ...`. */
	foundryPath: string;
	/** Whether the extension may run the Foundry CLI for discovery. */
	enableFoundryCli: boolean;
}

export interface SettingsIssue {
	key: string;
	message: string;
}

export interface SettingsResult {
	settings: ExtensionSettings;
	issues: SettingsIssue[];
}

const DEFAULTS: ExtensionSettings = {
	url: 'http://127.0.0.1:8080',
	refreshInterval: 2000,
	metricsRefreshInterval: 5000,
	requestTimeout: 3000,
	historyWindow: 60 * 60 * 1000,
	logBufferSize: 2000,
	kvstreamPath: 'kvstream',
	kvstreamArgs: [],
	foundryPath: 'foundry',
	enableFoundryCli: true,
};

/**
 * Accept only the schemes the gateway actually speaks.
 *
 * KVStream has no authentication and binds loopback by default, but it can be
 * put behind a TLS proxy, so https is allowed. Anything else (file:, data:,
 * ws:) is a configuration mistake we refuse rather than fail on later.
 */
export function validateUrl(raw: unknown): { url?: string; error?: string } {
	if (typeof raw !== 'string' || raw.trim() === '') {
		return { error: 'must be a non-empty string' };
	}
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		return { error: `"${String(raw)}" is not a valid URL` };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { error: `scheme "${parsed.protocol.replace(':', '')}" is not supported; use http or https` };
	}
	if (!parsed.hostname) {
		return { error: 'URL has no host' };
	}
	// Keep any base path the user configured (a reverse proxy may mount the
	// gateway under one) but drop the trailing slash so joins stay simple.
	const path = parsed.pathname.replace(/\/+$/, '');
	return { url: `${parsed.protocol}//${parsed.host}${path}` };
}

function clampNumber(
	raw: unknown,
	fallback: number,
	min: number,
	max: number,
	key: string,
	issues: SettingsIssue[],
): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) {
		if (raw !== undefined) {
			issues.push({ key, message: `expected a number, using ${fallback}` });
		}
		return fallback;
	}
	if (raw < min || raw > max) {
		issues.push({ key, message: `must be between ${min} and ${max}, clamped` });
		return Math.min(max, Math.max(min, raw));
	}
	return raw;
}

/**
 * An executable setting is passed to `spawn` with `shell: false`, so it is a
 * path, never a command line. Reject anything carrying shell metacharacters so
 * a stray `kvstream && rm -rf` in settings.json cannot become two commands if
 * this is ever handed to a shell-enabled API.
 */
export function validateExecutable(raw: unknown, fallback: string): { value: string; error?: string } {
	if (raw === undefined || raw === null || raw === '') {
		return { value: fallback };
	}
	if (typeof raw !== 'string') {
		return { value: fallback, error: 'expected a string path' };
	}
	const value = raw.trim();
	if (value === '') {
		return { value: fallback };
	}
	if (/[&|;<>`$\n\r"']/.test(value)) {
		return { value: fallback, error: 'path contains shell metacharacters and was ignored' };
	}
	return { value };
}

function validateArgs(raw: unknown, issues: SettingsIssue[], key: string): string[] {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!Array.isArray(raw)) {
		issues.push({ key, message: 'expected an array of strings, ignored' });
		return [];
	}
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== 'string') {
			issues.push({ key, message: 'non-string entry ignored' });
			continue;
		}
		out.push(item);
	}
	return out;
}

/** Read and validate the `kvstream.*` configuration section. */
export function readSettings(
	scope?: vscode.ConfigurationScope,
	configuration?: vscode.WorkspaceConfiguration,
): SettingsResult {
	const cfg = configuration ?? vscode.workspace.getConfiguration('kvstream', scope);
	const issues: SettingsIssue[] = [];

	const urlCheck = validateUrl(cfg.get('url', DEFAULTS.url));
	if (urlCheck.error) {
		issues.push({ key: 'kvstream.url', message: urlCheck.error });
	}

	const kvExec = validateExecutable(cfg.get('kvstreamPath'), DEFAULTS.kvstreamPath);
	if (kvExec.error) {
		issues.push({ key: 'kvstream.kvstreamPath', message: kvExec.error });
	}
	const foundryExec = validateExecutable(cfg.get('foundryPath'), DEFAULTS.foundryPath);
	if (foundryExec.error) {
		issues.push({ key: 'kvstream.foundryPath', message: foundryExec.error });
	}

	const refreshInterval = clampNumber(
		cfg.get('refreshInterval'), DEFAULTS.refreshInterval, 500, 300000, 'kvstream.refreshInterval', issues);
	const metricsRefreshInterval = clampNumber(
		cfg.get('metricsRefreshInterval'), DEFAULTS.metricsRefreshInterval, 1000, 600000,
		'kvstream.metricsRefreshInterval', issues);
	const requestTimeout = clampNumber(
		cfg.get('requestTimeout'), DEFAULTS.requestTimeout, 250, 60000, 'kvstream.requestTimeout', issues);

	const settings: ExtensionSettings = {
		url: urlCheck.url ?? DEFAULTS.url,
		refreshInterval,
		metricsRefreshInterval,
		requestTimeout,
		historyWindow: clampNumber(
			cfg.get('historyWindow'), DEFAULTS.historyWindow, 60000, 3600000, 'kvstream.historyWindow', issues),
		logBufferSize: clampNumber(
			cfg.get('logBufferSize'), DEFAULTS.logBufferSize, 100, 20000, 'kvstream.logBufferSize', issues),
		kvstreamPath: kvExec.value,
		kvstreamArgs: validateArgs(cfg.get('kvstreamArgs'), issues, 'kvstream.kvstreamArgs'),
		foundryPath: foundryExec.value,
		enableFoundryCli: cfg.get('enableFoundryCli', DEFAULTS.enableFoundryCli) !== false,
	};

	return { settings, issues };
}

export const SETTINGS_DEFAULTS = DEFAULTS;
