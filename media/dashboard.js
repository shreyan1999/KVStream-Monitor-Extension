// @ts-check
/*
 * KVStream Monitor — webview renderer for both the dashboard tab and the
 * Activity Bar sidebar.
 *
 * Runs under `default-src 'none'`: no network, no eval, no remote assets.
 * Every value that originates outside this file — model ids, URLs, hints, log
 * lines — is written with `textContent`, never parsed as HTML. The only markup
 * ever parsed is the constant icon table below, which this file owns.
 *
 * Rendering rules:
 *  - A measured value renders as the number; a missing one renders "n/a" with
 *    the reason as its tooltip. Never 0 for "unknown".
 *  - The DOM is built once and updated in place, so a refresh does not shift
 *    the layout, reset scroll position or steal focus from the log search box.
 */

(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const mode = document.body.dataset.mode === 'dashboard' ? 'dashboard' : 'sidebar';

	/** @type {any} */
	let model = null;
	/** @type {{t:number,level:string,message:string,source:string}[]} */
	let logEntries = [];
	let logTruncated = false;
	let logPaused = false;
	let logSearch = '';
	/** 'all' | 'info' | 'warn' | 'error' */
	let logLevel = 'all';
	let followLogs = true;
	/** Visible chart range in ms. */
	let rangeMs = 5 * 60 * 1000;

	// -- icons (constant markup, owned by this file) ----------------------

	const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
	const ICONS = {
		logo: `<svg viewBox="0 0 24 24" ${S}><path d="M4 4v16"/><path d="M8 7h6M8 12h9M8 17h5"/><path d="M20 4v16" opacity=".5"/></svg>`,
		server: `<svg viewBox="0 0 24 24" ${S}><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>`,
		box: `<svg viewBox="0 0 24 24" ${S}><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>`,
		requests: `<svg viewBox="0 0 24 24" ${S}><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>`,
		running: `<svg viewBox="0 0 24 24" ${S}><path d="M22 12h-4l-3 8L9 4l-3 8H2"/></svg>`,
		queue: `<svg viewBox="0 0 24 24" ${S}><path d="M6 2h12M6 22h12"/><path d="M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4"/></svg>`,
		shield: `<svg viewBox="0 0 24 24" ${S}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/></svg>`,
		cpu: `<svg viewBox="0 0 24 24" ${S}><rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>`,
		gpu: `<svg viewBox="0 0 24 24" ${S}><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="15" cy="12" r="3"/><path d="M6 10h3M6 14h3"/></svg>`,
		chart: `<svg viewBox="0 0 24 24" ${S}><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg>`,
		pie: `<svg viewBox="0 0 24 24" ${S}><path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/></svg>`,
		heart: `<svg viewBox="0 0 24 24" ${S}><path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21.5l8.8-8.8a5 5 0 0 0 0-7.1z"/></svg>`,
		logs: `<svg viewBox="0 0 24 24" ${S}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg>`,
		play: `<svg viewBox="0 0 24 24" ${S}><path d="M7 4v16l13-8z"/></svg>`,
		refresh: `<svg viewBox="0 0 24 24" ${S}><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`,
		stop: `<svg viewBox="0 0 24 24" ${S}><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`,
		gear: `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
		pulse: `<svg viewBox="0 0 24 24" ${S}><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>`,
		model: `<svg viewBox="0 0 24 24" ${S}><path d="M12 2 2 7l10 5 10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></svg>`,
		breaker: `<svg viewBox="0 0 24 24" ${S}><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`,
		check: `<svg viewBox="0 0 24 24" ${S}><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m22 4-10 10-3-3"/></svg>`,
		chevron: `<svg viewBox="0 0 24 24" ${S}><path d="m9 18 6-6-6-6"/></svg>`,
		pause: `<svg viewBox="0 0 24 24" ${S}><path d="M8 5v14M16 5v14"/></svg>`,
		trash: `<svg viewBox="0 0 24 24" ${S}><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>`,
		dashboard: `<svg viewBox="0 0 24 24" ${S}><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>`,
	};

	const iconTemplate = document.createElement('template');
	/** @param {keyof typeof ICONS} name */
	function icon(name) {
		const span = document.createElement('span');
		span.className = 'icon';
		span.setAttribute('aria-hidden', 'true');
		// Constant markup from the table above; never service data.
		iconTemplate.innerHTML = ICONS[name];
		span.append(iconTemplate.content.cloneNode(true));
		return span;
	}

	// -- DOM helpers ------------------------------------------------------

	/**
	 * @param {string} tag
	 * @param {Record<string, string>} [attrs]
	 * @param {(Node|string)[]} [children]
	 */
	function el(tag, attrs, children) {
		const node = document.createElement(tag);
		for (const key of Object.keys(attrs || {})) {
			const value = /** @type {Record<string,string>} */ (attrs)[key];
			if (key === 'class') {
				node.className = value;
			} else if (key === 'text') {
				node.textContent = value;
			} else {
				node.setAttribute(key, value);
			}
		}
		for (const child of children || []) {
			node.append(child);
		}
		return node;
	}

	/** @param {string} tag @param {Record<string,string>} attrs */
	function svgEl(tag, attrs) {
		const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
		for (const key of Object.keys(attrs)) {
			node.setAttribute(key, attrs[key]);
		}
		return node;
	}

	/** @param {Node} node */
	function clear(node) {
		while (node.firstChild) {
			node.removeChild(node.firstChild);
		}
	}

	/** @param {string} action @param {unknown} [payload] */
	function post(action, payload) {
		vscode.postMessage(payload === undefined ? { action } : { action, payload });
	}

	/**
	 * @param {string} label
	 * @param {keyof typeof ICONS | null} iconName
	 * @param {string} action
	 * @param {string} [cls]
	 */
	function button(label, iconName, action, cls) {
		const node = el('button', { class: `btn ${cls || ''}`.trim(), type: 'button' });
		if (iconName) {
			node.append(icon(iconName));
		}
		node.append(el('span', { text: label }));
		node.addEventListener('click', () => post(action));
		return node;
	}

	/** @param {keyof typeof ICONS} iconName @param {string} label @param {() => void} onClick */
	function iconButton(iconName, label, onClick) {
		const node = el('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label });
		node.append(icon(iconName));
		node.addEventListener('click', onClick);
		return node;
	}

	// -- formatting -------------------------------------------------------

	const intFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

	/** @param {number} v */
	const formatCount = (v) => (Number.isFinite(v) ? intFormat.format(v) : '—');

	/** @param {number} v */
	function formatRate(v) {
		if (!Number.isFinite(v)) {
			return '—';
		}
		return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}/s`;
	}

	/** @param {number} f */
	function formatPercent(f) {
		return Number.isFinite(f) ? `${Math.round(f * 100)}%` : '—';
	}

	/** @param {number} bytes */
	function formatBytes(bytes) {
		if (!Number.isFinite(bytes)) {
			return '—';
		}
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let value = bytes;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit++;
		}
		return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
	}

	/** @param {number} ms */
	function formatDuration(ms) {
		const s = Math.max(0, Math.floor(ms / 1000));
		const d = Math.floor(s / 86400);
		const h = Math.floor((s % 86400) / 3600);
		const m = Math.floor((s % 3600) / 60);
		if (d > 0) {
			return `${d}d ${h}h`;
		}
		if (h > 0) {
			return `${h}h ${m}m`;
		}
		return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
	}

	/** @param {number} t */
	function formatClock(t) {
		const d = new Date(t);
		const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
		return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	}

	/** @param {number} t */
	function formatShortClock(t) {
		const d = new Date(t);
		return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	}

	/**
	 * Write a `Measured` into a node: the number, or "n/a" with the reason as
	 * the tooltip. A reported zero is "idle"; a missing value is "unknown", and
	 * conflating them makes a broken monitor look healthy.
	 *
	 * @param {HTMLElement} node
	 * @param {{value?: number, reason?: string} | undefined} measured
	 * @param {(v: number) => string} format
	 * @param {string} baseClass
	 */
	function setMeasured(node, measured, format, baseClass) {
		if (measured && typeof measured.value === 'number') {
			node.className = baseClass;
			node.textContent = format(measured.value);
			node.removeAttribute('title');
		} else {
			node.className = `${baseClass} na`;
			node.textContent = 'n/a';
			node.title = (measured && measured.reason) || 'not available';
		}
	}

	/**
	 * @param {HTMLElement} node
	 * @param {string | undefined | null} text
	 * @param {string} [title]
	 * @param {string} [cls]
	 */
	function setText(node, text, title, cls) {
		node.textContent = text || 'n/a';
		node.className = text ? cls || '' : 'na';
		node.title = title || (text ? text : '');
	}

	// -- state vocabulary -------------------------------------------------

	const SERVICE = {
		healthy: ['Healthy', 'tone-ok'],
		degraded: ['Degraded', 'tone-warn'],
		starting: ['Starting', 'tone-info'],
		stopped: ['Stopped', 'tone-idle'],
		disconnected: ['Disconnected', 'tone-idle'],
		error: ['Error', 'tone-bad'],
		unknown: ['Unknown', 'tone-idle'],
		loading: ['Connecting', 'tone-info'],
	};

	const GATEWAY = {
		healthy: ['Running', 'tone-ok'],
		degraded: ['Running', 'tone-ok'],
		starting: ['Starting', 'tone-info'],
		stopped: ['Stopped', 'tone-idle'],
		disconnected: ['Not reachable', 'tone-idle'],
		error: ['Error', 'tone-bad'],
		unknown: ['Unknown', 'tone-idle'],
		loading: ['Connecting', 'tone-info'],
	};

	const BACKEND = {
		serving: ['Serving', 'tone-ok'],
		running: ['Running', 'tone-ok'],
		starting: ['Starting', 'tone-info'],
		no_model: ['No model loaded', 'tone-warn'],
		reachable: ['Not serving', 'tone-warn'],
		unreachable: ['Unreachable', 'tone-bad'],
		not_installed: ['Not installed', 'tone-idle'],
		stopped: ['Not running', 'tone-idle'],
		unknown: ['Unknown', 'tone-idle'],
	};

	const CIRCUIT = {
		closed: ['Closed', 'tone-ok'],
		half_open: ['Half-open', 'tone-warn'],
		open: ['Open', 'tone-bad'],
	};

	const ROUTE_LABELS = {
		chat: 'Chat completions',
		completions: 'Text completions',
		embeddings: 'Embeddings',
		transcriptions: 'Transcriptions',
	};

	const ROUTE_COLORS = ['var(--kv-blue)', 'var(--kv-purple)', 'var(--kv-pink)', 'var(--kv-cyan)', 'var(--kv-yellow)'];

	/**
	 * @param {HTMLElement} node
	 * @param {[string, string] | undefined} pair
	 * @param {string} [fallback]
	 */
	function setStatus(node, pair, fallback) {
		const [word, tone] = pair || [fallback || 'Unknown', 'tone-idle'];
		node.className = `status-word ${tone}`;
		clear(node);
		node.append(el('span', { class: 'dot' }), el('span', { text: word }));
	}

	// -- skeleton ---------------------------------------------------------

	/** @type {Record<string, any>} */
	const ui = {};

	/** @param {keyof typeof ICONS} iconName @param {string} title @param {Node[]} [extra] */
	function card(iconName, title, extra) {
		const heading = el('h2', { class: 'card-title' }, [icon(iconName), el('span', { text: title })]);
		if (extra && extra.length) {
			heading.append(el('span', { class: 'grow' }), ...extra);
		}
		return el('section', { class: 'card' }, [heading]);
	}

	function buildHero() {
		ui.health = el('span', { class: 'health-badge tone-idle' }, [el('span', { class: 'dot' }), el('span', { text: 'Connecting' })]);

		ui.autoSwitch = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'true' }, [
			el('span', { text: 'Auto refresh' }),
			el('span', { class: 'track' }),
		]);
		ui.autoSwitch.addEventListener('click', () => {
			const next = ui.autoSwitch.getAttribute('aria-checked') !== 'true';
			ui.autoSwitch.setAttribute('aria-checked', String(next));
			post('setAutoRefresh', next);
		});

		ui.updatedTime = el('strong', { text: '—' });
		ui.updated = el('div', { class: 'updated' }, [el('span', { text: 'Last updated' }), ui.updatedTime]);
		ui.refresh = iconButton('refresh', 'Refresh now', () => post('refresh'));

		const logo = el('div', { class: 'brand-logo' }, [icon('logo')]);

		if (mode === 'sidebar') {
			// The view's title bar already has Refresh, so the header is just
			// the name and one status word.
			return el('div', { class: 'side-header' }, [
				logo,
				el('span', { class: 'title', text: 'KVStream' }),
				el('span', { class: 'spacer' }),
				ui.health,
			]);
		}

		return el('header', { class: 'hero' }, [
			el('div', { class: 'brand' }, [
				logo,
				el('div', {}, [
					el('h1', { text: 'KVStream' }),
					el('p', { text: 'Real-time monitoring and management' }),
				]),
			]),
			el('span', { class: 'spacer' }),
			ui.health,
			el('div', { class: 'hero-meta' }, [ui.autoSwitch, ui.updated, ui.refresh]),
		]);
	}

	function buildNav() {
		/** @param {keyof typeof ICONS} iconName @param {string} label @param {string} action */
		const item = (iconName, label, action) => {
			const node = el('button', { class: 'nav-item', type: 'button' }, [icon(iconName), el('span', { text: label })]);
			node.addEventListener('click', () => post(action));
			return node;
		};
		return el('nav', { class: 'nav', 'aria-label': 'KVStream' }, [
			item('dashboard', 'Dashboard', 'openDashboard'),
			item('logs', 'Logs', 'openLogs'),
			item('gear', 'Settings', 'openSettings'),
		]);
	}

	/**
	 * @param {'kvstream' | 'foundry'} which
	 */
	function buildServiceCard(which) {
		const isGateway = which === 'kvstream';
		const status = el('span', { class: 'status-word tone-idle' });
		const rows = isGateway
			? [['URL', 'url'], ['Version', 'version'], ['Uptime', 'uptime']]
			: [['URL', 'url'], ['Model', 'model'], ['Uptime', 'uptime']];
		const dl = el('dl', { class: 'kv' });
		/** @type {Record<string, HTMLElement>} */
		const refs = {};
		for (const [label, key] of rows) {
			const dd = el('dd', { text: '—' });
			dl.append(el('dt', { text: label }), dd);
			refs[key] = dd;
		}
		const node = el('section', { class: 'card' }, [
			el('div', { class: 'service-head' }, [
				el('div', { class: `icon-tile ${mode === 'sidebar' ? 'sm ' : ''}accent-blue` }, [icon(isGateway ? 'server' : 'box')]),
				el('div', {}, [el('h3', { text: isGateway ? 'KVStream' : 'Foundry Local' }), status]),
			]),
			dl,
		]);
		ui[which] = { status, ...refs };
		return node;
	}

	function buildActions() {
		const node = card('play', 'Quick Actions');
		ui.actions = {
			startService: button('Start', 'play', 'startService', 'solid-green'),
			restartService: button('Restart', 'refresh', 'restartService', 'solid-blue'),
			stopService: button('Stop', 'stop', 'stopService'),
			calibrate: button('Calibrate', 'gear', 'calibrate'),
			openLogs: button('Open Logs', 'logs', 'openLogs'),
			checkHealth: button('Health check', 'check', 'checkHealth'),
			startFoundry: button('Start', null, 'startFoundry', 'small'),
			restartFoundry: button('Restart', null, 'restartFoundry', 'small'),
			stopFoundry: button('Stop', null, 'stopFoundry', 'small'),
			loadFoundryModel: button('Load model…', 'model', 'loadFoundryModel', 'small'),
		};
		ui.actionsNote = el('p', { class: 'card-note' });
		const a = ui.actions;
		node.append(
			el('div', { class: 'actions' }, [a.startService, a.restartService, a.stopService]),
			el('div', { class: 'actions' }, [a.calibrate, a.openLogs, a.checkHealth]),
			el('div', { class: 'subhead', text: 'Foundry Local' }),
			el('div', { class: 'actions' }, [a.startFoundry, a.restartFoundry, a.stopFoundry]),
			el('div', { class: 'actions' }, [a.loadFoundryModel]),
			ui.actionsNote,
		);
		return node;
	}

	/**
	 * @param {string} key
	 * @param {keyof typeof ICONS} iconName
	 * @param {string} label
	 * @param {string} accent
	 * @param {'spark' | 'bar' | 'none'} foot
	 * @param {string} [tooltip]
	 */
	function buildStat(key, iconName, label, accent, foot, tooltip) {
		const value = el('div', { class: 'stat-value', text: '—' });
		const sub = el('div', { class: 'stat-sub', text: '' });
		const footer = el('div', { class: 'stat-foot' });
		const head = el('div', { class: 'stat-head' }, [
			el('div', { class: `icon-tile sm accent-${accent}` }, [icon(iconName)]),
			el('span', { text: label }),
		]);
		if (tooltip) {
			head.title = tooltip;
		}
		const node = el('section', { class: `card stat accent-${accent}` }, [head, value, sub, footer]);
		/** @type {Record<string, any>} */
		const refs = { node, value, sub, footer, foot };
		if (foot === 'bar') {
			refs.fill = el('span');
			refs.bar = el('div', { class: 'bar', role: 'img' }, [refs.fill]);
			footer.append(refs.bar);
		} else if (foot === 'spark') {
			refs.delta = el('span', { class: 'delta flat' });
			refs.spark = svgEl('svg', { class: 'spark', viewBox: '0 0 100 22', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
			footer.append(refs.delta);
			if (mode === 'dashboard') {
				const sparkBox = el('div', { style: 'flex:1 1 auto' });
				sparkBox.append(refs.spark);
				footer.append(sparkBox);
			}
		}
		ui.stats[key] = refs;
		return node;
	}

	function buildStats() {
		ui.stats = {};
		const nodes = [
			buildStat('requests', 'requests', 'Requests', 'blue', 'spark', 'Sum of kvstream_requests_total over every route and outcome.'),
			buildStat('running', 'running', 'Running', 'green', 'spark', 'Requests holding an admission reservation (admission.active).'),
			buildStat('queue', 'queue', 'Queue', 'purple', 'spark', 'Requests waiting for admission (admission.waiting).'),
			buildStat('budget', 'shield', 'Admission budget', 'blue', 'bar',
				"KVStream's admission budget: a configured request count or a calibrated token estimate. Not GPU or KV-cache memory."),
		];
		if (mode === 'dashboard') {
			nodes.push(
				buildStat('memory', 'cpu', 'Memory', 'green', 'bar', 'System memory, from `foundry status --output json`.'),
				buildStat('gpu', 'gpu', 'GPU', 'purple', 'none', 'Device inventory from `foundry status --output json`.'),
			);
		}
		return el('div', { class: 'grid row-stats' }, nodes);
	}

	function buildThroughput() {
		ui.rangeButtons = [];
		const ranges = [
			['5m', 5 * 60 * 1000],
			['15m', 15 * 60 * 1000],
			['1h', 60 * 60 * 1000],
		];
		const segmented = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Time range' });
		for (const [label, ms] of ranges) {
			const b = el('button', { class: 'chip', type: 'button', text: String(label), 'aria-pressed': String(ms === rangeMs) });
			b.addEventListener('click', () => {
				rangeMs = Number(ms);
				for (const other of ui.rangeButtons) {
					other.setAttribute('aria-pressed', String(other === b));
				}
				if (model) {
					renderThroughput(model);
				}
			});
			ui.rangeButtons.push(b);
			segmented.append(b);
		}
		const node = card('chart', 'Request Throughput', [segmented]);
		node.classList.add('chart-card');
		ui.chartHost = el('div', { class: 'chart-host' });
		node.append(
			ui.chartHost,
			el('div', { class: 'legend' }, [
				el('span', { class: 'accent-blue' }, [el('i', { class: 'swatch' }), 'Processed (req/s)']),
				el('span', { class: 'accent-purple' }, [el('i', { class: 'swatch' }), 'Running (requests)']),
			]),
		);
		// Redraw at the real pixel size so axis text is never stretched.
		new ResizeObserver(() => model && renderThroughput(model)).observe(ui.chartHost);
		return node;
	}

	function buildDistribution() {
		const node = card('pie', 'Request Distribution');
		ui.donutSvg = svgEl('svg', { viewBox: '0 0 42 42', role: 'img' });
		ui.donutTotal = el('strong', { text: '—' });
		ui.donutLegend = el('div', { class: 'donut-legend' });
		node.append(
			el('div', { class: 'donut-wrap' }, [
				el('div', { class: 'donut' }, [
					ui.donutSvg,
					el('div', { class: 'donut-center' }, [ui.donutTotal, el('span', { text: 'Total' })]),
				]),
				ui.donutLegend,
			]),
			el('p', { class: 'card-note', text: 'By route, from kvstream_requests_total.' }),
		);
		return node;
	}

	function buildHealth() {
		const node = card('heart', 'Backend Health');
		/** @param {keyof typeof ICONS} iconName @param {string} name @param {string | null} action */
		const row = (iconName, name, action) => {
			const sub = el('div', { class: 'sub' });
			const status = el('span', { class: 'status-word tone-idle' });
			const body = el('div', {}, [el('div', { class: 'name', text: name }), sub]);
			const r = el(action ? 'button' : 'div', { class: 'health-row', ...(action ? { type: 'button' } : {}) }, [icon(iconName), body, status]);
			if (action) {
				r.addEventListener('click', () => post(action));
				r.title = action === 'configureEndpoint' ? 'Configure the gateway endpoint' : 'Run a fresh health check';
			}
			return { r, sub, status };
		};
		ui.healthRows = {
			kvstream: row('server', 'KVStream', 'configureEndpoint'),
			foundry: row('box', 'Foundry Local', 'checkHealth'),
			model: row('model', 'Model', null),
			circuit: row('breaker', 'Circuit breaker', null),
			drift: row('pulse', 'Latency drift', null),
		};
		node.append(el('div', { class: 'health-list' }, Object.values(ui.healthRows).map((x) => x.r)));
		return node;
	}

	function buildLogs() {
		ui.levelChips = [];
		const chips = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Severity' });
		for (const [label, level] of [['All', 'all'], ['Info', 'info'], ['Warn', 'warn'], ['Error', 'error']]) {
			const chip = el('button', { class: 'chip', type: 'button', text: label, 'aria-pressed': String(level === logLevel) });
			chip.addEventListener('click', () => {
				logLevel = level;
				for (const c of ui.levelChips) {
					c.setAttribute('aria-pressed', String(c === chip));
				}
				post('setLogFilter', { search: logSearch, levels: level === 'all' ? ['debug', 'info', 'warn', 'error'] : [level] });
				renderLogs();
			});
			ui.levelChips.push(chip);
			chips.append(chip);
		}

		const search = el('input', { type: 'search', placeholder: 'Search logs', 'aria-label': 'Search logs' });
		search.addEventListener('input', () => {
			logSearch = String(/** @type {HTMLInputElement} */ (search).value || '').slice(0, 200);
			renderLogs();
		});

		ui.pauseBtn = iconButton('pause', 'Pause live updates', () => {
			logPaused = !logPaused;
			ui.pauseBtn.title = logPaused ? 'Resume live updates' : 'Pause live updates';
			ui.pauseBtn.setAttribute('aria-pressed', String(logPaused));
			post('setLogPaused', logPaused);
			renderLogs();
		});
		const clearBtn = el('button', { class: 'chip', type: 'button' }, [el('span', { text: 'Clear' })]);
		clearBtn.title = 'Empties this panel. It cannot delete service-side logs.';
		clearBtn.addEventListener('click', () => post('clearLogs'));

		const tools = mode === 'dashboard' ? [chips, search, ui.pauseBtn, clearBtn] : [];
		const node = card('logs', 'Live Logs', tools.length ? [el('div', { class: 'log-tools' }, tools)] : []);
		ui.logsCard = node;

		ui.logList = el('div', { class: 'log-list', role: 'log', 'aria-live': 'polite', tabindex: '0' });
		ui.logList.addEventListener('scroll', () => {
			const distance = ui.logList.scrollHeight - ui.logList.scrollTop - ui.logList.clientHeight;
			followLogs = distance < 24;
			ui.jumpBtn.hidden = followLogs;
		});
		ui.jumpBtn = el('button', { class: 'chip', type: 'button', text: 'Jump to latest' });
		ui.jumpBtn.hidden = true;
		ui.jumpBtn.addEventListener('click', () => {
			followLogs = true;
			ui.jumpBtn.hidden = true;
			ui.logList.scrollTop = ui.logList.scrollHeight;
		});
		ui.logNote = el('p', { class: 'card-note' });

		node.append(ui.logList, el('div', { class: 'log-foot' }, [ui.logNote, ui.jumpBtn]));
		return node;
	}

	function buildSkeleton() {
		const root = /** @type {HTMLElement} */ (document.getElementById('root'));
		clear(root);
		ui.banners = el('div', { class: 'grid' });

		if (mode === 'dashboard') {
			root.append(
				buildHero(),
				ui.banners,
				el('div', { class: 'grid row-top' }, [buildServiceCard('kvstream'), buildServiceCard('foundry'), buildActions()]),
				buildStats(),
				el('div', { class: 'grid row-mid' }, [buildThroughput(), buildDistribution(), buildHealth()]),
				buildLogs(),
			);
		} else {
			// The sidebar is a menu: everything else lives in the dashboard.
			root.append(buildHero(), buildNav());
		}
	}

	function focusLogs() {
		if (ui.logsCard) {
			ui.logsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
			ui.logList.focus({ preventScroll: true });
		}
	}

	// -- rendering --------------------------------------------------------

	/** @param {any} state */
	function renderHero(state) {
		const [word, tone] = SERVICE[/** @type {keyof typeof SERVICE} */ (state.service)] || ['Unknown', 'tone-idle'];
		ui.health.className = `health-badge ${tone}`;
		ui.health.lastChild.textContent = word;
		// The sidebar has no banners, so the reason rides on the badge.
		const firstError = state.errors[0];
		ui.health.title = firstError ? [firstError.message, firstError.hint].filter(Boolean).join('\n') : '';

		ui.autoSwitch.setAttribute('aria-checked', String(state.autoRefresh));
		if (state.lastSuccessAt) {
			const t = new Date(state.lastSuccessAt).toLocaleTimeString();
			ui.updatedTime.textContent = state.stale ? `${t} (stale)` : t;
		} else {
			ui.updatedTime.textContent = 'never';
		}
		ui.updated.className = state.stale ? 'updated stale' : 'updated';
		ui.updated.title = state.autoRefresh ? '' : 'Auto refresh is off; data will not update until you refresh.';
		ui.refresh.disabled = state.busy.length > 0;
	}

	/** @param {any} state */
	function renderBanners(state) {
		clear(ui.banners);
		for (const error of state.errors) {
			const b = el('div', { class: error.kind === 'offline' || error.kind === 'notice' ? 'banner' : 'banner error' }, [el('span', { text: error.message })]);
			if (error.hint) {
				b.append(el('span', { class: 'hint', text: error.hint }));
			}
			ui.banners.append(b);
		}
		if (state.service === 'degraded' && state.errors.length === 0) {
			// Say why, in KVStream's own words, and what to do about it.
			const noModel = state.backend === 'no_model';
			const message = noModel
				? 'Foundry Local is running, but no model is loaded, so KVStream has nothing to serve.'
				: 'KVStream is running, but the Foundry Local backend is not serving requests.';
			const hint =
				noModel && state.capabilities.canLoadModel
					? 'Use Quick Actions → Foundry Local → Load model… to load one.'
					: state.backendHint || 'Run a health check for KVStream’s own explanation.';
			const banner = el('div', { class: 'banner' }, [el('span', { text: message }), el('span', { class: 'hint', text: hint })]);
			if (state.backendHint) {
				banner.title = `KVStream: ${state.backendHint}`;
			}
			ui.banners.append(banner);
		}
		if (!state.autoRefresh) {
			ui.banners.append(el('div', { class: 'banner' }, [el('span', { text: 'Auto refresh is off. Figures are from the last sample.' })]));
		}
		ui.banners.hidden = ui.banners.childElementCount === 0;
	}

	/** @param {any} state */
	function renderServices(state) {
		const c = state.connection;
		setStatus(ui.kvstream.status, GATEWAY[/** @type {keyof typeof GATEWAY} */ (state.service)]);
		setText(ui.kvstream.url, c.gatewayUrl, c.gatewayUrl, 'mono');
		setText(ui.kvstream.version, c.gatewayVersion ? `v${c.gatewayVersion.replace(/^v/, '')}` : '');
		if (state.process.ownedByExtension && state.process.startedAt) {
			setText(ui.kvstream.uptime, formatDuration(Date.now() - state.process.startedAt));
		} else {
			setText(ui.kvstream.uptime, '', 'KVStream does not report its uptime. It is known only for a gateway started from this extension.');
		}

		setStatus(ui.foundry.status, BACKEND[/** @type {keyof typeof BACKEND} */ (state.backend)]);
		ui.foundry.status.title =
			state.backend === 'running'
				? 'The Foundry Local daemon is running (foundry server status). Whether it can serve is checked only through KVStream.'
				: '';
		setText(ui.foundry.url, c.backendUrl, c.backendUrl ? `${c.backendUrl} — ${c.backendUrlDetail || ''}` : c.backendUrlDetail, 'mono');
		const daemonDown = state.backend === 'stopped' || state.backend === 'starting';
		const noModel = state.backend === 'no_model';
		setText(
			ui.foundry.model,
			c.model || (noModel ? 'none loaded' : ''),
			c.model
				? `${c.model}${c.modelSource ? ` — ${c.modelSource}` : ''}`
				: daemonDown
					? c.backendUrlDetail
					: noModel
						? state.backendHint || 'Foundry Local has no model loaded'
						: 'No model determined',
			noModel ? 'warn-text' : '',
		);
		setText(ui.foundry.uptime, c.foundryUptime, c.foundryUptime ? 'From foundry server status' : 'Reported by the Foundry CLI only while the daemon is running');
	}

	/**
	 * Change over the last five minutes of a series, or `undefined` when the
	 * series does not reach back that far. Never extrapolated.
	 *
	 * @param {{t:number,v:number}[]} points
	 */
	function recentChange(points) {
		if (!points || points.length < 2) {
			return undefined;
		}
		const last = points[points.length - 1];
		const cutoff = last.t - 5 * 60 * 1000;
		const base = points.find((p) => p.t >= cutoff);
		if (!base || base === last) {
			return undefined;
		}
		return { delta: last.v - base.v, spanMs: last.t - base.t };
	}

	/**
	 * @param {any} refs
	 * @param {{t:number,v:number}[]} points
	 * @param {'neutral' | 'inverse'} tone  `inverse` colours a rise as a warning
	 *   (a growing queue); `neutral` shows direction only (running requests
	 *   going down is not a fault).
	 */
	function renderDelta(refs, points, tone) {
		const change = recentChange(points);
		if (!change) {
			refs.delta.className = 'delta flat';
			refs.delta.textContent = '';
			return;
		}
		const d = Math.round(change.delta);
		const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
		refs.delta.className = tone === 'inverse' ? `delta ${dir} inverse` : 'delta flat';
		refs.delta.textContent = `${d > 0 ? '↑' : d < 0 ? '↓' : '→'} ${Math.abs(d)}`;
		refs.delta.title = `Change over the last ${formatDuration(change.spanMs)}`;
	}

	/**
	 * @param {SVGSVGElement} svg
	 * @param {{t:number,v:number}[]} points
	 * @param {number} maxGapMs
	 */
	function renderSpark(svg, points, maxGapMs) {
		clear(svg);
		if (!points || points.length < 2) {
			return;
		}
		const t0 = points[0].t;
		const span = Math.max(1, points[points.length - 1].t - t0);
		const max = Math.max(...points.map((p) => p.v), 1e-9);
		let d = '';
		let pen = 'M';
		points.forEach((p, i) => {
			if (i > 0 && p.t - points[i - 1].t > maxGapMs) {
				pen = 'M';
			}
			d += `${pen}${(((p.t - t0) / span) * 100).toFixed(2)},${(20 - (p.v / max) * 18).toFixed(2)} `;
			pen = 'L';
		});
		svg.append(svgEl('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '1.5', 'vector-effect': 'non-scaling-stroke' }));
	}

	/**
	 * @param {any} refs
	 * @param {number | undefined} fraction
	 * @param {string} label
	 */
	function renderBar(refs, fraction, label) {
		if (typeof fraction === 'number' && Number.isFinite(fraction)) {
			const clamped = Math.max(0, Math.min(1, fraction));
			refs.fill.style.width = `${(clamped * 100).toFixed(1)}%`;
			refs.bar.setAttribute('aria-label', `${label} ${formatPercent(clamped)}`);
			refs.bar.hidden = false;
		} else {
			refs.bar.hidden = true;
		}
	}

	/** @param {any} state */
	function renderStats(state) {
		const s = ui.stats;
		const r = state.requests;
		const trends = state.trends;

		setMeasured(s.requests.value, r.totalRequests, formatCount, 'stat-value');
		// "Now" only while counters are live and the newest rate sample is
		// recent; otherwise a disconnected gateway would show its last rate.
		const lastRate = trends.throughput[trends.throughput.length - 1];
		const tput =
			r.totalRequests.value !== undefined && lastRate && Date.now() - lastRate.t <= trends.maxGapMs
				? lastRate.v
				: undefined;
		s.requests.sub.textContent = r.totalRequests.value === undefined ? 'requests total' : 'processed since gateway start';
		s.requests.delta.className = 'delta flat';
		s.requests.delta.textContent = tput === undefined ? '' : `${formatRate(tput)} now`;
		if (s.requests.spark) {
			renderSpark(s.requests.spark, trends.throughput, trends.maxGapMs);
		}

		setMeasured(s.running.value, r.running, formatCount, 'stat-value');
		s.running.sub.textContent = 'currently processing';
		renderDelta(s.running, r.running.value === undefined ? [] : trends.running, 'neutral');
		if (s.running.spark) {
			renderSpark(s.running.spark, trends.running, trends.maxGapMs);
		}

		setMeasured(s.queue.value, r.queued, formatCount, 'stat-value');
		s.queue.sub.textContent = 'waiting for admission';
		renderDelta(s.queue, r.queued.value === undefined ? [] : trends.queueDepth, 'inverse');
		if (s.queue.spark) {
			renderSpark(s.queue.spark, trends.queueDepth, trends.maxGapMs);
		}

		const b = state.budget;
		const unit = b.unit === 'tokens' ? 'tokens' : b.unit === 'concurrency' ? 'slots' : '';
		setMeasured(s.budget.value, b.utilization, formatPercent, 'stat-value');
		if (typeof b.used.value === 'number' && typeof b.total.value === 'number') {
			s.budget.sub.textContent = `${formatCount(b.used.value)} of ${formatCount(b.total.value)} ${unit} used`.trim();
		} else {
			s.budget.sub.textContent = 'estimate, not device memory';
		}
		s.budget.sub.title = state.budgetSource ? `Budget source: ${state.budgetSource}` : '';
		renderBar(s.budget, b.utilization.value, 'Admission budget');

		if (s.memory) {
			const res = state.resources;
			if (Number.isFinite(res.systemTotalBytes) && Number.isFinite(res.systemAvailableBytes) && res.systemTotalBytes > 0) {
				const used = (res.systemTotalBytes - res.systemAvailableBytes) / res.systemTotalBytes;
				s.memory.value.className = 'stat-value';
				s.memory.value.textContent = formatPercent(used);
				s.memory.value.removeAttribute('title');
				s.memory.sub.textContent = `of ${formatBytes(res.systemTotalBytes)} system RAM`;
				renderBar(s.memory, used, 'System memory');
			} else {
				setMeasured(s.memory.value, { reason: res.unavailableReason || 'not reported' }, formatPercent, 'stat-value');
				s.memory.sub.textContent = res.unavailableReason || 'not reported';
				renderBar(s.memory, undefined, '');
			}

			if (res.gpuName) {
				s.gpu.value.className = 'stat-value';
				s.gpu.value.textContent = Number.isFinite(res.gpuTotalBytes) ? formatBytes(res.gpuTotalBytes) : 'n/a';
				s.gpu.value.title = 'Total video memory';
				s.gpu.sub.textContent = res.gpuName;
				s.gpu.sub.title = res.gpuName;
				s.gpu.footer.textContent = 'VRAM total · utilisation not exposed by Foundry Local';
				s.gpu.footer.className = 'stat-foot card-note';
			} else {
				setMeasured(s.gpu.value, { reason: res.unavailableReason || 'not reported' }, formatCount, 'stat-value');
				s.gpu.sub.textContent = res.unavailableReason || 'not reported';
				s.gpu.footer.textContent = '';
			}
		}
	}

	/** Round up to a "nice" axis maximum. @param {number} v */
	function niceMax(v) {
		if (v <= 0) {
			return 1;
		}
		const exp = Math.pow(10, Math.floor(Math.log10(v)));
		for (const m of [1, 2, 2.5, 5, 10]) {
			if (m * exp >= v) {
				return m * exp;
			}
		}
		return 10 * exp;
	}

	/**
	 * The throughput chart, drawn at its real pixel size.
	 *
	 * A gap longer than `maxGapMs` starts a new sub-path: joining across a
	 * disconnect would draw a straight line through time when nothing was
	 * measured, which reads as a steady value rather than as missing data.
	 *
	 * @param {any} state
	 */
	function renderThroughput(state) {
		const host = ui.chartHost;
		if (!host) {
			return;
		}
		clear(host);
		const trends = state.trends;
		const end = Date.now();
		const start = end - rangeMs;
		const within = (/** @type {{t:number}[]} */ pts) => pts.filter((p) => p.t >= start);
		const processed = within(trends.throughput);
		const running = within(trends.running);

		if (processed.length < 2 && running.length < 2) {
			host.append(
				el('div', {
					class: 'chart-empty',
					text:
						state.service === 'healthy' || state.service === 'degraded'
							? 'Collecting samples… the chart appears after two metric polls.'
							: 'No samples. Throughput is charted once the gateway is reachable.',
				}),
			);
			return;
		}

		const width = Math.max(220, host.clientWidth);
		const height = Math.max(140, host.clientHeight);
		const pad = { l: 34, r: 8, t: 8, b: 22 };
		const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
		// An idle gateway still gets a readable 0–1 scale rather than ticks
		// too close together to label distinctly.
		const maxV = niceMax(Math.max(...processed.map((p) => p.v), ...running.map((p) => p.v), 1));
		const x = (/** @type {number} */ t) => pad.l + ((t - start) / rangeMs) * (width - pad.l - pad.r);
		const y = (/** @type {number} */ v) => height - pad.b - (Math.max(0, v) / maxV) * (height - pad.t - pad.b);

		for (let i = 0; i <= 4; i++) {
			const v = (maxV / 4) * i;
			const yy = y(v);
			svg.append(svgEl('line', { class: 'grid-line', x1: String(pad.l), x2: String(width - pad.r), y1: String(yy), y2: String(yy) }));
			const label = svgEl('text', { class: 'axis-label', x: String(pad.l - 6), y: String(yy + 4), 'text-anchor': 'end' });
			label.textContent = maxV < 4 ? String(Number(v.toFixed(2))) : String(Math.round(v));
			svg.append(label);
		}
		const ticks = 5;
		for (let i = 0; i <= ticks; i++) {
			const t = start + (rangeMs / ticks) * i;
			const label = svgEl('text', {
				class: 'axis-label',
				x: String(x(t)),
				y: String(height - 4),
				'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle',
			});
			label.textContent = formatShortClock(t);
			svg.append(label);
		}

		/** @param {{t:number,v:number}[]} pts @param {string} color @param {boolean} fill */
		const line = (pts, color, fill) => {
			if (pts.length < 2) {
				return;
			}
			let d = '';
			let pen = 'M';
			/** @type {string[]} */
			const segments = [];
			let segStart = 0;
			pts.forEach((p, i) => {
				if (i > 0 && p.t - pts[i - 1].t > trends.maxGapMs) {
					segments.push(`${segStart}:${i - 1}`);
					segStart = i;
					pen = 'M';
				}
				d += `${pen}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
				pen = 'L';
			});
			segments.push(`${segStart}:${pts.length - 1}`);
			if (fill) {
				for (const seg of segments) {
					const [a, b] = seg.split(':').map(Number);
					if (b <= a) {
						continue;
					}
					let area = `M${x(pts[a].t).toFixed(1)},${y(0).toFixed(1)} `;
					for (let i = a; i <= b; i++) {
						area += `L${x(pts[i].t).toFixed(1)},${y(pts[i].v).toFixed(1)} `;
					}
					area += `L${x(pts[b].t).toFixed(1)},${y(0).toFixed(1)} Z`;
					svg.append(svgEl('path', { d: area, fill: color, 'fill-opacity': '0.12', stroke: 'none' }));
				}
			}
			svg.append(svgEl('path', { d: d.trim(), fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round' }));
		};
		line(processed, 'var(--kv-blue)', true);
		line(running, 'var(--kv-purple)', false);

		const lastP = processed[processed.length - 1];
		svg.setAttribute(
			'aria-label',
			`Request throughput over the last ${formatDuration(rangeMs)}${lastP ? `, latest ${formatRate(lastP.v)}` : ''}`,
		);
		host.append(svg);
	}

	/** @param {any} state */
	function renderDistribution(state) {
		if (!ui.donutSvg) {
			return;
		}
		const byRoute = state.requests.byRoute || {};
		const entries = Object.entries(byRoute)
			.filter(([, v]) => typeof v === 'number' && v > 0)
			.sort((a, b) => b[1] - a[1]);
		const total = entries.reduce((acc, [, v]) => acc + v, 0);

		clear(ui.donutSvg);
		clear(ui.donutLegend);
		ui.donutSvg.append(svgEl('circle', { cx: '21', cy: '21', r: '15.9155', fill: 'none', stroke: 'var(--kv-track)', 'stroke-width': '5' }));

		if (state.requests.totalRequests.value === undefined) {
			ui.donutTotal.textContent = 'n/a';
			ui.donutTotal.title = state.requests.totalRequests.reason || '';
			ui.donutLegend.append(el('div', { class: 'empty', text: 'Request counters are not available.' }));
			return;
		}
		ui.donutTotal.textContent = formatCount(total);
		ui.donutTotal.removeAttribute('title');
		if (total === 0) {
			ui.donutLegend.append(el('div', { class: 'empty', text: 'No requests yet.' }));
			return;
		}

		let offset = 0;
		entries.forEach(([route, value], i) => {
			const pct = (value / total) * 100;
			const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
			ui.donutSvg.append(
				svgEl('circle', {
					cx: '21',
					cy: '21',
					r: '15.9155',
					fill: 'none',
					stroke: color,
					'stroke-width': '5',
					'stroke-dasharray': `${pct} ${100 - pct}`,
					'stroke-dashoffset': String(-offset),
				}),
			);
			offset += pct;
			const label = ROUTE_LABELS[/** @type {keyof typeof ROUTE_LABELS} */ (route)] || route;
			const swatch = el('i', { class: 'swatch' });
			swatch.style.setProperty('--accent', color);
			ui.donutLegend.append(
				el('div', { class: 'row', title: `${formatCount(value)} requests` }, [
					swatch,
					el('span', { class: 'truncate', text: label }),
					el('span', { class: 'pct', text: `${Math.round(pct)}%` }),
				]),
			);
		});
		ui.donutSvg.setAttribute('aria-label', `Requests by route: ${entries.map(([r, v]) => `${r} ${v}`).join(', ')}`);
	}

	/** @param {any} state */
	function renderHealthList(state) {
		if (!ui.healthRows) {
			return;
		}
		const c = state.connection;
		const rows = ui.healthRows;

		rows.kvstream.sub.textContent = c.gatewayUrl;
		setStatus(rows.kvstream.status, SERVICE[/** @type {keyof typeof SERVICE} */ (state.service)]);

		rows.foundry.sub.textContent = c.backendUrl || c.backendUrlDetail || 'no endpoint reported';
		rows.foundry.sub.title = c.backendUrlDetail || '';
		setStatus(rows.foundry.status, BACKEND[/** @type {keyof typeof BACKEND} */ (state.backend)]);

		const daemonDown = state.backend === 'stopped' || state.backend === 'starting';
		const noModel = state.backend === 'no_model';
		rows.model.sub.textContent = c.model || (daemonDown ? c.backendUrlDetail : noModel ? 'none loaded in Foundry Local' : 'none determined');
		rows.model.sub.title = c.modelSource || (noModel ? state.backendHint || '' : '');
		setStatus(
			rows.model.status,
			c.model
				? ['Loaded', 'tone-ok']
				: noModel
					? ['Not loaded', 'tone-warn']
					: daemonDown
						? ['Not loaded', 'tone-idle']
						: ['Unknown', 'tone-idle'],
		);

		rows.circuit.sub.textContent = 'fails fast after repeated backend errors';
		setStatus(rows.circuit.status, CIRCUIT[/** @type {keyof typeof CIRCUIT} */ (state.circuitBreakerState)], state.circuitBreakerState ? state.circuitBreakerState : 'n/a');

		const drift = state.driftState;
		rows.drift.sub.textContent = drift === 'unknown' ? 'inactive without a calibration record' : 'served speed vs calibration baseline';
		setStatus(
			rows.drift.status,
			// KVStream's drift states: `unknown`, `ok`, `degraded` (admission/drift.py).
			drift === 'ok' ? ['Normal', 'tone-ok'] : drift === 'degraded' ? ['Drifting', 'tone-warn'] : undefined,
			drift || 'n/a',
		);
	}

	/** @param {any} state */
	function renderActions(state) {
		const caps = state.capabilities;
		const busy = state.busy.length > 0;
		const a = ui.actions;
		/** @param {HTMLButtonElement} b @param {boolean} enabled @param {string} why @param {string} hint */
		const apply = (b, enabled, why, hint) => {
			b.disabled = busy || !enabled;
			b.title = !enabled ? `Unavailable: ${why}` : busy ? 'Another operation is in progress.' : hint;
		};
		apply(a.startService, caps.canStartKvstream, caps.reasons.canStartKvstream || '', 'Start `kvstream serve` as a child process of VS Code');
		apply(a.restartService, caps.canRestartKvstream, caps.reasons.canRestartKvstream || '', 'Restart the gateway started here');
		apply(a.stopService, caps.canStopKvstream, caps.reasons.canStopKvstream || '', 'Stop the gateway started here');
		apply(a.calibrate, caps.calibrate, '', 'Run `kvstream calibrate` in a terminal');
		apply(a.checkHealth, true, '', 'Force a fresh readiness probe (/health?probe=true)');
		a.openLogs.disabled = false;
		for (const key of ['startFoundry', 'restartFoundry', 'stopFoundry']) {
			apply(a[key], caps.canControlFoundry, caps.reasons.canControlFoundry || '', `foundry server ${key.replace('Foundry', '').toLowerCase()}`);
		}
		apply(a.loadFoundryModel, caps.canLoadModel, caps.reasons.canLoadModel || '', 'Choose a downloaded model and run `foundry model load`');
		// Nothing can be served until a model is loaded: make the way out obvious.
		a.loadFoundryModel.classList.toggle('solid-blue', state.backend === 'no_model' && caps.canLoadModel);

		let note = '';
		if (state.process.state === 'running' && state.process.ownedByExtension) {
			note = `Gateway started from VS Code (pid ${state.process.pid || 'unknown'}). It stops when VS Code closes.`;
		} else if (state.process.state === 'exited' && state.process.exitDetail) {
			note = `Last gateway process ${state.process.exitDetail}.`;
		} else if (!caps.canStopKvstream && (state.service === 'healthy' || state.service === 'degraded')) {
			note = 'This gateway was started outside VS Code, so Stop and Restart are unavailable.';
		}
		ui.actionsNote.textContent = note;
		ui.actionsNote.hidden = note === '';
	}

	function renderLogs() {
		const list = ui.logList;
		const needle = logSearch.toLowerCase();
		const visible = logEntries.filter(
			(e) => (logLevel === 'all' || e.level === logLevel) && (needle === '' || e.message.toLowerCase().includes(needle)),
		);

		clear(list);
		if (visible.length === 0) {
			list.append(
				el('div', {
					class: 'empty',
					text:
						logEntries.length === 0
							? 'No log lines yet. KVStream has no logs endpoint, so live output appears here only for a gateway started with Start.'
							: 'No lines match the current filter.',
				}),
			);
		} else {
			for (const entry of visible.slice(-500)) {
				list.append(
					el('div', { class: `log-line level-${entry.level}` }, [
						el('span', { class: 'ts', text: formatClock(entry.t) }),
						el('span', { class: 'lvl', text: entry.level }),
						el('span', { text: entry.message }),
					]),
				);
			}
		}

		const notes = [];
		if (logPaused) {
			notes.push('Paused.');
		}
		if (logTruncated) {
			notes.push('Older lines dropped to keep memory bounded.');
		}
		ui.logNote.textContent = notes.join(' ');
		if (followLogs) {
			list.scrollTop = list.scrollHeight;
		}
	}

	/** @param {any} state */
	function render(state) {
		model = state;
		renderHero(state);
		if (mode === 'sidebar') {
			return;
		}
		renderBanners(state);
		renderServices(state);
		renderStats(state);
		renderThroughput(state);
		renderDistribution(state);
		renderHealthList(state);
		renderActions(state);
	}

	// -- message loop -----------------------------------------------------

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || typeof message.type !== 'string') {
			return;
		}
		if (message.type === 'state') {
			render(message.state);
		} else if (mode === 'sidebar') {
			// The sidebar shows no logs; the host does not send them, but a
			// stray message must not reach renderers that were never built.
			return;
		} else if (message.type === 'logs') {
			if (message.append) {
				logEntries = logEntries.concat(message.entries).slice(-5000);
			} else {
				logEntries = message.entries || [];
				logTruncated = Boolean(message.truncated);
			}
			renderLogs();
		} else if (message.type === 'focus' && message.section === 'logs') {
			focusLogs();
		}
	});

	// Uptime and the chart's time axis move even when no new sample arrives.
	if (mode === 'dashboard') {
		setInterval(() => {
			if (model) {
				renderServices(model);
				renderThroughput(model);
			}
		}, 5000);
	}

	buildSkeleton();
	if (mode === 'dashboard') {
		renderLogs();
	}
	post('ready');
})();
