// Component test harness — vitest 2 + jsdom + @testing-library/react.
// Reuses the same @/ alias and react plugin as vite.config.ts so imports
// match production exactly. Scoped to *.spec.{ts,tsx} to avoid colliding
// with the tsx --test *.test.ts suite.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    // *.spec.{ts,tsx} — component/integration tests rendered with RTL.
    // *.test.ts       — kept for tsx --test (logic-only, no DOM).
    include: ['test/**/*.spec.tsx', 'test/**/*.spec.ts'],
    exclude: ['e2e/**'],
  },
});
