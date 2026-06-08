// Automated test for the ErrorBoundary component.
//
// Contracts verified:
//   1. A child that throws during render shows the fallback (default).
//   2. A sibling OUTSIDE the boundary still renders when the child inside throws —
//      i.e. the crash is contained to the boundary's subtree.
//   3. Clicking "Try again" resets internal state so a fixed child recovers.
//   4. The REAL ErrorBoundary component is imported, not a reimplementation.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary';

// Suppress console.error during these tests.
// React (in dev/jsdom mode) logs caught errors to console.error; our boundary
// also calls it. The noise would fail any "no unhandled errors" lint rule and
// is not what we're asserting against here.
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

// A component that unconditionally throws during render.
function AlwaysThrows(): never {
  throw new Error('deliberate render error');
}

describe('ErrorBoundary', () => {
  test('shows the default fallback when a child throws', () => {
    render(
      <ErrorBoundary label="test panel">
        <AlwaysThrows />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
  });

  test('sibling outside the boundary still renders when the child inside throws', () => {
    render(
      <div>
        <ErrorBoundary label="crashing region">
          <AlwaysThrows />
        </ErrorBoundary>
        <div data-testid="sibling">unaffected sibling</div>
      </div>,
    );
    // The boundary caught the crash and shows its fallback.
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
    // The sibling — outside the boundary — is still in the document.
    expect(screen.getByTestId('sibling')).toBeInTheDocument();
    expect(screen.getByTestId('sibling')).toHaveTextContent('unaffected sibling');
  });

  test('fallback message includes the label', () => {
    render(
      <ErrorBoundary label="chat panel">
        <AlwaysThrows />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toHaveTextContent(/chat panel/i);
  });

  test('Try again button resets the boundary so a recovered child renders', () => {
    let shouldThrow = true;
    function Conditional() {
      if (shouldThrow) throw new Error('transient error');
      return <div data-testid="recovered">recovered content</div>;
    }

    render(
      <ErrorBoundary label="test panel">
        <Conditional />
      </ErrorBoundary>,
    );

    // Fallback is showing.
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();

    // Fix the underlying cause, then click Try again.
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    // The recovered child renders; the fallback is gone.
    expect(screen.getByTestId('recovered')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
  });

  test('custom fallback prop is rendered instead of the default', () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">custom!</div>}>
        <AlwaysThrows />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
  });
});
