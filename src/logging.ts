import * as vscode from 'vscode';

/**
 * The extension's diagnostic channel.
 *
 * Polling fails every two seconds while the gateway is down, so a naive
 * channel fills with thousands of identical lines and becomes useless exactly
 * when someone needs to read it. Repeats of the same message are collapsed
 * into a count, and a repeating message backs off to one line per minute.
 */
export class Logger implements vscode.Disposable {
	private readonly channel: vscode.LogOutputChannel;
	private lastKey?: string;
	private lastAt = 0;
	private suppressed = 0;

	/** How long a repeat of the same line stays suppressed. */
	private static readonly REPEAT_WINDOW_MS = 60_000;

	constructor(name = 'KVStream Monitor') {
		this.channel = vscode.window.createOutputChannel(name, { log: true });
	}

	info(message: string): void {
		this.write('info', message);
	}

	warn(message: string): void {
		this.write('warn', message);
	}

	error(message: string, error?: unknown): void {
		// A stack is a developer's tool, not a user's. It goes to the channel
		// (which is opt-in) and never into a notification.
		const detail = error instanceof Error ? `${message}: ${error.stack ?? error.message}` : message;
		this.write('error', detail);
	}

	debug(message: string): void {
		this.channel.debug(message);
	}

	show(): void {
		this.channel.show(true);
	}

	private write(level: 'info' | 'warn' | 'error', message: string): void {
		const key = `${level}:${message}`;
		const now = Date.now();
		if (key === this.lastKey && now - this.lastAt < Logger.REPEAT_WINDOW_MS) {
			this.suppressed++;
			return;
		}
		if (this.suppressed > 0 && key !== this.lastKey) {
			this.emit('info', `(previous message repeated ${this.suppressed} more time(s))`);
			this.suppressed = 0;
		} else if (this.suppressed > 0) {
			message = `${message} (repeated ${this.suppressed + 1} times)`;
			this.suppressed = 0;
		}
		this.lastKey = key;
		this.lastAt = now;
		this.emit(level, message);
	}

	private emit(level: 'info' | 'warn' | 'error', message: string): void {
		if (level === 'info') {
			this.channel.info(message);
		} else if (level === 'warn') {
			this.channel.warn(message);
		} else {
			this.channel.error(message);
		}
	}

	dispose(): void {
		this.channel.dispose();
	}
}
