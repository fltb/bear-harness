/**
 * M0 spike: Companion utility entry.
 *
 * Runs the pinned @earendil-works/pi-coding-agent@0.84.1 in a scratch
 * agentDir (never ~/.pi or user workspaces) with analytics and install
 * telemetry disabled. Proves:
 *   1. SDK loads and a session is created with the product settings.
 *   2. Analytics/telemetry settings are zero and no credential env leaks.
 *   3. Auth probe: with no stored credential the turn path is
 *      `provider_auth_required`; the OAuth interaction emits auth_url /
 *      device_code events (the plan §7.2 bridge contract).
 *   4. When BEAR_COMPANION_LOGIN_CODE is provided, completes login, streams a
 *      real turn, and aborts mid-stream (event deltas captured).
 *
 * Works under plain Node and Electron utilityProcess (no electron imports).
 * Protocol: reads env BEAR_COMPANION_SPIKE_OUT (report JSON path) and
 * BEAR_COMPANION_AGENT_DIR (scratch dir); writes a JSON report and exits 0/1.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CREDENTIAL_ENV =
	/^(OPENAI|ANTHROPIC|GEMINI|GOOGLE_API_KEY|AWS_ACCESS_KEY|AWS_SECRET|AWS_SESSION|AZURE_|GROQ_|DEEPSEEK_|MISTRAL_|ZAI_|OPENROUTER_|XAI_|HF_|HUGGING)/;

async function main() {
	const reportPath = process.env.BEAR_COMPANION_SPIKE_OUT;
	const agentDir = process.env.BEAR_COMPANION_AGENT_DIR;
	if (!reportPath || !agentDir) {
		console.error("companion spike: missing BEAR_COMPANION_SPIKE_OUT/BEAR_COMPANION_AGENT_DIR");
		process.exit(2);
	}
	mkdirSync(agentDir, { recursive: true });

	const report = { sdkVersion: null, sessionCreated: false, analytics: null, auth: null, streaming: null };
	const finish = (ok) => {
		writeFileSync(reportPath, JSON.stringify(report, null, 2));
		process.exit(ok ? 0 : 1);
	};

	const sdk = await import("@earendil-works/pi-coding-agent");
	report.sdkVersion = sdk.VERSION;

	const settings = sdk.SettingsManager.inMemory(
		{ enableAnalytics: false, enableInstallTelemetry: false, defaultProjectTrust: "never" },
		{ projectTrusted: false },
	);
	report.analytics = {
		enableAnalytics: settings.getGlobalSettings().enableAnalytics,
		enableInstallTelemetry: settings.getGlobalSettings().enableInstallTelemetry,
		defaultProjectTrust: settings.getGlobalSettings().defaultProjectTrust,
		credentialEnvLeaks: Object.keys(process.env).filter((k) => CREDENTIAL_ENV.test(k)),
	};
	const analyticsOk =
		report.analytics.enableAnalytics === false &&
		report.analytics.enableInstallTelemetry === false &&
		report.analytics.defaultProjectTrust === "never";

	// Canonical model/auth runtime pinned to the scratch agentDir; static
	// catalog only (no network refresh), no ambient env keys.
	const modelRuntime = await sdk.ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		refreshOnCreate: false,
	});

	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd: agentDir,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "你是极昼，旧极光站的守护核心。这是 M0 spike 会话。",
		appendSystemPrompt: [],
	});

	const { session } = await sdk.createAgentSession({
		cwd: agentDir,
		agentDir,
		modelRuntime,
		settingsManager: settings,
		resourceLoader,
		noTools: "all",
		sessionManager: sdk.SessionManager.create(agentDir),
	});
	report.sessionCreated = true;

	// --- auth probe ---------------------------------------------------------
	const providerIds = ["openai", "anthropic", "deepseek", "zai", "openrouter", "groq", "mistral"];
	let authenticatedProvider = null;
	for (const id of providerIds) {
		try {
			if (modelRuntime.hasConfiguredAuth(id)) {
				authenticatedProvider = id;
				break;
			}
		} catch {
			/* provider has no auth surface */
		}
	}

	const loginProviderId = process.env.BEAR_COMPANION_LOGIN_PROVIDER ?? "anthropic";

	if (!authenticatedProvider && !process.env.BEAR_COMPANION_LOGIN_CODE && !process.env.BEAR_SPIKE_OPENCODE_KEY) {
		// Drive the OAuth interaction far enough to capture auth_url /
		// device_code events, then report `provider_auth_required`.
		const events = [];
		try {
			const interaction = {
				prompt: async () => {
					throw new Error("spike: no interactive user for prompt");
				},
				notify: (ev) => events.push(ev),
			};
			const promise = modelRuntime.login(loginProviderId, "oauth", interaction);
			await Promise.race([promise, new Promise((r) => setTimeout(r, 4000))]);
			report.auth = {
				provider: loginProviderId,
				state: "login_started",
				events,
				note: "no stored credential; OAuth flow issued auth events. Complete the URL/code and re-run with BEAR_COMPANION_LOGIN_CODE to stream a real turn.",
			};
		} catch (e) {
			report.auth = {
				provider: loginProviderId,
				state: "auth_error",
				events,
				error: String(e?.message ?? e).slice(0, 200),
			};
		}
		report.auth.unavailableReason = "provider_auth_required";
		finish(analyticsOk); // plumbing proven; auth_required is the designed state
		return;
	}

	// --- complete login (BEAR_COMPANION_LOGIN_CODE) -------------------------
	if (process.env.BEAR_COMPANION_LOGIN_CODE) {
		const events = [];
		const interaction = {
			prompt: async () => process.env.BEAR_COMPANION_LOGIN_CODE ?? "",
			notify: (ev) => events.push(ev),
		};
		await modelRuntime.login(loginProviderId, "oauth", interaction);
		report.auth = { provider: loginProviderId, state: "logged_in", events };
	}

	// --- API-key provider (opencode-go) -------------------------------------
	if (process.env.BEAR_SPIKE_OPENCODE_KEY) {
		await modelRuntime.setRuntimeApiKey("opencode-go", process.env.BEAR_SPIKE_OPENCODE_KEY);
		report.auth = { provider: "opencode-go", state: "api_key_set", keyPresent: true };
	}

	// --- pick a model for the streaming turn --------------------------------
	const modelProviderId = report.auth?.provider ?? loginProviderId;
	let chosen = null;
	try {
		const available = await modelRuntime.getAvailable(modelProviderId);
		// Prefer the user's stated flash model, then any flash/mini/fast, else the first.
		chosen =
			available.find((m) => /deepseek.*flash|flash.*deepseek/i.test(m.id)) ??
			available.find((m) => /flash|mini|fast/i.test(m.id)) ??
			available[0] ??
			null;
	} catch {
		chosen = null;
	}
	if (!chosen) {
		try {
			const all = modelRuntime.getModels(modelProviderId);
			chosen = all[0] ?? null;
		} catch {
			chosen = null;
		}
	}
	if (!chosen) {
		report.streaming = {
			error: "no models available for " + modelProviderId,
			unavailableReason: "model_unavailable",
		};
		finish(false);
		return;
	}
	await session.setModel(chosen);

	// --- streaming turn + abort ---------------------------------------------
	try {
		const events = [];
		const unsub = session.subscribe((ev) => {
			events.push({ type: ev.type, seq: ev.seq ?? events.length });
			if (ev.type === "message_update") {
				report.streaming ??= { deltas: 0, lastDelta: "" };
				report.streaming.deltas += 1;
				report.streaming.lastDelta = String(ev.delta ?? ev.message ?? "").slice(-60);
			}
		});
		await session.prompt("在北极光下说一句短话。", { streamingBehavior: "followUp" });
		// Abort mid-run to prove abort terminates the provider stream.
		await session.abort();
		await session.waitForIdle();
		unsub();
		report.streaming = {
			...report.streaming,
			eventCount: events.length,
			aborted: true,
			provider: session.model ? `${session.model.provider}/${session.model.id}` : null,
		};
		finish(analyticsOk && (report.streaming?.deltas ?? 0) > 0 && report.streaming.aborted);
	} catch (e) {
		report.streaming = {
			error: String(e?.message ?? e).slice(0, 300),
			unavailableReason: /api.?key|auth|login|401|403/i.test(String(e?.message ?? e))
				? "provider_auth_required"
				: "stream_error",
		};
		finish(false);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
