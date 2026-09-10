import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

/**
 * Build identifier: short git sha + build time (UTC, minute precision).
 * Falls back to `build-<time>` when git is unavailable (e.g. Docker builds
 * without `.git`) and to `dev` for the dev server.
 */
function computeVersion(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(
    now.getUTCMinutes()
  )}`;
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return sha ? `${sha}-${stamp}` : `build-${stamp}`;
  } catch {
    return `build-${stamp}`;
  }
}

/** Emits dist/version.json so the server can report AppConfig.appVersion. */
function versionJsonPlugin(version: string): Plugin {
  return {
    name: 'creche-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) });
    },
  };
}

// The API server runs on :3000 in development; Vite proxies /api.
export default defineConfig(({ command }) => {
  const version = command === 'build' ? computeVersion() : 'dev';
  return {
    plugins: [react(), versionJsonPlugin(version)],
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    server: {
      port: 5173,
      host: true,
      proxy: {
        '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      target: 'es2022',
      // One JS bundle (~180 kB gzip) is intended: no route-level code splitting, no vendor chunk.
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: undefined,
          inlineDynamicImports: true,
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
