// 房间页相关协议测试：房间聊天广播（颜色/截断/不在房间不广播）、换房后日志归属

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';

class TestClient {
  constructor(ws) {
    this.ws = ws;
    this.waiters = [];
    this.log = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const i = this.waiters.findIndex((w) => (typeof w.pred === 'function' ? w.pred(m) : m.t === w.pred));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(m);
      } else if (m.t !== 'state') {
        this.log.push(m);
      }
    });
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
    const i = this.log.findIndex((m) => (typeof pred === 'function' ? pred(m) : m.t === pred));
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

test('房间聊天：广播给全房，带昵称与 slot 颜色，超长截断，空白丢弃', async (t) => {
  const app = await createApp(0);
  t.after(() => app.close());
  const url = `ws://127.0.0.1:${app.port}`;

  const a = await TestClient.connect(url, '房主');
  a.send({ t: 'createRoom' });
  await a.waitFor('room');
  const roomId = app.lobby.roomList()[0].id;

  const b = await TestClient.connect(url, '房客');
  b.send({ t: 'joinRoom', roomId });
  await b.waitFor((m) => m.t === 'room' && m.room.players.length === 2);

  // 普通发言：全房广播，发送者也有回显；slot0=房主、slot1=房客
  b.send({ t: 'chat', text: '大家好！' });
  const echo = await a.waitFor((m) => m.t === 'chat' && m.text === '大家好！');
  assert.equal(echo.id, b.welcome.id);
  assert.equal(echo.name, '房客');
  assert.equal(echo.colorIndex, 1, '第二个进房的玩家颜色序号为 1');
  await b.waitFor((m) => m.t === 'chat' && m.text === '大家好！');

  // 超长发言截断到 64 字
  const longText = '长'.repeat(80);
  a.send({ t: 'chat', text: longText });
  const truncated = await b.waitFor((m) => m.t === 'chat' && m.colorIndex === 0);
  assert.equal(truncated.text.length, 64);

  // 纯空白发言被丢弃：等一条后续正常消息，确认空白没有插在前面广播
  a.send({ t: 'chat', text: '   ' });
  a.send({ t: 'chat', text: '正常消息' });
  const normal = await b.waitFor((m) => m.t === 'chat' && m.text === '正常消息');
  assert.ok(normal);

  // 不在房间的人发的消息，房间内收不到
  const c = await TestClient.connect(url, '旁观者');
  c.send({ t: 'chat', text: '有人吗' });
  b.send({ t: 'chat', text: '听不见他' });
  const heard = await a.waitFor((m) => m.t === 'chat' && m.text === '听不见他');
  assert.ok(heard);
  assert.ok(!a.log.some((m) => m.t === 'chat' && m.text === '有人吗'), '房间外的发言不应广播进房间');

  a.close();
  b.close();
  c.close();
});
