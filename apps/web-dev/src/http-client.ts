import type { HostTransport } from "@bear-harness/companion-types";

export interface WebDevBootstrap {
	product: {
		productName: string;
		appId: string;
		dataDirectoryName: string;
		artifactName: string;
		executableName: string;
		defaultCharacterId: string;
		brandLicense: {
			spdx: "CC-BY-SA-4.0";
			workTitle: string;
			creator: string;
			attribution: string;
			sourceUrl: string;
			modified: boolean;
			modificationNotice: string;
		};
		icon: string | null;
	};
	token: string;
}

export function createHttpTransport(token: string): HostTransport {
	return {
		async invoke(channel, params) {
			const response = await fetch(`/rpc/${encodeURIComponent(channel)}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-bear-web-dev-token": token,
				},
				body: JSON.stringify(params),
			});
			if (!response.ok) {
				throw new Error(`web-dev transport failed: ${response.status}`);
			}
			return response.json();
		},
	};
}

export async function loadBootstrap(): Promise<WebDevBootstrap> {
	const response = await fetch("/bootstrap", { cache: "no-store" });
	if (!response.ok) throw new Error(`web-dev bootstrap failed: ${response.status}`);
	return response.json() as Promise<WebDevBootstrap>;
}

export async function loadDebugChannels(token: string): Promise<string[]> {
	const response = await fetch("/debug/channels", {
		headers: { "x-bear-web-dev-token": token },
		cache: "no-store",
	});
	if (!response.ok) throw new Error(`web-dev debug channels failed: ${response.status}`);
	const value: unknown = await response.json();
	if (
		typeof value !== "object" ||
		value === null ||
		!("channels" in value) ||
		!Array.isArray(value.channels) ||
		!value.channels.every((channel) => typeof channel === "string")
	) {
		throw new Error("web-dev debug channels response is invalid");
	}
	return value.channels;
}
