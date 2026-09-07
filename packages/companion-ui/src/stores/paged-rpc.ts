import type { CompanionClient } from "@bear-harness/companion-client";
import type {
	CanonListModulesResponse,
	CanonListSourcesResponse,
	CharacterListResponse,
	ModelPoolGetResponse,
	ProviderListResponse,
} from "@bear-harness/protocol";
import { invoke } from "./ipc.js";

export async function listAllCharacters(client: CompanionClient): Promise<CharacterListResponse> {
	const characters: CharacterListResponse["characters"] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await invoke(client, () =>
			client.character.list({ ...(cursor ? { cursor } : {}), limit: 100 }),
		);
		characters.push(...page.characters);
		cursor = nextStringCursor(page.nextCursor, seen);
	} while (cursor);
	return { characters };
}

export async function listAllCanonSources(
	client: CompanionClient,
): Promise<CanonListSourcesResponse> {
	const sources: CanonListSourcesResponse["sources"] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await invoke(client, () =>
			client.canon.listSources({ ...(cursor ? { cursor } : {}), limit: 100 }),
		);
		sources.push(...page.sources);
		cursor = nextStringCursor(page.nextCursor, seen);
	} while (cursor);
	return { sources };
}

export async function listAllCanonModules(
	client: CompanionClient,
): Promise<CanonListModulesResponse> {
	const modules: CanonListModulesResponse["modules"] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await invoke(client, () =>
			client.canon.listModules({ ...(cursor ? { cursor } : {}), limit: 100 }),
		);
		modules.push(...page.modules);
		cursor = nextStringCursor(page.nextCursor, seen);
	} while (cursor);
	return { modules };
}

export async function listAllProviders(client: CompanionClient): Promise<ProviderListResponse> {
	const providers: ProviderListResponse["providers"] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await invoke(client, () =>
			client.provider.list({ ...(cursor ? { cursor } : {}), limit: 30 }),
		);
		providers.push(...page.providers);
		cursor = nextStringCursor(page.nextCursor, seen);
	} while (cursor);
	return { providers };
}

export async function listAllModels(client: CompanionClient): Promise<ModelPoolGetResponse> {
	const models: ModelPoolGetResponse["models"] = [];
	const seen = new Set<string>();
	let cursor: ModelPoolGetResponse["nextCursor"];
	do {
		const page = await invoke(client, () =>
			client.model.poolGet({ ...(cursor ? { cursor } : {}), limit: 100 }),
		);
		models.push(...page.models);
		const next = page.nextCursor;
		if (next) {
			const key = `${next.providerId}\u0000${next.modelId}`;
			if (seen.has(key)) throw new Error("model pagination cursor repeated");
			seen.add(key);
		}
		cursor = next;
	} while (cursor);
	return { models };
}

function nextStringCursor(cursor: string | undefined, seen: Set<string>): string | undefined {
	if (!cursor) return undefined;
	if (seen.has(cursor)) throw new Error("pagination cursor repeated");
	seen.add(cursor);
	return cursor;
}
