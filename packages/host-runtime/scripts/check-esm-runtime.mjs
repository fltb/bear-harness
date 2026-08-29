const runtime = await import("../dist/index.js");

if (typeof runtime.createHostRuntime !== "function") {
	throw new Error("host-runtime ESM build does not export createHostRuntime");
}
