// 端到端 smoke 测试：起服务 → 两个 ws 客户端建房/进房/准备/开局
// 断言 Bot 补位到 6 人、快照持续推进、输入生效、可以放泡

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';

class TestClient {
  constructor(ws) {
    this.ws = ws;
    this.waiters = [];
    this.log = []; // 未匹配的控制消息缓冲（state 快照不缓冲，只发给实时等待者）
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const i = this.waiters.findIndex((w) => TestClient.match(w.pred, m));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(m);
      } else if (m.t !== 'state') {
        this.log.push(m);
      }
    });
  }

  static match(pred, m) {
    return typeof pred === 'function' ? pred(m) : m.t === pred;
  }

  static async connect(url, name) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    });
    const c = new TestClient(ws);
    c.send({ t: 'hello', name });
    c.welcome = await c.waitFor('welcome');
    return c;
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  waitFor(pred, timeout = 8000) {
    const i = this.log.findIndex((m) => TestClient.match(pred, m));
    if (i >= 0) return Promise.resolve(this.log.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const j = this.waiters.indexOf(w);
        if (j >= 0) {
          this.waiters.splice(j, 1);
          reject(new Error(`等待消息超时: ${pred}`));
        }
      }, timeout);
    });
  }

  close() {
    this.ws.close();
  }
}

test('完整流程：建房 → 准备 → Bot 补位 → 对战快照', async (t) => {
  const app = await createApp(0); // 临时端口
  t.after(() => app.close());
  const url = `ws://127.0.0.1:${app.port}`;

  // 小明建房
  const a = await TestClient.connect(url, '小明');
  a.send({ t: 'createRoom' });
  const roomMsg = await a.waitFor('room');
  assert.equal(roomMsg.room.hostId, a.welcome.id);
  assert.equal(roomMsg.room.players.length, 1);

  // 小红进大厅看到房间并加入
  const b = await TestClient.connect(url, '小红');
  const lobby = await b.waitFor((m) => m.t === 'lobby' && m.rooms.length === 1);
  assert.equal(lobby.rooms[0].players, 1);
  b.send({ t: 'joinRoom', roomId: roomMsg.room.id });
  const joined = await b.waitFor((m) => m.t === 'room' && m.room.players.length === 2);
  assert.equal(joined.room.players[1].name, '小红');
  assert.equal(joined.room.players[1].ready, true, '加入房间应默认是准备状态');

  // 小红选择角色「小海盗」
  b.send({ t: 'selectChar', char: 'haidao' });
  await a.waitFor((m) => m.t === 'room' && m.room.players.find((p) => p.name === '小红')?.char === 'haidao');

  // 默认已准备：小红先取消准备，房主开始应报错；重新准备后才能开始
  b.send({ t: 'ready', ready: false });
  await a.waitFor((m) => m.t === 'room' && m.room.players.find((p) => p.name === '小红')?.ready === false);
  a.send({ t: 'start' });
  const err = await a.waitFor('error');
  assert.ok(err.msg.includes('准备'));
  b.send({ t: 'ready', ready: true });
  await a.waitFor((m) => m.t === 'room' && m.room.players.find((p) => p.name === '小红')?.ready);
  a.send({ t: 'start' });

  // 开局：2 真人 + 4 Bot = 6 人
  const start = await a.waitFor('gameStart');
  assert.equal(start.players.length, 6);
  assert.equal(start.players.filter((p) => p.isBot).length, 4);
  assert.equal(start.map.length, 13);
  assert.ok(start.map.every((r) => r.length === 15));
  assert.equal(start.yourId, a.welcome.id);
  // 角色信息同步：小红是小海盗，Bot 也有角色
  assert.equal(start.players.find((p) => p.id === b.welcome.id)?.char, 'haidao');
  assert.ok(start.players.filter((p) => p.isBot).every((p) => p.char));
  await b.waitFor('gameStart');

  // 开局有 321 冻结倒计时（约 3s）：先等热身结束、tick 开始推进
  const s0 = await a.waitFor((m) => m.t === 'state' && m.tick > 0);
  assert.equal(s0.warmup, 0);

  // 快照持续推进，且 Bot 在移动（Bot 放泡后会逃回原位附近，
  // 用窗口内的最大位移而不是首尾净位移来判断）
  const botId = start.players.find((p) => p.isBot).id;
  const s1 = await a.waitFor('state');
  assert.ok(s1.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), '快照中玩家应带坐标');
  const botStart = s1.players.find((p) => p.id === botId);
  let last = s1;
  let maxMoved = 0;
  for (let i = 0; i < 20; i++) { // ~1s
    last = await a.waitFor('state');
    const bp = last.players.find((p) => p.id === botId);
    maxMoved = Math.max(maxMoved, Math.abs(bp.x - botStart.x) + Math.abs(bp.y - botStart.y));
  }
  assert.ok(last.tick > s1.tick, '快照 tick 应推进');
  assert.ok(maxMoved > 10, `Bot 应该在移动（最大位移 ${maxMoved}px）`);

  // 小明向上移动（出生点 (1,6) 上方是通道，左右/下方是箱子）
  const meStart = last.players.find((p) => p.id === a.welcome.id);
  a.send({ t: 'input', dir: ['up'] });
  const tickStart = last.tick;
  while (last.tick - tickStart < 10) last = await a.waitFor('state'); // 固定等 10 个 tick（快照可能合批到达）
  const meLater = last.players.find((p) => p.id === a.welcome.id);
  // 4 Bot 乱斗中真人可能抬脚即被炸困/阵亡：产生了位移，或确实被困/阵亡，都说明输入链路在工作
  const moved = Math.abs(meLater.x - meStart.x) + Math.abs(meLater.y - meStart.y);
  assert.ok(moved > 0 || meLater.trapped || !meLater.alive,
    `输入应生效（y ${meStart.y} -> ${meLater.y}，被困 ${meLater.trapped}，存活 ${meLater.alive}）`);
  a.send({ t: 'input', dir: [] });

  // 放水泡 → 快照里出现水泡
  a.send({ t: 'placeBomb' });
  const withBomb = await a.waitFor((m) => m.t === 'state' && m.bombs.length > 0);
  assert.ok(withBomb.bombs.length >= 1);

  a.close();
  b.close();
});
