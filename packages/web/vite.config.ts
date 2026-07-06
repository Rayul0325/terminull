import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite config for the Terminull web panel. Vitest reuses this config when
// running the package's tests.
//
// Dev proxy: the panel server enforces a same-origin check (originOk) on
// state-changing requests and WS upgrades, but treats requests WITHOUT an
// Origin header as trusted non-browser clients (curl/hooks). In dev the
// browser origin is the Vite server, so the proxy strips the Origin header —
// production serves the built app from the panel server itself (genuinely
// same-origin), where no stripping happens or is needed.
const PANEL_SERVER = 'http://127.0.0.1:7420';

function stripOrigin() {
  return {
    configure: (proxy: {
      on: (ev: string, cb: (proxyReq: { removeHeader(name: string): void }) => void) => void;
    }) => {
      proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'));
      proxy.on('proxyReqWs', (proxyReq) => proxyReq.removeHeader('origin'));
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: PANEL_SERVER, ...stripOrigin() },
      '/auth': { target: PANEL_SERVER, ...stripOrigin() },
      '/ws': { target: PANEL_SERVER, ws: true, ...stripOrigin() },
      '/pty': { target: PANEL_SERVER, ws: true, ...stripOrigin() },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Heavy, panel-scoped libraries stay out of the shell entry chunk
        // (size budget: shell ≤180KB gz — .size-limit.json enforces it).
        manualChunks: (id: string) => {
          if (id.includes('@xterm')) return 'xterm';
          if (id.includes('dockview')) return 'dockview';
          return undefined;
        },
      },
    },
  },
});
