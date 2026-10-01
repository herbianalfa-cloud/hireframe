import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // `source` resolves `@hireframe/shared` to its TypeScript sources (ADR-012).
    conditions: ['source', ...defaultClientConditions],
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    target: 'es2023',
    rolldownOptions: {
      output: {
        // Vendor chunks for what every visit needs (ADR-021): they change less often than the
        // app, so they stay cached across deploys. Functions and Storage are left out on purpose:
        // they load on first use (services/firebase.ts).
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|react-router|scheduler|@tanstack)[\\/]/,
              priority: 30,
            },
            {
              name: 'firestore',
              test: /node_modules[\\/](@firebase[\\/](firestore|webchannel-wrapper)|firebase[\\/]firestore|re2js)[\\/]/,
              priority: 25,
            },
            {
              name: 'firebase',
              test: /node_modules[\\/](@firebase[\\/](app|app-check|auth|component|logger|util)|firebase[\\/](app|app-check|auth)|idb)[\\/]/,
              priority: 20,
            },
            { name: 'zod', test: /node_modules[\\/]zod[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
});
