// 6 人同局压测（手动运行：node tools/perf-sim.js；不进 node --test 默认集）
// 真实服务器（createApp）+ 6 个真实 WebSocket 客户端并发输入，测量：
//   - Lobby.tickRoom 每 tick 全过程耗时（Bot 决策 + game.tick + 快照广播）
//   - game.tick 引擎耗时 / game.snapshot 构造耗时
//   - STATE 消息字节数与到达间隔（客户端视角）
//   - 事件循环延迟、进程 CPU 与内存增量
// 场景 A：6 真人同控（本压测重点）；场景 B：1 真人 + 5 Bot（当前常态对照，Bot BFS 全开）
// 对局提前分出胜负时房主自动再开，保持全程满负载。

import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { createApp } from '../server/index.js';
import { Game } from '../server/game.js';
import { Lobby } from '../server/lobby.js';

const DIRS = ['up', 'down', 'left', 'right'];
const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
};
const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
const fmt = (v, unit = '') => (Array.isArray(v) || typeof v !== 'number' ? v : `${v.toFixed(2)}${unit}`);

// ---- 原型级仪表化（不改服务器代码）----
const m = { tickRoom: [], gameTick: [], snapshot: [], restarts: 0 };
const _tickRoom = Lobby.prototype.tickRoom;
Lobby.prototype.tickRoom = function (room) {
  const t = performance.now();
  _tickRoom.call(this, room);
  m.tickRoom.push(performance.now() - t);
};
const _tick = Game.prototype.tick;
Game.prototype.tick = function () {
  const t = performance.now();
  _tick.call(this);
  m.gameTick.push(performance.now() - t);
};
const _snapshot = Game.prototype.snapshot;
Game.prototype.snapshot = function () {
  const t = performance.now();
  const s = _snapshot.call(this);
  m.snapshot.push(performance.now() - t);
  return s;
};

async function connect(port, name, views) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const v = { id: null, lastStateAt: 0, gaps: [], bytes: [], states: 0 };
  views.push(v);
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.t === 'welcome') { v.id = msg.id; v.welcome = true; }
    if (msg.t === 'lobby' && msg.rooms.length) v.roomId = msg.rooms[0].id;
    if (msg.t === 'room') v.roomId = msg.room.id; // 房主建房后只会收到 room 消息（lobby 广播只发未进房者）
    if (msg.t === 'gameStart') v.started = true;
    if (msg.t === 'gameOver') v.over = (v.over ?? 0) + 1;
    if (msg.t === 'state') {
      const now = performance.now();
      if (v.lastStateAt) v.gaps.push(now - v.lastStateAt);
      v.lastStateAt = now;
      v.bytes.push(data.length ?? String(data).length);
      v.states++;
    }
  });
  await new Promise((res) => ws.on('open', res));
  ws.send(JSON.stringify({ t: 'hello', name }));
  await until(() => v.welcome);
  return { ws, v };
}

const until = (fn, timeout = 8000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (fn()) { clearInterval(iv); res(); }
    else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('until 超时')); }
  }, 15);
});

