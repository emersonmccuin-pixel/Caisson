import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installDevPerfBufferReaper } from './dev-perf-buffer';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';

installDevPerfBufferReaper();

// Root-level fallback: fills the viewport so the window never goes black.
const rootFallback = (
  <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-xs text-muted-foreground">
    <span className="text-destructive">The application hit an unexpected error.</span>
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="px-2 py-1 text-[10px] uppercase tracking-wider hover:text-foreground"
    >
      Reload
    </button>
  </div>
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fallback={rootFallback}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
