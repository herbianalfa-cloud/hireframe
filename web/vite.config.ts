import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

/**
 * Build only (ADR-061): the Firebase config fetch starts from the HTML instead of after the
 * entry script has run, and the three Google API hosts the first reads go to are connected
 * early. Same URL and CORS mode as the app's `fetch`, so the preload is reused. No new host.
 */
const earlyFirebase: Plugin = {
  name: 'hireframe-early-firebase',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'link',
      attrs: { rel: 'preload', href: '/__/firebase/init.json', as: 'fetch', crossorigin: '' },
      injectTo: 'head-prepend',
    },
    ...[
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com',
      'https://firestore.googleapis.com',
    ].map((href) => ({
      tag: 'link',
      attrs: { rel: 'preconnect', href, crossorigin: '' },
      injectTo: 'head-prepend' as const,
    })),
  ],
};

export default defineConfig({
  plugins: [react(), tailwindcss(), earlyFirebase],
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
        // The shared constants (collection names, paths, region) land in a chunk of their own,
        // all from packages/shared. Its name must not start with `firestore-`: check:bundle and
        // the prefetch find the Firestore SDK chunk by that name (ADR-066).
        chunkFileNames: (chunk) =>
          chunk.moduleIds.length > 0 &&
          chunk.moduleIds.every((id) => /[\\/]packages[\\/]shared[\\/]/.test(id))
            ? 'assets/paths-[hash].js'
            : 'assets/[name]-[hash].js',
        // Vendor chunks for what every visit needs (ADR-021): they change less often than the
        // app, so they stay cached across deploys. Functions and Storage are left out on purpose:
        // they load on first use (services/firebase.ts). The `firestore` group is a lazy chunk:
        // services/firestore-boot.ts imports it once the Firebase core is up (ADR-066), and
        // check:bundle names it, so keep the group (a stable cached chunk with its own cap).
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
              // Its dependencies (@firebase/app, util, component) belong to the `firebase` group
              // below. Pulled in here they made the entry import this chunk (ADR-066).
              includeDependenciesRecursively: false,
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
