import * as assert from 'assert';
import { isFailure, validateMessage } from '../../webview/messageRouter';

suite('Webview message validation', () => {
	test('accepts a known action with no payload', () => {
		const result = validateMessage({ action: 'refresh' });
		assert.ok(!isFailure(result));
		assert.strictEqual(result.action, 'refresh');
	});

	test('accepts Load model, which takes no payload: the model is chosen in VS Code, not by the page', () => {
		assert.deepStrictEqual(validateMessage({ action: 'loadFoundryModel' }), { action: 'loadFoundryModel' });
		assert.ok(isFailure(validateMessage({ action: 'loadFoundryModel', payload: 'phi-3-mini-4k' })));
	});

	test('rejects anything that is not an object', () => {
		for (const bad of ['refresh', 42, null, undefined, ['refresh']]) {
			assert.ok(isFailure(validateMessage(bad)), `${String(bad)} should be refused`);
		}
	});

	test('rejects an action outside the allowlist', () => {
		assert.ok(isFailure(validateMessage({ action: 'eval' })));
		assert.ok(isFailure(validateMessage({ action: '__proto__' })));
		assert.ok(isFailure(validateMessage({ action: 'constructor' })));
		assert.ok(isFailure(validateMessage({ action: 123 })));
	});

	test('rejects a payload on an action that takes none', () => {
		const result = validateMessage({ action: 'startService', payload: { executable: 'calc.exe' } });
		assert.ok(isFailure(result));
	});

	test('setLogPaused requires a boolean', () => {
		const good = validateMessage({ action: 'setLogPaused', payload: true });
		assert.ok(!isFailure(good));
		assert.deepStrictEqual(good, { action: 'setLogPaused', paused: true });
		assert.ok(isFailure(validateMessage({ action: 'setLogPaused', payload: 'yes' })));
		assert.ok(isFailure(validateMessage({ action: 'setLogPaused' })));
	});

	test('setAutoRefresh requires a boolean', () => {
		const good = validateMessage({ action: 'setAutoRefresh', payload: false });
		assert.deepStrictEqual(good, { action: 'setAutoRefresh', enabled: false });
		assert.ok(isFailure(validateMessage({ action: 'setAutoRefresh', payload: 0 })));
		assert.ok(isFailure(validateMessage({ action: 'setAutoRefresh' })));
	});

	test('navigation actions take no payload', () => {
		for (const action of ['openSettings', 'openLogs', 'openDashboard']) {
			assert.ok(!isFailure(validateMessage({ action })), `${action} should be accepted`);
			assert.ok(isFailure(validateMessage({ action, payload: 'x' })), `${action} with a payload should be refused`);
		}
	});

	test('setLogFilter validates search and levels', () => {
		const good = validateMessage({
			action: 'setLogFilter',
			payload: { search: 'admitted', levels: ['warn', 'error', 'nonsense'] },
		});
		assert.ok(!isFailure(good));
		assert.deepStrictEqual(good, { action: 'setLogFilter', search: 'admitted', levels: ['warn', 'error'] });
	});

	test('setLogFilter refuses an oversized search string', () => {
		const result = validateMessage({ action: 'setLogFilter', payload: { search: 'x'.repeat(201) } });
		assert.ok(isFailure(result));
	});

	test('setLogFilter refuses a non-object payload', () => {
		assert.ok(isFailure(validateMessage({ action: 'setLogFilter', payload: 'abc' })));
		assert.ok(isFailure(validateMessage({ action: 'setLogFilter', payload: { levels: 'warn' } })));
	});
});
