import assert from "node:assert/strict";
import test from "node:test";
import { observeProxyFailure } from "./proxy-failure.mjs";

test("proxy failures expose only an allowlisted route category and bounded code", () => {
	assert.deepEqual(
		observeProxyFailure(
			{ code: "ECONNRESET" },
			{ url: "/events?secret=value", aborted: false },
			{ destroyed: false },
		),
		{ code: "ECONNRESET", route: "events", clientAborted: false },
	);
	assert.deepEqual(
		observeProxyFailure(
			{ code: "bad value" },
			{ url: "/private", aborted: false },
			{ destroyed: false },
		),
		{
			code: "unknown",
			route: "unknown",
			clientAborted: false,
		},
	);
});

test("proxy failures distinguish an explicit client abort", () => {
	assert.equal(
		observeProxyFailure(
			{ code: "ECONNRESET" },
			{ url: "/events", aborted: true },
			{ destroyed: false },
		).clientAborted,
		true,
	);
	assert.equal(
		observeProxyFailure(
			{ code: "ECONNRESET" },
			{ url: "/attachment/item", aborted: false },
			{ destroyed: true },
		).clientAborted,
		true,
	);
});
