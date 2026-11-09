import * as assert from 'assert';
import { detectLevel, LogService } from '../../services/logService';

suite('Log level detection', () => {
	test('reads the level token from a line', () => {
		assert.strictEqual(detectLevel('2026-10-27 16:42:18 INFO     Request admitted'), 'info');
		assert.strictEqual(detectLevel('WARNING: queue depth increased'), 'warn');
		assert.strictEqual(detectLevel('kvstream.app ERROR backend failure'), 'error');
		assert.strictEqual(detectLevel('DEBUG estimator sample'), 'debug');
		assert.strictEqual(detectLevel('CRITICAL out of memory'), 'error');
	});

	test('a stack trace is an error even without a level token', () => {
		assert.strictEqual(detectLevel('Traceback (most recent call last):'), 'error');
	});

	test('an unlabelled line is info, not error', () => {
		// uvicorn writes ordinary startup lines to stderr; treating the stream
		// as the severity would mark a healthy start as a failure.
		assert.strictEqual(detectLevel('Uvicorn running on http://127.0.0.1:8080'), 'info');
	});
});

suite('Log buffer', () => {
	test('splits chunks on newlines and holds back a partial line', () => {
		const logs = new LogService(100);
		logs.ingest('first line\nsecond li', 'kvstream');
		assert.strictEqual(logs.size, 1);
		logs.ingest('ne\n', 'kvstream');
		assert.strictEqual(logs.size, 2);
		assert.strictEqual(logs.snapshot().entries[1].message, 'second line');
		logs.dispose();
	});

	test('handles CRLF', () => {
		const logs = new LogService(100);
		logs.ingest('a\r\nb\r\n', 'kvstream');
		assert.deepStrictEqual(
			logs.snapshot().entries.map((e) => e.message),
			['a', 'b'],
		);
		logs.dispose();
	});

	test('flush emits a trailing partial line', () => {
		const logs = new LogService(100);
		logs.ingest('no newline yet', 'kvstream');
		assert.strictEqual(logs.size, 0);
		logs.flush('kvstream');
		assert.strictEqual(logs.size, 1);
		logs.dispose();
	});

	test('the buffer is bounded and reports truncation', () => {
		const logs = new LogService(100);
		for (let i = 0; i < 500; i++) {
			logs.ingest(`line ${i}\n`, 'kvstream');
		}
		const snapshot = logs.snapshot();
		assert.strictEqual(snapshot.entries.length, 100);
		assert.strictEqual(snapshot.truncated, true);
		assert.strictEqual(snapshot.entries[99].message, 'line 499');
		logs.dispose();
	});

	test('clear empties the view and resets truncation', () => {
		const logs = new LogService(100);
		logs.ingest('x\n', 'kvstream');
		logs.clear();
		assert.strictEqual(logs.size, 0);
		assert.strictEqual(logs.snapshot().truncated, false);
		logs.dispose();
	});

	test('appends fire for subscribers', () => {
		const logs = new LogService(100);
		let received = 0;
		const subscription = logs.onDidAppend((entries) => {
			received += entries.length;
		});
		logs.ingest('a\nb\n', 'kvstream');
		assert.strictEqual(received, 2);
		subscription.dispose();
		logs.dispose();
	});
});
