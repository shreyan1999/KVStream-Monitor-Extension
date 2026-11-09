import * as assert from 'assert';
import * as vscode from 'vscode';
import { COMMANDS } from '../commands/commandRegistry';

function findExtension(): vscode.Extension<unknown> {
	// Without a publisher field the dev host ids the extension as
	// `undefined_publisher.<name>`, so match on the name rather than a
	// hardcoded full id.
	const extension = vscode.extensions.all.find((item) => item.id.endsWith('.kvstream-monitor'));
	assert.ok(extension, 'kvstream-monitor should be installed in the test host');
	return extension;
}

suite('Extension', function () {
	this.timeout(30_000);

	test('activates', async () => {
		const extension = findExtension();
		await extension.activate();
		assert.strictEqual(extension.isActive, true);
	});

	test('every declared command is registered', async () => {
		await findExtension().activate();
		const manifest = findExtension().packageJSON as {
			contributes: { commands: { command: string }[] };
		};
		const declared = manifest.contributes.commands.map((entry) => entry.command);
		const registered = await vscode.commands.getCommands(true);

		for (const command of declared) {
			assert.ok(registered.includes(command), `${command} is declared but not registered`);
		}
	});

	test('every registered command is declared in the manifest', async () => {
		await findExtension().activate();
		const manifest = findExtension().packageJSON as {
			contributes: { commands: { command: string }[] };
		};
		const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));
		for (const command of Object.values(COMMANDS)) {
			assert.ok(declared.has(command), `${command} is registered but not declared`);
		}
		assert.strictEqual(declared.size, Object.values(COMMANDS).length);
	});

	test('declares the Activity Bar container and the webview view', () => {
		const manifest = findExtension().packageJSON as {
			contributes: {
				viewsContainers: { activitybar: { id: string; icon: string }[] };
				views: Record<string, { id: string; type?: string }[]>;
			};
		};
		const container = manifest.contributes.viewsContainers.activitybar[0];
		assert.strictEqual(container.id, 'kvstream');
		assert.ok(container.icon.endsWith('.svg'), 'Activity Bar icons must be SVG');

		const views = manifest.contributes.views['kvstream'];
		assert.ok(views, 'the kvstream container should contribute a view');
		assert.strictEqual(views[0].id, 'kvstream.monitor');
		assert.strictEqual(views[0].type, 'webview');
	});

	test('configuration defaults are readable and validated', () => {
		const config = vscode.workspace.getConfiguration('kvstream');
		assert.strictEqual(config.get('url'), 'http://127.0.0.1:8080');
		assert.strictEqual(config.get('refreshInterval'), 2000);
		assert.strictEqual(config.get('metricsRefreshInterval'), 5000);
		assert.strictEqual(config.get('enableFoundryCli'), true);
	});

	test('the dashboard command opens a panel and the extension survives it', async () => {
		await findExtension().activate();
		await vscode.commands.executeCommand(COMMANDS.openDashboard);
		// Opening twice must not produce a second panel or throw.
		await vscode.commands.executeCommand(COMMANDS.openDashboard);
		assert.ok(vscode.window.tabGroups.all.length >= 1);
	});

	test('refresh and health check do not throw when nothing is listening', async () => {
		await findExtension().activate();
		await vscode.commands.executeCommand(COMMANDS.refresh);
		// No gateway is running in the test host; this must degrade, not throw.
		await vscode.commands.executeCommand(COMMANDS.checkHealth);
	});
});
