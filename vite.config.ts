import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite's root is the repo root (index.html lives here). Do NOT pass --config, which
// would select the config file without changing the root.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'client/dist', emptyOutDir: true },
  server: {
    host: true, // so tablets on the LAN can reach the dev server
    proxy: {
      '/api': {
        // NEVER "localhost": on Windows it resolves ::1 first and ECONNREFUSEDs
        // against an IPv4-bound Node process.
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
