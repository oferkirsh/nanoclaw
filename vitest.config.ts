import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    // Default trigger tests assume assistant name differs from custom "@Claw" trigger.
    env: { ASSISTANT_NAME: 'Andy' },
  },
});
