import * as vscode from 'vscode';

/** 128 bits of entropy, hex-encoded, fresh for every document. */
export function createNonce(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type ViewMode = 'sidebar' | 'dashboard';

/**
 * The document both views load.
 *
 * Content Security Policy, from the most restrictive base outwards:
 *   default-src 'none'   nothing loads unless named below
 *   script-src  nonce    only the one bundle we emit; no inline handlers,
 *                        no eval, no CDN
 *   style-src   cspSource + 'unsafe-inline'  the stylesheet, plus the inline
 *                        styles the chart code sets for bar widths. No remote
 *                        origin is allowed, so this cannot load third-party CSS.
 *   img-src     cspSource + data:  local icons and inline SVG data URIs
 *   connect-src 'none'   the webview never talks to the network; every HTTP
 *                        request happens in the extension host
 */
export function renderHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	mode: ViewMode,
): string {
	const nonce = createNonce();
	const asset = (...parts: string[]): vscode.Uri =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts));

	const styleUri = asset('media', 'dashboard.css');
	const scriptUri = asset('media', 'dashboard.js');

	const csp = [
		"default-src 'none'",
		`img-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`font-src ${webview.cspSource}`,
		`script-src 'nonce-${nonce}'`,
		"connect-src 'none'",
	].join('; ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>KVStream Monitor</title>
</head>
<body class="mode-${mode}" data-mode="${mode}">
<div id="root" role="region" aria-label="KVStream Monitor">
  <div class="boot">Loading KVStream Monitor…</div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
