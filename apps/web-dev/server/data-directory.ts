import { homedir } from "node:os";
import { resolve } from "node:path";

interface DataDirectoryEnvironment {
	APPDATA?: string;
	XDG_CONFIG_HOME?: string;
}

export function desktopDataDirectory(
	name: string,
	override = process.env.BEAR_WEB_DEV_DATA_DIR,
	platform = process.platform,
	environment: DataDirectoryEnvironment = process.env,
	home = homedir(),
): string {
	if (override) return resolve(override);
	if (platform === "win32") {
		return resolve(environment.APPDATA ?? resolve(home, "AppData", "Roaming"), name);
	}
	if (platform === "darwin") {
		return resolve(home, "Library", "Application Support", name);
	}
	return resolve(environment.XDG_CONFIG_HOME ?? resolve(home, ".config"), name);
}
