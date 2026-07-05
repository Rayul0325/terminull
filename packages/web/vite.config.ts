import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite config for the Terminull web panel. Vitest reuses this config when
// running the package's tests.
export default defineConfig({
  plugins: [react()],
});
