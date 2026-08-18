import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A system proxy discovered from the current OS, outside any env vars. */
export interface SystemProxy {
	readonly url: string;
	/** Hosts that must bypass the proxy, exactly as the OS reports them. */
	readonly bypass?: string[];
	readonly source: "darwin" | "win32" | "linux";
}

interface Logger {
	debug?: (message: string) => void;
	warn: (message: string) => void;
}

function parseKeyValue(output: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of output.split("\n")) {
		const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
		if (match?.[1] && match[2] !== undefined) map.set(match[1], match[2]);
	}
	return map;
}

/** macOS: `scutil --proxy` — HTTP/HTTPS/SOCKS flags with ports and bypass list. */
export async function darwinSystemProxy(logger?: Logger): Promise<SystemProxy | undefined> {
	try {
		const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], {
			timeout: 3000,
		});
		const values = parseKeyValue(stdout);

		// scutil prints the bypass list as a nested array whose items are bare
		// numeric lines ("0 : 127.0.0.1") after the ExceptionsList header.
		const lines = stdout.split("\n");
		const bypass: string[] = [];
		let inExceptions = false;
		for (const line of lines) {
			if (line.includes("ExceptionsList")) {
				inExceptions = true;
				continue;
			}
			const item = line.match(/^\s*\d+\s*:\s*(.+?)\s*$/);
			if (inExceptions && item?.[1]) {
				bypass.push(item[1]);
			} else if (inExceptions && /^[A-Za-z]/.test(line.trim())) {
				inExceptions = false;
			}
		}

		const candidates: Array<{ flag: string; host: string; port: string }> = [
			{ flag: "HTTPSEnable", host: "HTTPSProxy", port: "HTTPSPort" },
			{ flag: "HTTPEnable", host: "HTTPProxy", port: "HTTPPort" },
			{ flag: "SOCKSEnable", host: "SOCKSProxy", port: "SOCKSPort" },
		];
		for (const { flag, host, port } of candidates) {
			if (values.get(flag) === "1") {
				const hostname = values.get(host);
				const portValue = values.get(port);
				if (hostname && portValue) {
					const scheme = flag.startsWith("SOCKS") ? "socks5" : "http";
					return {
						url: `${scheme}://${hostname}:${portValue}`,
						bypass,
						source: "darwin",
					};
				}
			}
		}
		return undefined;
	} catch (error) {
		logger?.debug?.(`darwin proxy discovery failed: ${String(error)}`);
		return undefined;
	}
}

/** Windows: registry Internet Settings — ProxyEnable/ProxyServer/ProxyOverride. */
export async function win32SystemProxy(logger?: Logger): Promise<SystemProxy | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"reg",
			[
				"query",
				"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
				"/v",
				"ProxyEnable",
				"/v",
				"ProxyServer",
				"/v",
				"ProxyOverride",
			],
			{ timeout: 3000, windowsHide: true },
		);
		// reg query lines look like: "    ProxyServer    REG_SZ    http=…";
		// strip the value type and keep the trailing value.
		const values = new Map<string, string>();
		for (const line of stdout.split("\n")) {
			const match = line.match(/^\s*([A-Za-z0-9_-]+)\s+REG_\w+\s+(.+?)\s*$/);
			if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2]);
		}
		if (values.get("ProxyEnable") !== "0x1") return undefined;
		const server = values.get("ProxyServer")?.trim();
		if (!server) return undefined;

		// "http=host:port;https=host:port" style entries pick the https proxy first.
		let url: string | undefined;
		for (const part of server.split(";")) {
			const match = part.match(/^(https?)=(.+)$/);
			if (match) {
				if (match[1] === "https" || url === undefined) url = match[2];
			} else if (url === undefined) {
				url = part;
			}
		}
		if (!url) return undefined;
		if (!/^https?:\/\//.test(url)) url = `http://${url}`;
		return {
			url,
			bypass: (values.get("ProxyOverride") ?? "")
				.split(";")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0 && entry !== "<local>"),
			source: "win32",
		};
	} catch (error) {
		logger?.debug?.(`win32 proxy discovery failed: ${String(error)}`);
		return undefined;
	}
}

/** Linux: GNOME gsettings (environment variables are handled by the env agent). */
export async function linuxSystemProxy(logger?: Logger): Promise<SystemProxy | undefined> {
	try {
		const { stdout } = await execFileAsync("gsettings", ["get", "org.gnome.system.proxy", "mode"], {
			timeout: 3000,
		});
		if (stdout.trim() !== "'manual'") return undefined;

		const [hostResult, portResult] = await Promise.all([
			execFileAsync("gsettings", ["get", "org.gnome.system.proxy.http", "host"], {
				timeout: 3000,
			}).catch(() => ({ stdout: "''" })),
			execFileAsync("gsettings", ["get", "org.gnome.system.proxy.http", "port"], {
				timeout: 3000,
			}).catch(() => ({ stdout: "0" })),
		]);
		const host = hostResult.stdout.trim().replace(/^'|'$/g, "");
		const port = portResult.stdout.trim();
		if (!host || port === "0") return undefined;

		const { stdout: bypassStdout } = await execFileAsync(
			"gsettings",
			["get", "org.gnome.system.proxy", "ignore-hosts"],
			{ timeout: 3000 },
		).catch(() => ({ stdout: "[]" }));

		const bypass = [...bypassStdout.matchAll(/'([^']+)'/g)]
			.map((match) => match[1] ?? "")
			.filter((value) => value.length > 0);
		return { url: `http://${host}:${port}`, bypass, source: "linux" };
	} catch (error) {
		logger?.debug?.(`linux proxy discovery failed: ${String(error)}`);
		return undefined;
	}
}

/** Read the current OS system proxy (no Electron, no env vars). */
export async function resolveSystemProxy(logger?: Logger): Promise<SystemProxy | undefined> {
	switch (process.platform) {
		case "darwin":
			return darwinSystemProxy(logger);
		case "win32":
			return win32SystemProxy(logger);
		case "linux":
			return linuxSystemProxy(logger);
		default:
			return undefined;
	}
}
