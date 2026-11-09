import * as assert from 'assert';
import type * as vscode from 'vscode';
import { readSettings, validateExecutable, validateUrl } from '../../config/settings';

/** A stand-in for `WorkspaceConfiguration` holding a plain object. */
function fakeConfig(values: Record<string, unknown>): vscode.WorkspaceConfiguration {
	return {
		get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
		has: (key: string) => key in values,
		inspect: () => undefined,
		update: async () => undefined,
	} as unknown as vscode.WorkspaceConfiguration;
}

suite('URL validation', () => {
	test('accepts http and https and strips the trailing slash', () => {
		assert.strictEqual(validateUrl('http://127.0.0.1:8080/').url, 'http://127.0.0.1:8080');
		assert.strictEqual(validateUrl('https://gw.example:443').url, 'https://gw.example');
	});

	test('keeps a base path a reverse proxy may need', () => {
		assert.strictEqual(validateUrl('http://host:8080/kvstream/').url, 'http://host:8080/kvstream');
	});

	test('rejects unsupported schemes', () => {
		assert.ok(validateUrl('file:///etc/passwd').error);
		assert.ok(validateUrl('ws://127.0.0.1:8080').error);
		assert.ok(validateUrl('javascript:alert(1)').error);
	});

	test('rejects malformed input', () => {
		assert.ok(validateUrl('not a url').error);
		assert.ok(validateUrl('').error);
		assert.ok(validateUrl(undefined).error);
		assert.ok(validateUrl(8080).error);
	});
});

suite('Executable validation', () => {
	test('accepts a plain path', () => {
		assert.strictEqual(validateExecutable('kvstream', 'kvstream').value, 'kvstream');
		assert.strictEqual(
			validateExecutable('C:/tools/kvstream.exe', 'kvstream').value,
			'C:/tools/kvstream.exe',
		);
	});

	test('refuses anything that looks like a command line', () => {
		for (const bad of ['kvstream && calc', 'kvstream; rm -rf /', 'kv`whoami`', 'kv $(id)', 'kv | tee']) {
			const result = validateExecutable(bad, 'kvstream');
			assert.ok(result.error, `${bad} should be refused`);
			assert.strictEqual(result.value, 'kvstream', 'falls back to the default');
		}
	});

	test('falls back for empty and non-string values', () => {
		assert.strictEqual(validateExecutable('', 'foundry').value, 'foundry');
		assert.strictEqual(validateExecutable(undefined, 'foundry').value, 'foundry');
		assert.ok(validateExecutable(7, 'foundry').error);
	});
});

suite('Settings reader', () => {
	test('clamps out-of-range intervals and reports the issue', () => {
		const result = readSettings(undefined, fakeConfig({ refreshInterval: 1, requestTimeout: 999_999 }));
		assert.strictEqual(result.settings.refreshInterval, 500);
		assert.strictEqual(result.settings.requestTimeout, 60_000);
		assert.strictEqual(result.issues.length, 2);
	});

	test('a bad URL falls back to the default and is reported', () => {
		const result = readSettings(undefined, fakeConfig({ url: 'ftp://nope' }));
		assert.strictEqual(result.settings.url, 'http://127.0.0.1:8080');
		assert.ok(result.issues.some((issue) => issue.key === 'kvstream.url'));
	});

	test('arguments must be an array of strings', () => {
		const result = readSettings(undefined, fakeConfig({ kvstreamArgs: ['--mode', 'tokens', 7] }));
		assert.deepStrictEqual(result.settings.kvstreamArgs, ['--mode', 'tokens']);
		assert.ok(result.issues.some((issue) => issue.key === 'kvstream.kvstreamArgs'));

		const notArray = readSettings(undefined, fakeConfig({ kvstreamArgs: '--mode tokens' }));
		assert.deepStrictEqual(notArray.settings.kvstreamArgs, []);
	});

	test('defaults are used when nothing is configured', () => {
		const result = readSettings(undefined, fakeConfig({}));
		assert.strictEqual(result.issues.length, 0);
		assert.strictEqual(result.settings.url, 'http://127.0.0.1:8080');
		assert.strictEqual(result.settings.refreshInterval, 2000);
		assert.strictEqual(result.settings.metricsRefreshInterval, 5000);
		assert.strictEqual(result.settings.enableFoundryCli, true);
	});
});
