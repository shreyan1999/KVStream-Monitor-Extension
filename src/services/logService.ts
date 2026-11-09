import * as vscode from 'vscode';
import type { LogEntryDTO, LogLevel } from '../types/messages';

/**
 * The live-log buffer.
 *
 * KVStream exposes **no logs endpoint** — the routes are `/health`, `/status`,
 * `/metrics` and the `/v1/*` proxy surface, and nothing else. So the only
 * honest log source is the standard output of a `kvstream serve` this
 * extension started itself. When the gateway was started elsewhere there is
 * nothing to stream, and the UI says so rather than showing an empty panel
 * that looks like silence.
 *
 * Storage is a fixed-size ring: a gateway under load writes a line per
 * request, and an editor left open for a day must not accumulate them all.
 */
export class LogService implements vscode.Disposable {
	private entries: LogEntryDTO[] = [];
	private capacity: number;
	private truncated = false;
	private readonly emitter = new vscode.EventEmitter<LogEntryDTO[]>();

	readonly onDidAppend = this.emitter.event;

	constructor(capacity: number) {
		this.capacity = Math.max(100, capacity);
	}

	setCapacity(capacity: number): void {
		this.capacity = Math.max(100, capacity);
		this.trim();
	}

	/**
	 * Feed a raw chunk from a process stream.
	 *
	 * Chunks arrive split at arbitrary byte boundaries, so a partial trailing
	 * line is held back until its newline arrives rather than emitted as its
	 * own entry.
	 */
	private partial = '';

	ingest(chunk: string, source: string): void {
		this.partial += chunk;
		const lines = this.partial.split(/\r?\n/);
		this.partial = lines.pop() ?? '';
		const appended: LogEntryDTO[] = [];
		for (const line of lines) {
			if (line.trim() === '') {
				continue;
			}
			const entry: LogEntryDTO = {
				t: Date.now(),
				level: detectLevel(line),
				message: line,
				source,
			};
			this.entries.push(entry);
			appended.push(entry);
		}
		if (appended.length > 0) {
			this.trim();
			this.emitter.fire(appended);
		}
	}

	/** Record an event of the extension's own, e.g. a process exit. */
	note(message: string, level: LogLevel = 'info', source = 'extension'): void {
		const entry: LogEntryDTO = { t: Date.now(), level, message, source };
		this.entries.push(entry);
		this.trim();
		this.emitter.fire([entry]);
	}

	/** Flush a trailing partial line, e.g. when the process exits. */
	flush(source: string): void {
		if (this.partial.trim() !== '') {
			const line = this.partial;
			this.partial = '';
			this.note(line, detectLevel(line), source);
		} else {
			this.partial = '';
		}
	}

	private trim(): void {
		if (this.entries.length > this.capacity) {
			this.entries = this.entries.slice(this.entries.length - this.capacity);
			this.truncated = true;
		}
	}

	snapshot(): { entries: LogEntryDTO[]; truncated: boolean } {
		return { entries: [...this.entries], truncated: this.truncated };
	}

	get size(): number {
		return this.entries.length;
	}

	/**
	 * Empty the buffer this extension holds.
	 *
	 * This clears what the panel shows. It does not and cannot delete anything
	 * on the service side — KVStream writes to its own stdout, and once a line
	 * is dropped here it is gone, because there is no endpoint to fetch it back
	 * from.
	 */
	clear(): void {
		this.entries = [];
		this.truncated = false;
		this.emitter.fire([]);
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

const LEVEL_PATTERN = /\b(CRITICAL|FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\b/;

/**
 * Infer severity from a log line.
 *
 * Deliberately does not treat stderr as error: uvicorn, which KVStream runs
 * on, writes its ordinary access and startup lines to stderr, so a
 * stream-based rule would mark a healthy startup as a failure.
 */
export function detectLevel(line: string): LogLevel {
	const match = LEVEL_PATTERN.exec(line);
	if (match) {
		switch (match[1]) {
			case 'CRITICAL':
			case 'FATAL':
			case 'ERROR':
				return 'error';
			case 'WARNING':
			case 'WARN':
				return 'warn';
			case 'DEBUG':
			case 'TRACE':
				return 'debug';
			default:
				return 'info';
		}
	}
	if (/^\s*(Traceback \(most recent call last\)|\s{2}File ")/.test(line)) {
		return 'error';
	}
	return 'info';
}