async function scenario(humans, seconds, label) {
  m.tickRoom = []; m.gameTick = []; m.snapshot = []; m.restarts = 0;
  const app = await createApp(0);
  const views = [];
  const hist = monitorEventLoopDelay();
  const cpu0 = process.cpuUsage();
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  try {
    const clients = [];
    for (let i = 0; i < humans; i++) clients.push(await connect(app.port, `压测${i + 1}`, views));
    clients[0].ws.send(JSON.stringify({ t: 'createRoom' }));
    await until(() => clients[0].v.roomId);
    for (let i = 1; i < humans; i++) {
      clients[i].ws.send(JSON.stringify({ t: 'joinRoom', roomId: clients[0].v.roomId }));
    }
    hist.enable();
    clients[0].ws.send(JSON.stringify({ t: 'start' }));
    await until(() => views.every((v) => v.started));

    // 并发输入：每人 100ms 变向/松键 + 0.5s 放泡 + 间歇 Ctrl（对局结束房主自动再开）
    const drivers = [];
    for (const c of clients) {
      drivers.push(setInterval(() => {
        if (c.ws.readyState !== 1) return;
        if (Math.random() < 0.7) c.ws.send(JSON.stringify({ t: 'input', dir: pick(DIRS, (Math.random() * 3) | 0) }));
        if (Math.random() < 0.2) c.ws.send(JSON.stringify({ t: 'placeBomb' }));
        if (Math.random() < 0.05) c.ws.send(JSON.stringify({ t: 'useItem' }));
      }, 100));
    }
    const restarter = setInterval(() => {
      const host = clients[0];
      if (views.some((v) => (v.over ?? 0) > 0) && host.ws.readyState === 1) {
        m.restarts++;
        host.ws.send(JSON.stringify({ t: 'start' }));
      }
    }, 1200);
    await new Promise((res) => setTimeout(res, seconds * 1000));
    for (const d of drivers) clearInterval(d);
    clearInterval(restarter);
    hist.disable();

    const wall = (performance.now() - t0) / 1000;
    const cpu = process.cpuUsage(cpu0);
    const rss1 = process.memoryUsage().rss;
    const allGaps = views.flatMap((v) => v.gaps);
    const allBytes = views.flatMap((v) => v.bytes);
    const statesTotal = views.reduce((s, v) => s + v.states, 0);
    console.log(`\n===== ${label}（${seconds}s，开局重开 ${m.restarts} 次）=====`);
    console.log(`tick 总数: ${m.tickRoom.length}（预期≈${Math.round(seconds * 30)}）  tick 间隔客户端侧: 均值 ${fmt(avg(allGaps), 'ms')} p95 ${fmt(pct(allGaps, 0.95), 'ms')} 最大 ${fmt(pct(allGaps, 1), 'ms')}`);
    console.log(`tickRoom 全过程: 均值 ${fmt(avg(m.tickRoom), 'ms')} p95 ${fmt(pct(m.tickRoom, 0.95), 'ms')} p99 ${fmt(pct(m.tickRoom, 0.99), 'ms')} 最大 ${fmt(pct(m.tickRoom, 1), 'ms')}   (每 tick 预算 33.3ms)`);
    console.log(`  其中 game.tick: 均值 ${fmt(avg(m.gameTick), 'ms')} p99 ${fmt(pct(m.gameTick, 0.99), 'ms')} 最大 ${fmt(pct(m.gameTick, 1), 'ms')}`);
    console.log(`  其中 snapshot:  均值 ${fmt(avg(m.snapshot), 'ms')} p99 ${fmt(pct(m.snapshot, 0.99), 'ms')} 最大 ${fmt(pct(m.snapshot, 1), 'ms')}`);
    console.log(`STATE 消息: 均值 ${fmt(avg(allBytes), 'B')} 最大 ${fmt(pct(allBytes, 1), 'B')}  总下发 ${(allBytes.reduce((s, b) => s + b, 0) / 1048576).toFixed(1)}MB / ${statesTotal} 条（全员合计）`);
    console.log(`事件循环延迟: 均值 ${fmt(hist.mean / 1e6, 'ms')} p99 ${fmt(hist.percentile(0.99) / 1e6, 'ms')} 最大 ${fmt(hist.max / 1e6, 'ms')}`);
    console.log(`进程 CPU: ${(((cpu.user + cpu.system) / 1e6) / wall * 100).toFixed(1)}%（单核当量）  RSS 增量: ${((rss1 - rss0) / 1048576).toFixed(1)}MB`);
    for (const c of clients) c.ws.close();
  } finally {
    await app.close();
  }
}

console.log('== 6 人同局压测 ==');
await scenario(6, 30, '场景 A · 6 真人同时操控');
await scenario(1, 30, '场景 B · 1 真人 + 5 Bot（对照）');
console.log('\nDONE');
process.exit(0);
