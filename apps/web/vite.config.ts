import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

// Dev-only overrides so an isolated test instance (e.g. a review-preview or a
// runtime-debug server on alternate ports) can be driven without editing this
// file. Default to the production dev ports when unset.
const WEB_PORT = Number(process.env.PC_DEV_WEB_PORT ?? 5173);
const API_PORT = Number(process.env.PC_DEV_API_PORT ?? 4040);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        // T2.1 — during the dev server-restart window the upstream is briefly
        // unreachable. http-proxy's `error` event fires ONLY on a connection
        // failure (a real 500 from the server passes through untouched), so map
        // it to 503 + Retry-After. That lets the web client's bounded retry ride
        // the window out instead of surfacing a 500 cold-load error.
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            const httpRes = res as ServerResponse;
            if (httpRes && 'writeHead' in httpRes && !httpRes.headersSent) {
              httpRes.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '1',
              });
              httpRes.end(JSON.stringify({ ok: false, error: 'api restarting' }));
            }
          });
        },
      },
      '/ws': { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
