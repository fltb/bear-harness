import { createHash, randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseDocument } from "yaml";

/** Offline, one-way conversion. The v2 runtime never reads v1 packages. */
export function convertManifest(source) {
	const document = parseDocument(source);
	if (document.errors.length) throw new Error(document.errors[0].message);
	const old = document.toJS();
	if (old.format_version !== 1) throw new Error("Expected a v1 character package");
	document.set("format_version", 2);
	document.set("version", "1.0.0");
	const guidance = [];
	if (old.behavior?.agency?.never?.length)
		guidance.push(`Avoid:\n${old.behavior.agency.never.map((value) => `- ${value}`).join("\n")}`);
	if (old.behavior?.agency?.when_uncertain?.length)
		guidance.push(
			`When uncertain:\n${old.behavior.agency.when_uncertain.map((value) => `- ${value}`).join("\n")}`,
		);
	if (guidance.length)
		document.set(
			"system_prompt",
			document.createNode([old.system_prompt, ...guidance].filter(Boolean).join("\n\n")),
		);
	document.deleteIn(["behavior", "agency"]);
	if (document.hasIn(["character", "correction"])) document.deleteIn(["character", "correction"]);
	if (document.hasIn(["character", "work_presentation"]))
		document.deleteIn(["character", "work_presentation"]);
	if (old.visual?.default_scene) {
		const index = old.scenes?.findIndex((scene) => scene.id === old.visual.default_scene);
		if (index === undefined || index < 0) throw new Error("Missing default scene");
		document.setIn(["scenes", index, "default"], true);
		document.deleteIn(["visual", "default_scene"]);
	}
	return {
		yaml: String(document),
		retired: {
			agency: old.behavior?.agency,
			correction: old.character?.correction,
			work_presentation: old.character?.work_presentation,
		},
	};
}

function inventory(root) {
	const entries = [];
	const walk = (directory, depth) => {
		if (depth > 32) throw new Error("Package directory is too deep");
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error("Package symlinks cannot be converted");
			if (stat.isDirectory()) walk(path, depth + 1);
			else if (stat.isFile())
				entries.push({
					path: relative(root, path),
					sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
				});
			else throw new Error("Unsupported package file");
		}
	};
	if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
		throw new Error("Source must be a real package directory");
	walk(root, 0);
	return entries;
}

export async function migratePackage(sourcePath, destinationPath) {
	const source = resolve(sourcePath);
	const destination = resolve(destinationPath);
	const rel = relative(source, destination);
	if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
		throw new Error("Destination must be outside the source package");
	if (existsSync(destination) || existsSync(`${destination}.migration.json`))
		throw new Error("Destination already exists");
	const before = inventory(source);
	const converted = convertManifest(readFileSync(join(source, "character.yaml"), "utf8"));
	const id = parse(converted.yaml).id;
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
		throw new Error(
			"Character id must be lowercase ASCII with digits or hyphens, at most 64 characters",
		);
	if (basename(destination) !== id)
		throw new Error("Destination directory name must equal character id");
	mkdirSync(dirname(destination), { recursive: true });
	const physicalDestination = join(realpathSync(dirname(destination)), basename(destination));
	const physicalRel = relative(realpathSync(source), physicalDestination);
	if (
		!physicalRel ||
		(physicalRel !== ".." && !physicalRel.startsWith(`..${sep}`) && !isAbsolute(physicalRel))
	)
		throw new Error("Destination must be outside the source package");
	const stagingRoot = join(dirname(destination), `.character-conversion-${randomUUID()}`);
	const staging = join(stagingRoot, id);
	mkdirSync(stagingRoot, { recursive: true });
	try {
		cpSync(source, staging, { recursive: true, errorOnExist: true });
		writeFileSync(join(staging, "character.yaml"), converted.yaml);
		const manifestPath = join(staging, "canon/manifest.yaml");
		const retiredCanon = existsSync(manifestPath)
			? parse(readFileSync(manifestPath, "utf8"))
			: undefined;
		// Original source remains intact; retired metadata is retained in the receipt, not indexed as evidence.
		if (retiredCanon) {
			for (const entry of retiredCanon.sources ?? []) {
				const path = resolve(staging, "canon", entry.path);
				const rel = relative(join(staging, "canon"), path);
				if (rel.startsWith("..") || rel.startsWith("/") || !existsSync(path))
					throw new Error("Invalid legacy Canon source");
				// Preserve authored document titles after removing the manifest.
				const body = readFileSync(path, "utf8");
				if (entry.title && !/^#[ \t]+.+$/mu.test(body))
					writeFileSync(path, `# ${entry.title}\n\n${body}`);
			}
			rmSync(manifestPath);
		}
		const { CharacterLoader } = await import(
			"../packages/host-runtime/dist/companion/character-loader.js"
		);
		const character = new CharacterLoader(stagingRoot).load(id);
		if (!character) throw new Error("Converted character cannot load");
		const receipt = {
			from: 1,
			to: 2,
			characterId: id,
			sourceFiles: before,
			convertedFiles: inventory(staging),
			retired: { ...converted.retired, canon: retiredCanon },
			notes: [
				"Source package was not modified",
				"Runtime state, sessions and memory were not accessed",
				"Skill chapter conditions were preserved",
			],
		};
		// Publish the validated package only after all conversion work succeeds.
		if (JSON.stringify(inventory(source)) !== JSON.stringify(before))
			throw new Error("Source changed during conversion; retry from a stable source");
		if (existsSync(destination)) throw new Error("Destination already exists");
		writeFileSync(`${destination}.migration.json`, `${JSON.stringify(receipt, null, 2)}\n`, {
			flag: "wx",
		});
		try {
			renameSync(staging, destination);
		} catch (error) {
			rmSync(`${destination}.migration.json`);
			throw error;
		}
		return receipt;
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [, , source, destination, ...extra] = process.argv;
	if (!source || !destination || extra.length)
		throw new Error("Usage: migrate-character-package.mjs SOURCE_PACKAGE NEW_DESTINATION");
	const receipt = await migratePackage(source, destination);
	console.log(
		`Converted ${receipt.characterId} to v2 at ${resolve(destination)}; source and runtime unchanged.`,
	);
}
