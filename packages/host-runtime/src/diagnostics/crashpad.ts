/**
 * Crashpad configuration for diagnostics v1.
 *
 * Crashpad is enabled locally with uploads permanently disabled: no
 * `submitURL`, no dynamic extra, no attachments — only the fixed
 * `globalExtra` (`diagnostics_schema: "1"`, `launch_id`). `compress` and
 * `rateLimit` only constrain uploads, which never happen, so they are not
 * configured. The per-launch crash dump directory is created first because
 * `app.setPath` rejects nonexistent directories.
 *
 * NOTE: minidumps may contain fragments of process memory (dialogue, prompts,
 * file contents, credentials). They are never uploaded and never included in
 * normal diagnostic exports; the privacy declaration for JSONL (metadata
 * only) must stay separate from Crashpad.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CrashpadApp {
	setPath(name: "crashDumps", path: string): void;
}

export interface CrashpadReporter {
	start(options: { uploadToServer: boolean; globalExtra: Record<string, string> }): void;
}

export interface CrashpadOptions {
	app: CrashpadApp;
	reporter: CrashpadReporter;
	/** Diagnostics root; the launch dir is `<root>/crashes/<launchId>`. */
	root: string;
	launchId: string;
}

/** Configures Crashpad and returns the per-launch crash dump directory. */
export function configureCrashpad(options: CrashpadOptions): string {
	const launchCrashDir = join(options.root, "crashes", options.launchId);
	mkdirSync(launchCrashDir, { recursive: true, mode: 0o700 });
	options.app.setPath("crashDumps", launchCrashDir);
	options.reporter.start({
		uploadToServer: false,
		globalExtra: { diagnostics_schema: "1", launch_id: options.launchId },
	});
	return launchCrashDir;
}
