/**
 * Build and test configuration.
 *
 * The build goes to `dist/`, which CDK publishes to the web bucket (infra/lib/constructs/web-distribution.ts).
 * `npm run dev` serves the app locally and forwards `/api` and `/config.json` to a deployed environment when
 * KC_DEV_TARGET is set (for example `KC_DEV_TARGET=https://dxxxx.cloudfront.net npm run dev`).
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const target = process.env.KC_DEV_TARGET;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false, // no source maps in the public bucket
  },
  server: target
    ? { proxy: { '/api': { target, changeOrigin: true }, '/config.json': { target, changeOrigin: true } } }
    : undefined,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test-setup.ts'],
  },
});
