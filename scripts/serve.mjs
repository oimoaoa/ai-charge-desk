import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CONFIG } from '../src/config.js';
import { buildSnapshot } from '../src/lib/snapshot.js';

const port = Number(process.env.PORT ?? 8787);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === '/api/snapshot') {
      const snapshot = await readSnapshotOrBuild();
      sendJson(response, snapshot);
      return;
    }

    if (url.pathname === '/api/live-snapshot') {
      const snapshot = await buildSnapshot();
      sendJson(response, snapshot);
      return;
    }

    const filePath = resolveDashboardFile(url.pathname);
    if (!filePath) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const body = await fs.promises.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-store'
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`AI Charge Desk error: ${error.message}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`AI Charge Desk running at http://127.0.0.1:${port}`);
});

function resolveDashboardFile(pathname) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.resolve(CONFIG.dashboardDir, `.${cleanPath}`);
  if (!fullPath.startsWith(CONFIG.dashboardDir)) return null;
  if (!fs.existsSync(fullPath)) return null;
  return fullPath;
}

function sendJson(response, payload) {
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function readSnapshotOrBuild() {
  try {
    const raw = await fs.promises.readFile(CONFIG.snapshotPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return buildSnapshot();
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}
