import type { QueryKey } from "@tanstack/solid-query";

// An unknown source deliberately invalidates all resources: additions must not
// silently leave existing clients stale. These are cache dependencies, not DTOs.
const rootsByTable: Record<string, readonly string[]> = {
	companion_packages: ["snapshot", "character", "characters", "canon"],
	companion_identity: ["snapshot", "character", "characters"],
	self_canon_versions: ["snapshot", "character", "canon"],
	conversations: ["conversations"],
	companion_state_documents: ["snapshot"],
	relationship_memory_entries: ["memory"],
	memory_candidates: ["memory"],
	memory_decisions: ["memory"],
	memory_presentation: ["memory"],
	app_settings: ["settings", "snapshot"],
	runs: ["runs"],
	run_manifests: ["runs"],
	evidence: ["runs"],
	artifacts: ["runs"],
	artifact_adoptions: ["runs"],
	provider_accounts: ["providers", "providerLogin", "models", "settings"],
	configured_models: ["models", "providers"],
	model_route_settings: ["models"],
	voice_stack_versions: ["settings"],
	executor_profiles: ["externalAgent", "settings"],
	runtime_assets: ["settings", "character"],
	user_decisions: ["onboarding", "settings"],
	onboarding_state: ["onboarding", "snapshot"],
	canon_sources: ["canon"],
	canon_chunks: ["canon"],
	canon_entities: ["canon"],
	canon_relations: ["canon"],
	canon_package_state: ["canon"],
	story_modules: ["canon"],
	active_character: [
		"snapshot",
		"characters",
		"character",
		"memory",
		"canon",
		"onboarding",
		"settings",
		"conversation",
		"conversations",
		"runs",
		"models",
	],
	character_drafts: ["character"],
	character_draft_revisions: ["character"],
};
const rootsByEventDomain: Record<string, readonly string[]> = {
	diagnostics: ["audit"],
	webdev: ["audit"],
	evidence: ["runs"],
	artifact: ["runs"],
	companion: ["snapshot", "conversation"],
	pi: ["conversation"],
	conversation: ["conversation", "conversations"],
	character: ["snapshot", "characters", "character"],
	roleplay: ["snapshot"],
	memory: ["memory", "embedding", "settings"],
	canon: ["canon"],
	provider: ["providers", "providerLogin", "models"],
	model: ["models"],
	onboarding: ["onboarding"],
	settings: ["settings"],
	run: ["runs"],
	update: ["update"],
	externalAgent: ["externalAgent"],
};
export function affectedQueries(sources: readonly string[]): (key: QueryKey) => boolean {
	const roots = new Set<string>(["audit"]);
	for (const source of sources) {
		const dependencies =
			source === "event:memory.embedding_download_changed"
				? ["embedding"]
				: source === "event:provider.login_changed"
					? ["providerLogin"]
					: source.startsWith("event:")
						? rootsByEventDomain[source.slice(6).split(".")[0] ?? ""]
						: rootsByTable[source];
		if (!dependencies) return () => true;
		for (const root of dependencies) roots.add(root);
	}
	return (key) => roots.has(String(key[0]));
}
