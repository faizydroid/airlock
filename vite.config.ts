import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    // No code splitting: a single bundle means a reviewer can verify the no-egress claim by
    // grepping one file.
    rollupOptions: { output: { manualChunks: undefined } },
    // The module-preload polyfill calls fetch() on same-origin asset URLs. It is harmless, but
    // it is the only fetch in the output, and removing it makes "this bundle contains no network
    // primitives" an exactly verifiable statement rather than one needing a footnote. With a
    // single bundle the polyfill buys nothing anyway.
    modulePreload: false
  },
  server: { port: 5173 }
});
