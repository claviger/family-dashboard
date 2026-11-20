import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:3000';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    // The CSP has no font-src, so fonts fall back to default-src 'self', which blocks data: URIs.
    // Fonts are always emitted as files under /assets; everything else keeps Vite's default limit.
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf)$/i.test(filePath) ? false : undefined),
    // Two pages: the app, and the Link page the server sends with its own CSP (src/web/plaid/link.ts).
    // Vite 8 bundles with Rolldown: `rollupOptions` is its deprecated alias.
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./src/web/index.html', import.meta.url)),
        'plaid-link': fileURLToPath(new URL('./src/web/plaid-link.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    // `/csp-report` takes the Link pages' report-only CSP reports (review G3-M2), so it goes to the server too.
    proxy: { '/api': api, '/auth': api, '/connect': api, '/webhooks': api, '/healthz': api, '/csp-report': api },
  },
});
