import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = 'http://localhost:8090';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/ws': { target: SERVER, ws: true, changeOrigin: true },
      '/api': { target: SERVER, changeOrigin: true },
    },
  },
});
