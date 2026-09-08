import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { loopbackProxyTransport } from "./proxy-transport.mjs";

function send(port) {
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{
				host: "127.0.0.1",
				port,
				path: "/",
				agent: loopbackProxyTransport.agent,
			},
			(response) => {
				const localPort = response.socket.localPort;
				response.resume();
				response.once("end", () => resolve(localPort));
			},
		);
		outgoing.once("error", reject);
		outgoing.end();
	});
}

test("the WebDev loopback pool reuses safe sockets and retires them before Host expiry", async () => {
	const server = createServer((_request, response) => response.end("ok"));
	server.keepAliveTimeout = 5_000;
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");

	try {
		const firstPort = await send(address.port);
		const reusedPort = await send(address.port);
		assert.equal(reusedPort, firstPort);

		await new Promise((resolve) => setTimeout(resolve, 2_100));
		const refreshedPort = await send(address.port);
		assert.notEqual(refreshedPort, firstPort);
	} finally {
		loopbackProxyTransport.agent.destroy();
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
