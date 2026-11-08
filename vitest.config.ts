import { defineConfig } from "vitest/config";

/** Captures start a real browser, so a test can take several seconds. */
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 30_000 } });
