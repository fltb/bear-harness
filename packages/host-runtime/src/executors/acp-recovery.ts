/** Durable executor identity and an actual release receipt, scoped to one Run. Never a transcript. */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "@bear-harness/schema";
import type { ExecutorLaunchRequest } from "./router.js";

const RecordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	runId: z.string(),
	sessionId: z.string().min(1).max(1024),
	released: z.boolean(),
	profile: z.strictObject({
		id: z.string(),
		type: z.enum(["pi", "codex", "custom"]),
		capabilities: z.record(z.string(), z.unknown()),
	}),
	modelRoute: z.strictObject({ providerId: z.string(), modelId: z.string() }).optional(),
});
export type AcpRecoveryRecord = z.infer<typeof RecordSchema>;
function location(request: ExecutorLaunchRequest): string | undefined {
	return request.task.outputDirectory
		? join(dirname(request.task.outputDirectory), "acp-connection.json")
		: undefined;
}
export function readAcpRecovery(request: ExecutorLaunchRequest): AcpRecoveryRecord | undefined {
	const path = location(request);
	if (!path) return;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return;
		const record = RecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		return record.runId === request.run.runId &&
			record.profile.id === request.run.executorProfile &&
			record.profile.type === request.profile.type
			? record
			: undefined;
	} catch {
		return;
	}
}
export function writeAcpRecovery(request: ExecutorLaunchRequest, record: AcpRecoveryRecord): void {
	const path = location(request);
	if (!path) return;
	const raw = JSON.stringify(RecordSchema.parse(record));
	if (Buffer.byteLength(raw) > 65536) throw new Error("runner_recovery_record_limit");
	const staging = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		writeFileSync(fd, raw);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(staging, path);
	} finally {
		rmSync(staging, { force: true });
	}
}
