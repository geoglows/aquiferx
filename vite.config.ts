import path from 'path';
import fs from 'fs';
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Sample Data is the folders listed in public/data/index.json. Everything
// else in public/data (a region copied in while developing) is copied into
// dist by Vite like any public file, so it is removed again here.
function shipOnlySampleData(): Plugin {
  return {
    name: 'ship-only-sample-data',
    apply: 'build',
    closeBundle() {
      const indexPath = path.resolve(__dirname, 'public/data/index.json');
      const keep = new Set<string>(JSON.parse(fs.readFileSync(indexPath, 'utf-8')).regions.map((r: { id: string }) => r.id));
      const distData = path.resolve(__dirname, 'dist/data');
      for (const entry of fs.readdirSync(distData, { withFileTypes: true })) {
        if (entry.isDirectory() && !keep.has(entry.name)) {
          fs.rmSync(path.join(distData, entry.name), { recursive: true, force: true });
        }
      }
    },
  };
}

export default defineConfig({
  // The analysis workers import shared modules, so they are split into
  // chunks, which the default iife worker format cannot express
  worker: { format: 'es' },
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react(), shipOnlySampleData()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    }
  }
});
