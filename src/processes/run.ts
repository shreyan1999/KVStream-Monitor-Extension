import { spawn } from 'child_process';

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	/** Set when the executable could not be started at all. */
	spawnError?: string;
}

/**
 * Run a command and collect its output.
 *
 * Always `shell: false` with an argv array: no part of a command line is ever
 * built by concatenating a configured path or a user-supplied value, so a
 * setting cannot introduce a second command. On Windows that means the target
 * must be a real executable — `foundry.exe` resolved from PATH, not a `.cmd`
 * shim invoked through cmd.exe — which is why a spawn failure is reported as
 * a missing executable rather than retried through a shell.
 */
export function run(
	file: string,
	args: string[],
	opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: RunResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		let child;
		try {
			child = spawn(file, args, {
				shell: false,
				cwd: opts.cwd,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (error) {
			finish({ code: null, stdout: '', stderr: '', spawnError: String(error) });
			return;
		}

		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});

		const timer = setTimeout(() => {
			child.kill();
			finish({ code: null, stdout, stderr, spawnError: 'timed out' });
		}, opts.timeoutMs ?? 5000);

		child.on('error', (error) => {
			finish({ code: null, stdout, stderr, spawnError: error.message });
		});
		child.on('close', (code) => {
			finish({ code, stdout, stderr });
		});
	});
}

/**
 * Strip ANSI escape sequences.
 *
 * The Foundry CLI colours its output even when stdout is a pipe, and the
 * escape codes break `JSON.parse` on an otherwise valid document.
 */
export function stripAnsi(text: string): string {
	return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}
