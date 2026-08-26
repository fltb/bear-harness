/** Minimal sandbox preload. Runtime contract parsing lives in the renderer client bundle. */
import { contextBridge, ipcRenderer, webUtils } from "electron";

type ErrorType =
	| "Error"
	| "TypeError"
	| "RangeError"
	| "ReferenceError"
	| "SyntaxError"
	| "AggregateError"
	| "DOMException"
	| "non-error"
	| "unknown";

interface FaultInput {
	kind: "error" | "unhandled-rejection";
	errorType: ErrorType;
	line?: number;
	column?: number;
}

const TRACEPARENT_ARG_PREFIX = "--bear-traceparent=";
const traceparent =
	process.argv
		.find((arg) => arg.startsWith(TRACEPARENT_ARG_PREFIX))
		?.slice(TRACEPARENT_ARG_PREFIX.length) ?? "";
const FAULT_KEYS = ["kind", "errorType", "line", "column"] as const;
const ERROR_TYPES: readonly ErrorType[] = [
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"AggregateError",
	"DOMException",
	"non-error",
	"unknown",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
	);
}

function validFault(input: unknown): input is FaultInput {
	if (!isPlainObject(input)) return false;
	if (Object.keys(input).some((key) => !(FAULT_KEYS as readonly string[]).includes(key)))
		return false;
	if (input.kind !== "error" && input.kind !== "unhandled-rejection") return false;
	if (
		typeof input.errorType !== "string" ||
		!(ERROR_TYPES as readonly string[]).includes(input.errorType)
	)
		return false;
	for (const key of ["line", "column"]) {
		if (key in input) {
			const value = input[key];
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0 ||
				value > 2_147_483_647
			)
				return false;
		}
	}
	return true;
}

function reportRendererFault(input: unknown): void {
	if (validFault(input))
		ipcRenderer.send("diagnostics:renderer-fault:v1", { traceparent, fault: input });
}

const ATTACHMENT_CHANNEL_PREFIX = "desktop:attachment";
async function invokeAttachment(channel: string, request: object): Promise<unknown[]> {
	const response: unknown = await ipcRenderer.invoke(channel, request);
	if (!isPlainObject(response) || response.ok !== true || !isPlainObject(response.data))
		throw new Error("attachment_import_failed");
	const attachments = response.data.attachments;
	if (!Array.isArray(attachments)) throw new Error("attachment_import_failed");
	return attachments;
}

const attachments = Object.freeze({
	pickFiles: (conversationId: string) =>
		invokeAttachment("desktop:attachmentPickFiles:v1", { conversationId }),
	pickFolder: (conversationId: string) =>
		invokeAttachment("desktop:attachmentPickFolder:v1", { conversationId }),
	importDroppedFiles: (conversationId: string, files: File[]) => {
		const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
		if (paths.length === 0) return Promise.resolve([]);
		return invokeAttachment("desktop:attachmentImportDrop:v1", { conversationId, paths });
	},
});

contextBridge.exposeInMainWorld(
	"bearDesktop",
	Object.freeze({
		platform: process.platform,
		diagnostics: Object.freeze({ reportRendererFault }),
		attachments,
		transport: Object.freeze({
			invoke: (channel: string, request: unknown) => {
				if (channel.startsWith(ATTACHMENT_CHANNEL_PREFIX))
					return Promise.reject(new Error("attachment_channel_requires_trusted_preload"));
				return ipcRenderer.invoke(channel, request);
			},
		}),
	}),
);
