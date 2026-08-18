// @vitest-environment node

import { execFile } from "node:child_process";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProxyConfig } from "../src/network/proxy-config.js";

// system-proxy.ts calls `promisify(execFile)` at module load; the mock must be
// in callback style so the promisified wrapper resolves. Outputs switch per
// test through `proxyOutput`, or per-call through `proxyResponder` (Linux
// gsettings makes multiple calls with different arguments).
let proxyOutput = "";
let proxyResponder: ((args: string[]) => string) | undefined;
vi.mock("node:child_process", () => ({
	execFile: vi.fn(
		(
			_file: string,
			args: string[],
			_opts: unknown,
			callback: (err: unknown, result: unknown) => void,
		) => {
			callback(null, { stdout: proxyResponder ? proxyResponder(args) : proxyOutput, stderr: "" });
		},
	),
}));

const originalDispatcher = getGlobalDispatcher();

beforeEach(() => {
	vi.clearAllMocks();
	setGlobalDispatcher(originalDispatcher);
});

afterEach(() => {
	setGlobalDispatcher(originalDispatcher);
});

describe("platform system proxy resolvers", () => {
	it("parses macOS scutil output with HTTPS priority and bypass list", async () => {
		proxyOutput = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
  }
}`;
		const { darwinSystemProxy } = await import("../src/network/system-proxy.js");
		const proxy = await darwinSystemProxy();
		expect(proxy?.url).toBe("http://127.0.0.1:7890");
		expect(proxy?.bypass).toEqual(["127.0.0.1", "localhost"]);
	});

	it("parses Windows registry output with per-protocol entries", async () => {
		proxyOutput = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890
    ProxyOverride  REG_SZ    localhost;127.0.0.1;<local>`;
		const { win32SystemProxy } = await import("../src/network/system-proxy.js");
		const proxy = await win32SystemProxy();
		expect(proxy?.url).toBe("http://127.0.0.1:7890");
		expect(proxy?.bypass).toEqual(["localhost", "127.0.0.1"]);
	});

	it("returns undefined when Windows proxy is disabled", async () => {
		proxyOutput = `    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    `;
		const { win32SystemProxy } = await import("../src/network/system-proxy.js");
		expect(await win32SystemProxy()).toBeUndefined();
	});

	it("parses GNOME gsettings manual proxy on Linux", async () => {
		proxyResponder = (args: string[]) => {
			if (args.includes("mode")) return "'manual'";
			if (args.includes("ignore-hosts")) return "['localhost', '127.0.0.1']";
			if (args[2] === "host") return "'127.0.0.1'";
			if (args[2] === "port") return "7890";
			return "";
		};
		const { linuxSystemProxy } = await import("../src/network/system-proxy.js");
		const proxy = await linuxSystemProxy();
		expect(proxy?.url).toBe("http://127.0.0.1:7890");
		expect(proxy?.bypass).toEqual(["localhost", "127.0.0.1"]);
		proxyResponder = undefined;
	});
});

describe("proxy injection", () => {
	it("leaves the dispatcher untouched in direct mode", async () => {
		await applyProxyConfig({ mode: "direct" });
		expect(getGlobalDispatcher()).toBe(originalDispatcher);
	});

	it("injects an EnvHttpProxyAgent for manual mode", async () => {
		await applyProxyConfig({
			mode: "manual",
			url: "http://127.0.0.1:7890",
			bypass: ["*.internal"],
		});
		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
	});

	it("prefers the Electron resolver result over the platform resolver", async () => {
		const systemProxy = vi.fn(async () => ({
			url: "http://platform-proxy:8080",
			source: "linux" as const,
		}));
		await applyProxyConfig(
			{ mode: "auto" },
			{ resolve: async () => "http://electron-proxy:3128", systemProxy },
		);
		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
		expect(systemProxy).not.toHaveBeenCalled();
	});

	it("falls back to the platform resolver when Electron returns DIRECT", async () => {
		const systemProxy = vi.fn(async () => ({
			url: "http://platform-proxy:8080",
			source: "linux" as const,
		}));
		await applyProxyConfig({ mode: "auto" }, { resolve: async () => "DIRECT", systemProxy });
		expect(systemProxy).toHaveBeenCalledOnce();
		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
	});

	it("reinstates the environment agent when nothing is resolved", async () => {
		await applyProxyConfig({ mode: "auto" }, { systemProxy: async () => undefined });
		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
	});

	it("throws when manual mode has no URL", async () => {
		await expect(applyProxyConfig({ mode: "manual" })).rejects.toThrow("requires a proxy URL");
	});
});
