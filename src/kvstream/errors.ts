/** Classification of everything that can go wrong talking to the gateway. */
export type RequestErrorKind =
	/** Nothing is listening, DNS failed, or the connection was refused. */
	| 'offline'
	/** The request exceeded its deadline, or was cancelled by a newer poll. */
	| 'timeout'
	/** The gateway answered, with a status we did not expect. */
	| 'http'
	/** The body was not JSON, or not the shape the endpoint documents. */
	| 'schema'
	/** The configured URL or an executable path is unusable. */
	| 'config';

export class RequestError extends Error {
	constructor(
		readonly kind: RequestErrorKind,
		message: string,
		readonly status?: number,
		readonly hint?: string,
	) {
		super(message);
		this.name = 'RequestError';
	}
}

const CONNECTION_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ENOTFOUND',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EAI_AGAIN',
	'EPIPE',
	'UND_ERR_SOCKET',
	'UND_ERR_CONNECT_TIMEOUT',
]);

function codeOf(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) {
		return undefined;
	}
	const candidate = error as { code?: unknown; cause?: unknown };
	if (typeof candidate.code === 'string') {
		return candidate.code;
	}
	// undici nests the real cause one level down on a failed fetch.
	return candidate.cause ? codeOf(candidate.cause) : undefined;
}

/**
 * Turn whatever `fetch` threw into something the UI can act on.
 *
 * The distinction that matters is refused-versus-timed-out: a refused
 * connection means the gateway is not running and the user should start it,
 * while a timeout means something answered but did not finish, which is the
 * signature of a stalled backend and calls for a different hint.
 */
export function classifyFetchError(error: unknown, url: string): RequestError {
	const name = error instanceof Error ? error.name : '';
	if (name === 'TimeoutError' || name === 'AbortError') {
		return new RequestError(
			'timeout',
			`No response from ${url} within the request timeout`,
			undefined,
			'The gateway may be busy or stalled. Raise kvstream.requestTimeout if this is expected.',
		);
	}
	const code = codeOf(error);
	if (code && CONNECTION_CODES.has(code)) {
		return new RequestError(
			'offline',
			`Cannot reach ${url} (${code})`,
			undefined,
			'Start the gateway with `kvstream serve`, or point kvstream.url at the right address.',
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	return new RequestError('offline', `Cannot reach ${url}: ${message}`);
}
