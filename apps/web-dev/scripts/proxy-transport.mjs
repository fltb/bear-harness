// The Host intentionally uses Node's bounded HTTP keep-alive lifetime. A WebDev
// proxy pool can otherwise race that idle expiry and reuse a socket while the
// Host is closing it. WebDev is loopback-only, so fresh upstream connections
// are cheap and make the transport deterministic for long acceptance runs.
export const loopbackProxyTransport = Object.freeze({ agent: false });
