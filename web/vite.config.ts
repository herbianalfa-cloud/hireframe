import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

/**
 * The pdf.js standard fonts (ADR-065), served as plain same-origin files under a folder named
 * for the pdf.js version, with their original names because pdf.js asks for them by name. They
 * load lazily, one file at a time, only when a previewed PDF names that font.
 */
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const pdfjsVersion = (
  JSON.parse(readFileSync(join(pdfjsRoot, 'package.json'), 'utf8')) as { version: string }
).version;
const fontsRoot = join(pdfjsRoot, 'standard_fonts');
const fontsPrefix = `/assets/pdfjs-${pdfjsVersion}/standard_fonts/`;
const pdfjsFonts: Plugin = {
  name: 'hireframe-pdfjs-fonts',
  configureServer(server) {
    server.middlewares.use(fontsPrefix, (request, response, next) => {
      const name = (request.url ?? '').slice(1).split('?')[0] ?? '';
      if (!readdirSync(fontsRoot).includes(name)) {
        next();
        return;
      }
      response.setHeader('Content-Type', 'application/octet-stream');
      response.end(readFileSync(join(fontsRoot, name)));
    });
  },
  generateBundle() {
    for (const name of readdirSync(fontsRoot)) {
      this.emitFile({
        type: 'asset',
        fileName: `${fontsPrefix.slice(1)}${name}`,
        source: readFileSync(join(fontsRoot, name)),
      });
    }
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), earlyFirebase, pdfjsFonts],
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
