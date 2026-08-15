import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "scrollTo", { configurable: true, value: () => undefined });

// globals: false — register the cleanup hook explicitly.
afterEach(() => {
	cleanup();
});
