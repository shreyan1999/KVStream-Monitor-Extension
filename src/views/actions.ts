/**
 * Everything a view may ask the extension to do.
 *
 * Implemented once in `commands/serviceCommands.ts` so a button in the
 * sidebar, a button in the dashboard and a Command Palette entry all run the
 * same code — including the same confirmations.
 */
export interface MonitorActions {
	refresh(): void;
	checkHealth(): Promise<void>;
	configureEndpoint(): Promise<void>;
	openDashboard(): void;
	openOutput(): void;
	openSettings(): void;
	/** Open the dashboard scrolled to its live-log panel. */
	openLogs(): void;
	setAutoRefresh(enabled: boolean): void;
	startService(): Promise<void>;
	stopService(): Promise<void>;
	restartService(): Promise<void>;
	startFoundry(): Promise<void>;
	stopFoundry(): Promise<void>;
	restartFoundry(): Promise<void>;
	/** Pick a downloaded model and `foundry model load` it. */
	loadFoundryModel(): Promise<void>;
	calibrate(): Promise<void>;
}
