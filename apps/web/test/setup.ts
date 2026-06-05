// RTL + jest-dom setup for vitest component tests.
// Loaded once per test file via vitest.config.ts setupFiles.
import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount + reset DOM after every test so tests don't bleed.
afterEach(() => {
  cleanup();
});
