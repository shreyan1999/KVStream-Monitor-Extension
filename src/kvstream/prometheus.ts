import type { PromFamily, PromRegistry, PromSample } from '../types/metrics';

/**
 * Parse the Prometheus text exposition format.
 *
 * Deliberately tolerant: an unparseable line is skipped rather than failing
 * the whole scrape, because `/metrics` grows new families between gateway
 * versions and one unknown line must not blank the dashboard. `NaN`, `+Inf`
 * and `-Inf` are recognised and dropped, since no metric this extension reads
 * has a meaningful infinite value.
 */
export function parsePrometheus(text: string): PromRegistry {
	const registry: PromRegistry = new Map();

	const family = (name: string): PromFamily => {
		let f = registry.get(name);
		if (!f) {
			f = { name, samples: [] };
			registry.set(name, f);
		}
		return f;
	};

	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (line === '') {
			continue;
		}
		if (line.startsWith('#')) {
			const meta = /^#\s+(HELP|TYPE)\s+(\S+)\s*([\s\S]*)$/.exec(line);
			if (!meta) {
				continue;
			}
			const [, kind, name, rest] = meta;
			if (kind === 'HELP') {
				family(name).help = rest;
			} else {
				const type = rest.trim().toLowerCase();
				family(name).type = isPromType(type) ? type : 'untyped';
			}
			continue;
		}

		const sample = parseSampleLine(line);
		if (sample) {
			// Histogram and summary children (`_bucket`, `_sum`, `_count`) arrive
			// as their own metric names; keep them addressable under those names.
			family(baseName(sample.name)).samples.push(sample);
		}
	}

	return registry;
}

function isPromType(value: string): value is NonNullable<PromFamily['type']> {
	return ['counter', 'gauge', 'histogram', 'summary', 'untyped'].includes(value);
}

/** `foo_bucket` and `foo_sum` belong to family `foo`; everything else is itself. */
function baseName(name: string): string {
	return name;
}

function parseSampleLine(line: string): PromSample | undefined {
	const braceStart = line.indexOf('{');
	let name: string;
	let labels: Record<string, string> = {};
	let rest: string;

	if (braceStart === -1) {
		const space = line.search(/\s/);
		if (space === -1) {
			return undefined;
		}
		name = line.slice(0, space);
		rest = line.slice(space + 1);
	} else {
		name = line.slice(0, braceStart);
		const braceEnd = findClosingBrace(line, braceStart);
		if (braceEnd === -1) {
			return undefined;
		}
		const parsed = parseLabels(line.slice(braceStart + 1, braceEnd));
		if (!parsed) {
			return undefined;
		}
		labels = parsed;
		rest = line.slice(braceEnd + 1);
	}

	if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
		return undefined;
	}

	const value = parseValue(rest.trim().split(/\s+/)[0]);
	if (value === undefined) {
		return undefined;
	}
	return { name, labels, value };
}

/** Scan for `}` while respecting quoted label values, which may contain one. */
function findClosingBrace(line: string, from: number): number {
	let inQuotes = false;
	let escaped = false;
	for (let i = from + 1; i < line.length; i++) {
		const ch = line[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === '\\') {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inQuotes = !inQuotes;
			continue;
		}
		if (ch === '}' && !inQuotes) {
			return i;
		}
	}
	return -1;
}

function parseLabels(body: string): Record<string, string> | undefined {
	const labels: Record<string, string> = {};
	const trimmed = body.trim();
	if (trimmed === '') {
		return labels;
	}
	const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*,?\s*/y;
	let index = 0;
	while (index < trimmed.length) {
		pattern.lastIndex = index;
		const match = pattern.exec(trimmed);
		if (!match) {
			return undefined;
		}
		labels[match[1]] = unescapeLabel(match[2]);
		index = pattern.lastIndex;
	}
	return labels;
}

function unescapeLabel(value: string): string {
	return value.replace(/\\(.)/g, (_, ch: string) => {
		switch (ch) {
			case 'n':
				return '\n';
			case '\\':
				return '\\';
			case '"':
				return '"';
			default:
				return ch;
		}
	});
}

function parseValue(token: string | undefined): number | undefined {
	if (!token) {
		return undefined;
	}
	if (token === 'NaN' || token === '+Inf' || token === '-Inf' || token === 'Inf') {
		return undefined;
	}
	const value = Number(token);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * Sum every sample of a family, or `undefined` when the family is absent.
 *
 * A *declared counter* with no samples is a real zero, not a missing value:
 * a labelled counter exposes no series until its first increment, so a gateway
 * that has served nothing prints only the `# TYPE` line (verified against
 * KVStream 1.0.0 on `kvstream_requests_total`). An undeclared family, or a
 * gauge with no sample, stays `undefined`.
 */
export function sumFamily(registry: PromRegistry, name: string): number | undefined {
	const family = registry.get(name);
	if (!family) {
		return undefined;
	}
	if (family.samples.length === 0) {
		return family.type === 'counter' ? 0 : undefined;
	}
	return family.samples.reduce((acc, s) => acc + s.value, 0);
}

/** Whether `name` is declared as a counter, with or without samples yet. */
export function isDeclaredCounter(registry: PromRegistry, name: string): boolean {
	return registry.get(name)?.type === 'counter';
}

/** The single value of a gauge-shaped family, or `undefined`. */
export function gaugeValue(registry: PromRegistry, name: string): number | undefined {
	const family = registry.get(name);
	if (!family || family.samples.length === 0) {
		return undefined;
	}
	return family.samples[0].value;
}

/** Sum samples whose labels match every entry of `match`. */
export function sumWhere(
	registry: PromRegistry,
	name: string,
	match: Record<string, string>,
): number | undefined {
	const family = registry.get(name);
	if (!family) {
		return undefined;
	}
	const matching = family.samples.filter((s) =>
		Object.entries(match).every(([k, v]) => s.labels[k] === v),
	);
	if (matching.length === 0) {
		return undefined;
	}
	return matching.reduce((acc, s) => acc + s.value, 0);
}

/** Total each distinct value of `label` within a family. */
export function groupByLabel(
	registry: PromRegistry,
	name: string,
	label: string,
): Record<string, number> {
	const family = registry.get(name);
	const out: Record<string, number> = {};
	if (!family) {
		return out;
	}
	for (const sample of family.samples) {
		const key = sample.labels[label];
		if (key === undefined) {
			continue;
		}
		out[key] = (out[key] ?? 0) + sample.value;
	}
	return out;
}
