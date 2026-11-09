import { WEBVIEW_ACTIONS, type WebviewAction, type WebviewMessage } from '../types/messages';
import { LOG_LEVELS, type LogLevel } from '../types/messages';

/**
 * Validation for everything arriving from a webview.
 *
 * A webview is a browser context: its script is ours today, but the boundary
 * is the only thing standing between rendered service output and the
 * extension host, where process spawning lives. So the host trusts nothing
 * that crosses it. Only the names in `WEBVIEW_ACTIONS` are recognised, and
 * each payload is checked against the shape that action expects — an action
 * with an unexpected payload is rejected outright rather than coerced.
 */

type PayloadAction = 'setLogPaused' | 'setLogFilter' | 'setAutoRefresh';

export type ValidatedMessage =
	| { action: Exclude<WebviewAction, PayloadAction> }
	| { action: 'setLogPaused'; paused: boolean }
	| { action: 'setAutoRefresh'; enabled: boolean }
	| { action: 'setLogFilter'; search: string; levels: LogLevel[] };

export interface ValidationFailure {
	error: string;
}

const ACTION_SET = new Set<string>(WEBVIEW_ACTIONS);

/** Longest free-text search accepted; anything longer is a mistake or an attack. */
const MAX_SEARCH_LENGTH = 200;

export function validateMessage(raw: unknown): ValidatedMessage | ValidationFailure {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { error: 'message was not an object' };
	}
	const candidate = raw as Partial<WebviewMessage>;
	const action = candidate.action;
	if (typeof action !== 'string' || !ACTION_SET.has(action)) {
		return { error: `unknown action ${JSON.stringify(action)}` };
	}

	if (action === 'setLogPaused') {
		const payload = candidate.payload;
		if (typeof payload !== 'boolean') {
			return { error: 'setLogPaused expects a boolean payload' };
		}
		return { action, paused: payload };
	}

	if (action === 'setAutoRefresh') {
		const payload = candidate.payload;
		if (typeof payload !== 'boolean') {
			return { error: 'setAutoRefresh expects a boolean payload' };
		}
		return { action, enabled: payload };
	}

	if (action === 'setLogFilter') {
		const payload = candidate.payload;
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
			return { error: 'setLogFilter expects an object payload' };
		}
		const { search, levels } = payload as { search?: unknown; levels?: unknown };
		if (search !== undefined && typeof search !== 'string') {
			return { error: 'setLogFilter.search must be a string' };
		}
		if (typeof search === 'string' && search.length > MAX_SEARCH_LENGTH) {
			return { error: 'setLogFilter.search is too long' };
		}
		let parsedLevels: LogLevel[] = [...LOG_LEVELS];
		if (levels !== undefined) {
			if (!Array.isArray(levels)) {
				return { error: 'setLogFilter.levels must be an array' };
			}
			parsedLevels = levels.filter((level): level is LogLevel =>
				(LOG_LEVELS as readonly string[]).includes(level as string),
			);
		}
		return { action, search: typeof search === 'string' ? search : '', levels: parsedLevels };
	}

	if (candidate.payload !== undefined) {
		return { error: `${action} does not take a payload` };
	}
	return { action: action as Exclude<WebviewAction, PayloadAction> };
}

export function isFailure(value: ValidatedMessage | ValidationFailure): value is ValidationFailure {
	return 'error' in value;
}
