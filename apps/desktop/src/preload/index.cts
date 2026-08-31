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

async function pickLocalPaths(channel: string): Promise<string[]> {
	const response: unknown = await ipcRenderer.invoke(channel);
	if (!isPlainObject(response) || response.ok !== true || !isPlainObject(response.data))
		throw new Error("local_file_picker_failed");
	const paths = response.data.paths;
	if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string"))
		throw new Error("local_file_picker_failed");
	return paths;
}

const localFiles = Object.freeze({
	pickFiles: () => pickLocalPaths("desktop:pickLocalFiles:v1"),
	pickFolder: () => pickLocalPaths("desktop:pickLocalFolder:v1"),
	pathsForDroppedFiles: (files: File[]) =>
		files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
});

function listenToHostPush(
	channels: { listen: string; push: string; unlisten: string },
	params: Record<string, unknown>,
	receive: (batch: unknown) => void,
	fail: (error: unknown) => void,
): () => void {
	const id = crypto.randomUUID();
	let stopped = false;
	const listener = (_event: Electron.IpcRendererEvent, message: { id: string; batch: unknown }) => {
		if (!stopped && message.id === id) receive(message.batch);
	};
	ipcRenderer.on(channels.push, listener);
	void ipcRenderer.invoke(channels.listen, { id, ...params }).catch((error) => {
		if (!stopped) fail(String(error));
	});
	return () => {
		stopped = true;
		ipcRenderer.removeListener(channels.push, listener);
		void ipcRenderer.invoke(channels.unlisten, { id }).catch(() => {});
	};
}

contextBridge.exposeInMainWorld(
	"bearDesktop",
	Object.freeze({
		platform: process.platform,
		diagnostics: Object.freeze({ reportRendererFault }),
		localFiles,
		transport: Object.freeze({
			listen: (
				afterSeq: number,
				receive: (batch: unknown) => void,
				fail: (error: unknown) => void,
			) =>
				listenToHostPush(
					{
						listen: "events:listen:v1",
						push: "events:push:v1",
						unlisten: "events:unlisten:v1",
					},
					{ afterSeq },
					receive,
					fail,
				),
			listenPi: (receive: (batch: unknown) => void, fail: (error: unknown) => void) =>
				listenToHostPush(
					{
						listen: "pi-events:listen:v1",
						push: "pi-events:push:v1",
						unlisten: "pi-events:unlisten:v1",
					},
					{},
					receive,
					fail,
				),
			invoke: (channel: string, request: unknown) => {
				return ipcRenderer.invoke(channel, request);
			},
		}),
	}),
);
