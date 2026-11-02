import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'build'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/types.ts',
        'src/server.ts',
        'src/tools/index.ts',
        'src/utils/index.ts',
        'src/validators/index.ts',
      ],
      thresholds: {
        statements: 65,
        branches: 80,
        functions: 80,
        lines: 65,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
