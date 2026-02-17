import path from 'path';
import fs from 'fs';
import { defineConfig, loadEnv, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function saveDataPlugin(): Plugin {
  return {
    name: 'save-data',
    configureServer(server) {
      // Delete a region folder
      server.middlewares.use('/api/delete-folder', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { folder } = JSON.parse(body) as { folder: string };
            const dataDir = path.resolve(__dirname, 'public/data');
            const folderPath = path.resolve(dataDir, folder);
            // Safety: ensure we're deleting inside public/data
            if (!folderPath.startsWith(dataDir + path.sep) || folderPath === dataDir) {
              res.statusCode = 400;
              res.end(`Invalid folder: ${folder}`);
              return;
            }
            fs.rmSync(folderPath, { recursive: true, force: true });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });

      server.middlewares.use('/api/save-data', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { files } = JSON.parse(body) as { files: { path: string; content: string }[] };
            const dataDir = path.resolve(__dirname, 'public/data');
            for (const file of files) {
              const filePath = path.resolve(dataDir, file.path);
              // Safety: ensure we're writing inside public/data
              if (!filePath.startsWith(dataDir)) {
                res.statusCode = 400;
                res.end(`Invalid path: ${file.path}`);
                return;
              }
              fs.mkdirSync(path.dirname(filePath), { recursive: true });
              fs.writeFileSync(filePath, file.content, 'utf-8');
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, count: files.length }));
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });
    }
  };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), saveDataPlugin()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
