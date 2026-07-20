// 服务入口：http 静态托管 client/ + WebSocket 接入

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Lobby } from './lobby.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function createApp(port = 3001) {
  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (urlPath === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    if (urlPath === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const file = path.normalize(path.join(CLIENT_DIR, urlPath));
    if (!file.startsWith(CLIENT_DIR)) { // 防目录穿越
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const headers = { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' };
      if (urlPath.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=86400'; // 素材基本不变，缓存一天
      res.writeHead(200, headers);
      res.end(data);
    });
  });

  const lobby = new Lobby();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      try {
        lobby.handle(ws, data.toString());
      } catch (e) {
        console.error('消息处理异常', e);
      }
    });
    ws.on('close', () => lobby.disconnect(ws));
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({
        server,
        wss,
        lobby,
        port: server.address().port,
        close: () => new Promise((done) => {
          lobby.shutdown();
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => server.close(done));
        }),
      });
    });
  });
}

// 直接运行（node server/index.js）时启动服务
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3001;
  createApp(port).then(({ port: p }) => {
    console.log(`泡泡堂服务已启动: http://localhost:${p}`);
  });
}
