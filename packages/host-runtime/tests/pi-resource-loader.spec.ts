// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Pi role resource injection", () => {
	it("loads only explicitly supplied role Skill and plugin paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-role-resources-"));
		temporaryDirectories.push(root);
		const skills = join(root, "skills");
		const plugins = join(root, "plugins");
		const plugin = join(plugins, "station-log.mjs");
		mkdirSync(join(skills, "station-log"), { recursive: true });
		mkdirSync(plugins, { recursive: true });
		writeFileSync(
			join(skills, "station-log", "SKILL.md"),
			"---\nname: station-log\ndescription: Inspect the role's station log.\n---\nRead the station log.\n",
		);
		writeFileSync(
			plugin,
			"export default function stationLog(pi) { pi.registerCommand('station-log', { description: 'Read station log', handler: async () => {} }); }\n",
		);

		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory(
				{ enableAnalytics: false, enableInstallTelemetry: false, defaultProjectTrust: "never" },
				{ projectTrusted: false },
			),
			additionalSkillPaths: [skills],
			additionalExtensionPaths: [plugin],
			noSkills: true,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		expect(loader.getSkills().diagnostics).toEqual([]);
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["station-log"]);
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toHaveLength(1);
	});
});
