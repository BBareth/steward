import { defineConfig } from 'vitest/config';

// Live tests talk to the real Discord API. They are opt-in: see docs/AGENT.md.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
