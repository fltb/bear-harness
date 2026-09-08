import { Agent } from "node:http";

// The Host intentionally uses Node's bounded HTTP keep-alive lifetime. Retire
// idle sockets well before the advertised boundary: this keeps connection churn
// bounded without letting the WebDev proxy race a Host-side socket close.
class LoopbackAgent extends Agent {
	keepSocketAlive(socket) {
		if (!super.keepSocketAlive(socket)) return false;
		socket.setTimeout(2_000);
		return true;
	}

	reuseSocket(socket, request) {
		socket.setTimeout(0);
		super.reuseSocket(socket, request);
	}
}

const agent = new LoopbackAgent({
	keepAlive: true,
	maxSockets: 32,
	maxFreeSockets: 4,
	scheduling: "lifo",
});

export const loopbackProxyTransport = Object.freeze({ agent });
