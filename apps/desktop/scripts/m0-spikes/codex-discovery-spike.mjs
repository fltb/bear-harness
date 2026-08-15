/**
 * M0 spike: Codex discovery — bounded, explainable, consent-ready.
 *
 * Per plan §9.4: discovery checks (1) previously-confirmed canonical path,
 * (2) PATH `codex`/`codex.exe`, (3) official standalone default entry
 * (`~/.local/bin/codex` on macOS/Linux), (4) recognizable Homebrew/npm shims.
 * Each candidate: lstat/realpath (reject symlink escaping its install root),
 * bounded `codex --version` probe (accept ONLY the pinned 0.147.0), SHA-256.
 *
 * Dev-only evidence tool (never shipped). Run from repo root or apps/desktop:
 *   node apps/desktop/scripts/m0-spikes/codex-discovery-spike.mjs
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const PINNED_VERSION = "0.147.0";
const report = { pinnedVersion: PINNED_VERSION, candidates: [], decision: null };

function sha256Of(file) {
	return new Promise((resolve2, reject2) => {
		const hash = createHash("sha256");
		const stream = createReadStream(file);
		stream.on("data", (c) => hash.update(c));
		stream.on("end", () => resolve2(hash.digest("hex")));
		stream.on("error", reject2);
	});
}

/** Resolve the final binary behind a shim chain, bounding the walk. */
function resolveChain(start) {
	const chain = [start];
	let current = start;
	for (let i = 0; i < 8; i += 1) {
		let st;
		try {
			st = lstatSync(current);
		} catch {
			return { chain, error: "lstat_failed" };
		}
		if (st.isSymbolicLink()) {
			const target = readlinkSync(current);
			const next = isAbsolute(target) ? target : resolve(dirname(current), target);
			chain.push(next);
			current = next;
			continue;
		}
		return { chain, error: null };
	}
	return { chain, error: "symlink_loop" };
}

async function probeCandidate(name, entry) {
	const rec = {
		name,
		entry,
		chain: null,
		version: null,
		versionExact: false,
		sha256: null,
		status: null,
		note: null,
	};
	try {
		const resolved = resolveChain(entry);
		rec.chain = resolved.chain;
		if (resolved.error) {
			rec.status = "rejected";
			rec.note = resolved.error;
			report.candidates.push(rec);
			return rec;
		}
		const finalBin = resolved.chain[resolved.chain.length - 1];
		// Reject if the final target escapes its declared install root.
		const root = entry.startsWith("/opt/homebrew")
			? "/opt/homebrew"
			: entry.startsWith("/usr/local")
				? "/usr/local"
				: homedir();
		if (!finalBin.startsWith(root)) {
			rec.status = "rejected";
			rec.note = `final target escapes declared install root: ${finalBin}`;
			report.candidates.push(rec);
			return rec;
		}
		// Bounded hidden-argv version probe; parse the FIRST numeric token.
		const out = spawnSync(finalBin, ["--version"], {
			encoding: "utf8",
			timeout: 10000,
			windowsHide: true,
		});
		const raw = (out.stdout ?? "") + (out.stderr ?? "");
		const m = raw.match(/(\d+\.\d+\.\d+)/);
		rec.version = m ? m[1] : raw.trim().slice(0, 60) || null;
		rec.versionExact = rec.version === PINNED_VERSION;
		rec.sha256 = await sha256Of(finalBin);
		rec.status = rec.versionExact ? "usable" : "version_mismatch";
		rec.note = rec.versionExact ? null : `pinned ${PINNED_VERSION}, found ${rec.version}`;
	} catch (e) {
		rec.status = "rejected";
		rec.note = String(e?.message ?? e).slice(0, 120);
	}
	report.candidates.push(rec);
	return rec;
}

// Candidate order: PATH first, then official standalone, then Homebrew shim.
const seen = new Set();
async function addCandidate(name, entry) {
	if (!entry || seen.has(entry)) return;
	seen.add(entry);
	await probeCandidate(name, entry);
}

const pathEntries = (process.env.PATH ?? "")
	.split(":")
	.map((d) => join(d, process.platform === "win32" ? "codex.exe" : "codex"));
for (const p of pathEntries) {
	if (p.startsWith(homedir() + "/.nvm") || p.startsWith(homedir() + "/.fnm")) continue; // keep the walk bounded
	try {
		if (statSync(p).isFile()) await addCandidate("PATH", p);
	} catch {
		/* not present */
	}
}
await addCandidate("standalone-default", join(homedir(), ".local", "bin", "codex"));
await addCandidate("homebrew", "/opt/homebrew/bin/codex");

// Decision: only an exact 0.147.0 candidate makes the profile usable.
const usable = report.candidates.find((c) => c.status === "usable");
if (usable) {
	report.decision = {
		status: "usable",
		profile: "user-codex-0.147.0",
		canonicalPath: usable.chain.at(-1),
		sha256: usable.sha256,
	};
} else {
	const mismatches = report.candidates.filter((c) => c.status === "version_mismatch");
	report.decision = {
		status: "version_mismatch",
		profile: "user-codex",
		// Capability unavailable: profile is disabled; Companion/Pi unaffected.
		unavailableReason: "codex_version_mismatch",
		detail: mismatches.map((c) => `found ${c.version} at ${c.entry}`),
		note: "Per plan §9.4, Bear Harness does not install or upgrade Codex for the user; the profile stays disabled until an exact 0.147.0 executable is explicitly confirmed by the user.",
	};
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.decision.status === "usable" ? 0 : 0); // discovery itself succeeded either way
