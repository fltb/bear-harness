/** Installation settings endpoints; Run data never enters this service. */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { CacheKey, RPC } from "@bear-harness/protocol/schema";
import type { SystemCompositionContext } from "../composition.js";
import type { Dispatcher } from "../dispatcher.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CustomAcpAdapter } from "./custom-adapter.js";
import { PiAcpAdapter } from "./pi-adapter.js";
import { RunnerProfiles } from "./profiles.js";

export function registerRunnerHandlers(
	dispatcher: Dispatcher,
	context: SystemCompositionContext,
): void {
	const profiles = new RunnerProfiles(context.systemOrm, context.credentials);
	const codex = new CodexAdapter(context.systemOrm, undefined, context.invalidations);
	dispatcher.registerHandler(RPC.externalAgent.list, () => ({ items: profiles.list() }));
	dispatcher.registerHandler(RPC.externalAgent.save, async (request) => {
		const runner = await profiles.save(request);
		context.invalidations.invalidate(CacheKey.settings());
		return { runner };
	});
	dispatcher.registerHandler(RPC.externalAgent.discoverCodex, () =>
		codex.discover().then((candidates) => ({ candidates })),
	);
	dispatcher.registerHandler(RPC.externalAgent.connectCodex, async (request) => {
		const result = await codex.consent(request);
		context.invalidations.invalidate(CacheKey.settings());
		return { profileId: result.profileId, version: result.version, hash: result.sha256 };
	});
	dispatcher.registerHandler(RPC.externalAgent.status, async () => ({
		pi: { available: true as const, profileId: "pi-default" as const },
		codex: await codex.status(),
	}));
	dispatcher.registerHandler(RPC.externalAgent.test, async ({ runnerId }) => {
		const profile = profiles.get(runnerId);
		if (profile.capabilities.enabled === false)
			throw { kind: "unavailable", reason: "runner_disabled" };
		const root = context.runnerProbeRoot;
		await mkdir(root, { recursive: true });
		const directory = await mkdtemp(join(root, "probe-"));
		const workspace = join(directory, "workspace");
		const outputDirectory = join(directory, "outputs");
		await Promise.all([mkdir(workspace), mkdir(outputDirectory)]);
		const adapter =
			profile.type === "codex"
				? codex
				: profile.type === "pi"
					? new PiAcpAdapter(undefined, context.runnerProviderRoot, context.piWorkerPath)
					: new CustomAcpAdapter(profiles);
		try {
			const route =
				profile.type === "pi"
					? context.models.systemDefaults(context.providers.modelProjectionFacts()).reply
					: undefined;
			if (profile.type === "pi" && route?.readiness !== "ready")
				throw { kind: "unavailable", reason: "runner_model_required" };
			const stored = route ? await context.credentials.get(route.providerId) : undefined;
			const credential =
				stored?.piCredential ??
				(stored?.apiKey ? { type: "api_key" as const, key: stored.apiKey } : undefined);
			const modelRoute = route
				? {
						providerId: route.providerId,
						modelId: route.modelId,
						...(credential ? { credential } : {}),
					}
				: undefined;
			return await adapter.test(
				{
					run: {
						runId: "connection-test",
						triggerEntryId: "connection-test",
						executorProfile: runnerId,
					},
					profile,
					task: { instruction: "", workspace, outputDirectory, modelRoute },
					emit() {},
				},
				context.signal,
			);
		} finally {
			await adapter.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}
