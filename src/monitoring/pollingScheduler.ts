/**
 * A self-rescheduling task that never runs two cycles at once.
 *
 * `setInterval` is wrong for polling an endpoint that can be slower than the
 * interval: it queues cycles behind a stalled request and then fires them all
 * at once when it clears. This waits for each cycle to finish and schedules
 * the next one from that point, so a slow gateway is polled less often rather
 * than hammered.
 *
 * Consecutive failures back off exponentially up to `maxBackoffMs`, so a
 * gateway that is simply not running costs one request a minute instead of
 * one every two seconds.
 */
export class PollingScheduler {
	private timer?: ReturnType<typeof setTimeout>;
	private running = false;
	private stopped = true;
	private failures = 0;
	private pendingImmediate = false;

	constructor(
		private readonly task: () => Promise<boolean>,
		private intervalMs: number,
		private readonly maxBackoffMs = 60_000,
	) {}

	start(): void {
		if (!this.stopped) {
			return;
		}
		this.stopped = false;
		this.failures = 0;
		void this.cycle();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	get isRunning(): boolean {
		return !this.stopped;
	}

	setInterval(intervalMs: number): void {
		this.intervalMs = intervalMs;
	}

	/**
	 * Run now rather than at the next tick.
	 *
	 * A refresh requested while a cycle is in flight is remembered and run
	 * once that cycle finishes, so pressing Refresh during a slow poll is not
	 * silently dropped and does not start a second concurrent request.
	 *
	 * It also forgets earlier failures. A trigger means something may have
	 * changed — the user pressed Refresh, or started a service — so the
	 * following polls run at the normal interval instead of waiting out a
	 * backoff earned while the target was down.
	 */
	trigger(): void {
		if (this.stopped) {
			return;
		}
		this.failures = 0;
		if (this.running) {
			this.pendingImmediate = true;
			return;
		}
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		void this.cycle();
	}

	private async cycle(): Promise<void> {
		if (this.stopped || this.running) {
			return;
		}
		this.running = true;
		let ok = false;
		try {
			ok = await this.task();
		} catch {
			ok = false;
		} finally {
			this.running = false;
		}

		this.failures = ok ? 0 : this.failures + 1;

		if (this.stopped) {
			return;
		}
		if (this.pendingImmediate) {
			this.pendingImmediate = false;
			void this.cycle();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.cycle();
		}, this.delay());
	}

	private delay(): number {
		if (this.failures === 0) {
			return this.intervalMs;
		}
		const backoff = this.intervalMs * 2 ** Math.min(this.failures, 10);
		return Math.min(this.maxBackoffMs, backoff);
	}
}
