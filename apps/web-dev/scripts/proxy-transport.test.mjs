import assert from "node:assert/strict";
import test from "node:test";
import { loopbackProxyTransport } from "./proxy-transport.mjs";

test("the WebDev loopback proxy never reuses an upstream Host socket", () => {
	assert.deepEqual(loopbackProxyTransport, { agent: false });
	assert.equal(Object.isFrozen(loopbackProxyTransport), true);
});
