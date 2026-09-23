/** Installation-owned launch configuration. Protocol capabilities are negotiated, never stored here. */
import { randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type {
	CustomRunnerConfiguration,
	RunnerInfo,
	RunnerProfile,
	RunnerSaveRequest,
} from "@bear-harness/protocol";
import { CustomRunnerConfiguration as ConfigurationSchema } from "@bear-harness/protocol/schema";
import { eq } from "drizzle-orm";
import type { CredentialStore } from "../providers/credential-store.js";
import type { AppDatabase } from "../storage/database.js";
import { executorProfiles } from "../storage/schema.js";
import type { ExecutorProfile } from "./router.js";

const RESERVED_ENV =
	/^(?:HOME|USERPROFILE|TMP|TEMP|TMPDIR|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|ELECTRON_.*|BEAR_.*)$/;
const DEFAULT_DESCRIPTIONS = {
	pi: {
		name: "Pi Worker",
		description: "Built-in independent worker using the conversation's configured model.",
		useWhen: "Default for delegated work when no runner is specified.",
		limitations: "Requires a configured Pi model.",
	},
	codex: {
		name: "Codex",
		description: "A locally configured Codex ACP worker.",
		useWhen: "When the user requests Codex or this configuration matches the task.",
		limitations: "Requires a connected Codex installation and authentication.",
	},
	custom: { name: "Custom ACP", description: "", useWhen: "", limitations: "" },
};
function fail(reason: string): never {
	throw { kind: "validation_failed", reason };
}
export function runnerInfo(profile: ExecutorProfile): RunnerInfo {
	const c = profile.capabilities;
	const defaults = DEFAULT_DESCRIPTIONS[profile.type];
	return {
		runnerId: profile.id,
		kind: profile.type,
		name: typeof c.name === "string" ? c.name : defaults.name,
		description: typeof c.description === "string" ? c.description : defaults.description,
		useWhen: typeof c.useWhen === "string" ? c.useWhen : defaults.useWhen,
		limitations: typeof c.limitations === "string" ? c.limitations : defaults.limitations,
		enabled: c.enabled !== false,
		configured:
			profile.type === "pi" ||
			(profile.type === "codex"
				? typeof c.codexHome === "string" && typeof c.consentedAt === "string"
				: ConfigurationSchema.safeParse(c.configuration).success),
	};
}
/** Resolve a user configuration request on the Host, never execute a renderer path directly. */
export function resolveRunnerExecutable(command: string): string {
	const candidates = isAbsolute(command)
		? [command]
		: (process.env.PATH ?? "")
				.split(delimiter)
				.filter(Boolean)
				.flatMap((directory) =>
					process.platform === "win32"
						? [join(directory, command), join(directory, `${command}.exe`)]
						: [join(directory, command)],
				);
	for (const candidate of candidates) {
		try {
			const canonical = realpathSync(candidate);
			if (!statSync(canonical).isFile()) continue;
			accessSync(canonical, constants.X_OK);
			return canonical;
		} catch {
			/* try the next host-resolved candidate */
		}
	}
	return fail("runner_executable_not_found");
}
export class RunnerProfiles {
	constructor(
		private readonly db: AppDatabase,
		private readonly credentials: CredentialStore,
	) {}
	list(): RunnerProfile[] {
		return this.db
			.select()
			.from(executorProfiles)
			.orderBy(executorProfiles.createdAt, executorProfiles.id)
			.limit(100)
			.all()
			.map((row) =>
				this.project({ id: row.id, type: row.profileType, capabilities: row.configJson }),
			);
	}
	catalog(): RunnerInfo[] {
		return this.list()
			.filter((row) => row.enabled)
			.map(({ configuration: _configuration, ...info }) => info);
	}
	get(id: string): ExecutorProfile {
		const row = this.db.select().from(executorProfiles).where(eq(executorProfiles.id, id)).get();
		if (!row) throw { kind: "not_found", reason: "runner_not_found" };
		return { id: row.id, type: row.profileType, capabilities: row.configJson };
	}
	private project(profile: ExecutorProfile): RunnerProfile {
		const info = runnerInfo(profile);
		if (profile.type !== "custom") return info;
		const parsed = ConfigurationSchema.parse(profile.capabilities.configuration);
		return {
			...info,
			configuration: {
				...parsed,
				environment: parsed.environment.map(({ name, value, secret }) => ({
					name,
					secret,
					...(secret ? {} : { value }),
				})),
			},
		};
	}
	async save(input: RunnerSaveRequest): Promise<RunnerProfile> {
		const previous = input.runnerId ? this.get(input.runnerId) : undefined;
		const id = previous?.id ?? `custom-${randomUUID()}`;
		if (!previous && this.list().length >= 100) fail("runner_profile_limit");
		if (id === "pi-default" && !input.enabled) fail("default_runner_cannot_be_disabled");
		const config = {
			...previous?.capabilities,
			name: input.name,
			description: input.description,
			useWhen: input.useWhen,
			limitations: input.limitations,
			enabled: input.enabled,
		};
		if (!previous || previous.type === "custom") {
			const supplied =
				input.configuration ??
				(previous?.capabilities.configuration as CustomRunnerConfiguration | undefined);
			if (!supplied) fail("runner_configuration_required");
			const parsed = ConfigurationSchema.parse(supplied);
			const command = resolveRunnerExecutable(parsed.command);
			const dependencyPaths = parsed.dependencyPaths.map((path) => {
				const canonical = realpathSync(path);
				if (canonical === "/" || !isAbsolute(canonical)) fail("runner_dependency_invalid");
				return canonical;
			});
			const seen = new Set<string>();
			const environment = [];
			for (const item of parsed.environment) {
				if (seen.has(item.name) || RESERVED_ENV.test(item.name)) fail("runner_environment_invalid");
				seen.add(item.name);
				if (item.secret) {
					const key = `$bear:runner:${id}:${item.name}`;
					if (item.value) await this.credentials.set(key, { apiKey: item.value });
					if (!(await this.credentials.get(key))?.apiKey) fail("runner_credential_missing");
					environment.push({ name: item.name, secret: true });
				} else environment.push({ name: item.name, secret: false, value: item.value ?? "" });
			}

			Object.assign(config, {
				configuration: { ...parsed, command, environment, dependencyPaths },
			});
		} else if (input.configuration) fail("runner_configuration_kind_invalid");
		this.db
			.insert(executorProfiles)
			.values({ id, profileType: previous?.type ?? "custom", configJson: config })
			.onConflictDoUpdate({ target: executorProfiles.id, set: { configJson: config } })
			.run();
		return this.project(this.get(id));
	}
	configuration(profile: ExecutorProfile): CustomRunnerConfiguration {
		const configuration = ConfigurationSchema.parse(profile.capabilities.configuration);
		return {
			...configuration,
			environment: configuration.environment.map((item) => {
				if (!item.secret) return item;
				const value = this.credentials.read(`$bear:runner:${profile.id}:${item.name}`)?.apiKey;
				if (!value) throw { kind: "unavailable", reason: "runner_credential_missing" };
				return { ...item, value };
			}),
		};
	}
}
