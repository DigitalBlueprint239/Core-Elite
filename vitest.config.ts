import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // node environment: all tests use SimulatedDevice (isolated HLC state)
    // and pure functions only — no DOM, no localStorage dependency.
    environment: 'node',
    // Isolate module state between test files — each file gets a fresh
    // module registry so hlc.ts _state is reset between test files.
    isolate: true,
    globals: true,
    include: [
      'src/**/__tests__/**/*.test.ts',
      'packages/**/__tests__/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/lib/hlc.ts', 'src/lib/lww.ts'],
      thresholds: { lines: 100, functions: 100, branches: 90 },
    },
  },
});
