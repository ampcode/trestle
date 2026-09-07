import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  base: '/',
  // G6VP's Less uses webpack's historical ~ prefix. Resolve it without editing node_modules.
  resolve: { alias: [{ find: /^~antd\//, replacement: fileURLToPath(new URL('./node_modules/antd/', import.meta.url)) }] },
  css: { preprocessorOptions: { less: { javascriptEnabled: true } } },
  // Leave room for Vite's own reads under orbs' 1024-file-descriptor limit.
  build: { target: 'es2022', sourcemap: false, rollupOptions: { maxParallelFileOps: 64 } },
});
