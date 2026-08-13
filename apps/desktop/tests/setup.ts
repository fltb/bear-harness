import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// globals: false — register the cleanup hook explicitly.
afterEach(() => {
	cleanup();
});
