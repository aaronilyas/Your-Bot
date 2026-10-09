import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({
  base: './', plugins: [react(), {
    name: 'renderer-csp',
    transformIndexHtml: {
      order: 'pre',
      handler: html => command === 'serve'
        ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
        : html.replace("connect-src 'self' ws://127.0.0.1:5173", "connect-src 'none'"),
    },
  }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist/renderer', emptyOutDir: true },
}));
