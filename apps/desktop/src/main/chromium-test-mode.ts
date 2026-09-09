export interface ChromiumTestModeApp {
	commandLine: { appendSwitch(name: string): void };
	disableHardwareAcceleration(): void;
}

/** Configure Chromium before app readiness for source and packaged automation. */
export function configureChromiumTestMode(app: ChromiumTestModeApp, enabled: boolean): void {
	if (!enabled) return;
	app.commandLine.appendSwitch("use-mock-keychain");
	app.commandLine.appendSwitch("disable-gpu");
	app.disableHardwareAcceleration();
}
