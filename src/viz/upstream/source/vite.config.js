import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], base: '/', css: { preprocessorOptions: { less: { javascriptEnabled: true } } }, build: { target: 'es2022', sourcemap: false } });
