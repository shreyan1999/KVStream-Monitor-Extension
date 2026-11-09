import type { Sample } from '../types/metrics';

/**
 * A bounded, time-windowed series.
 *
 * Bounded twice over — by wall-clock window and by point count — because a
 * fast refresh interval and a long window multiply, and a monitor left open
 * overnight must not grow without limit.
 */
export class Series {
	private readonly points: Sample[] = [];

	constructor(
		private windowMs: number,
		private readonly maxPoints = 2000,
	) {}

	push(t: number, v: number): void {
		if (!Number.isFinite(v)) {
			return;
		}
		// Out-of-order samples would make a chart lie about direction; a late
		// response that lost its race is dropped rather than inserted.
		const last = this.points[this.points.length - 1];
		if (last && t < last.t) {
			return;
		}
		this.points.push({ t, v });
		this.trim(t);
	}

	setWindow(windowMs: number): void {
		this.windowMs = windowMs;
		const last = this.points[this.points.length - 1];
		if (last) {
			this.trim(last.t);
		}
	}

	private trim(now: number): void {
		const cutoff = now - this.windowMs;
		let drop = 0;
		while (drop < this.points.length && this.points[drop].t < cutoff) {
			drop++;
		}
		if (drop > 0) {
			this.points.splice(0, drop);
		}
		if (this.points.length > this.maxPoints) {
			this.points.splice(0, this.points.length - this.maxPoints);
		}
	}

	get size(): number {
		return this.points.length;
	}

	get last(): Sample | undefined {
		return this.points[this.points.length - 1];
	}

	snapshot(): Sample[] {
		return this.points.map((p) => ({ ...p }));
	}

	clear(): void {
		this.points.length = 0;
	}
}

/**
 * The per-counter state needed to turn a monotonic counter into a rate.
 *
 * A counter that goes backwards means the gateway restarted; its history is
 * not continuous with what came before, so the rate for that interval is not
 * reported rather than reported as a large negative or a spike.
 */
export class RateTracker {
	private previous?: { t: number; v: number };

	/** Returns units per second since the previous sample, or `undefined`. */
	observe(t: number, v: number): number | undefined {
		if (!Number.isFinite(v) || v < 0) {
			this.previous = undefined;
			return undefined;
		}
		const prev = this.previous;
		this.previous = { t, v };
		if (!prev) {
			return undefined;
		}
		const dt = (t - prev.t) / 1000;
		if (dt <= 0) {
			return undefined;
		}
		if (v < prev.v) {
			// Counter reset. Drop this interval; the next one is measurable again.
			return undefined;
		}
		return (v - prev.v) / dt;
	}

	reset(): void {
		this.previous = undefined;
	}
}

export class HistoryStore {
	readonly throughput: Series;
	readonly queueDepth: Series;
	readonly running: Series;
	readonly utilization: Series;
	private readonly requestRate = new RateTracker();

	constructor(private windowMs: number) {
		this.throughput = new Series(windowMs);
		this.queueDepth = new Series(windowMs);
		this.running = new Series(windowMs);
		this.utilization = new Series(windowMs);
	}

	setWindow(windowMs: number): void {
		this.windowMs = windowMs;
		this.throughput.setWindow(windowMs);
		this.queueDepth.setWindow(windowMs);
		this.running.setWindow(windowMs);
		this.utilization.setWindow(windowMs);
	}

	get window(): number {
		return this.windowMs;
	}

	/** Record one metrics sample. Absent inputs record nothing for that series. */
	record(
		t: number,
		sample: { totalRequests?: number; queueDepth?: number; running?: number; utilization?: number },
	): void {
		if (sample.totalRequests !== undefined) {
			const rate = this.requestRate.observe(t, sample.totalRequests);
			if (rate !== undefined) {
				this.throughput.push(t, rate);
			}
		} else {
			this.requestRate.reset();
		}
		if (sample.queueDepth !== undefined) {
			this.queueDepth.push(t, sample.queueDepth);
		}
		if (sample.running !== undefined) {
			this.running.push(t, sample.running);
		}
		if (sample.utilization !== undefined) {
			this.utilization.push(t, sample.utilization);
		}
	}

	/**
	 * Forget the counter baseline without discarding history.
	 *
	 * Used when the endpoint changes or polling resumes after a disconnect:
	 * the next sample starts a new interval instead of producing a rate across
	 * the gap, which would be an average over dead time.
	 */
	breakContinuity(): void {
		this.requestRate.reset();
	}

	clear(): void {
		this.throughput.clear();
		this.queueDepth.clear();
		this.running.clear();
		this.utilization.clear();
		this.requestRate.reset();
	}
}
