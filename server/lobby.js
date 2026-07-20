// 大厅与房间管理：建房/进房/准备/选角/聊天/开局/Bot 补位/断线处理/游戏循环驱动

import { Game, TICK_RATE, TILE } from './game.js';
import { BotBrain } from './bot.js';
import { C, S } from './protocol.js';
import { CHARACTERS, DEFAULT_CHAR, isValidChar } from './characters.js';

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 6; // 开局人数不足时用 Bot 补到这个数

export class Lobby {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.clients = new Map(); // ws -> {id, name, roomId, ws}
    this.byId = new Map();    // playerId -> client（O(1) 查找，广播用）
    this.rooms = new Map();   // roomId -> room
    this.seq = 1;
  }

  handle(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const client = this.clients.get(ws);
    switch (msg.t) {
      case C.HELLO: return this.onHello(ws, msg);
      case C.CREATE_ROOM: return client && this.onCreateRoom(client);
      case C.JOIN_ROOM: return client && this.onJoinRoom(client, msg);
      case C.LEAVE_ROOM: return client && this.onLeaveRoom(client);
      case C.READY: return client && this.onReady(client, msg);
      case C.SELECT_CHAR: return client && this.onSelectChar(client, msg);
      case C.CHAT: return client && this.onChat(client, msg);
      case C.START: return client && this.onStart(client);
      case C.INPUT: return client && this.onInput(client, msg);
      case C.PLACE_BOMB: return client && this.onPlaceBomb(client);
      case C.USE_ITEM: return client && this.onUseItem(client);
      default: break;
    }
    return undefined;
  }

  send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  sendTo(playerId, obj) {
    const c = this.byId.get(playerId);
    if (c) this.send(c.ws, obj);
  }

  isConnected(playerId) {
    return this.byId.has(playerId);
  }

  error(client, msg) {
    this.send(client.ws, { t: S.ERROR, msg });
  }

  onHello(ws, msg) {
    if (this.clients.has(ws)) return;
    let name = String(msg.name ?? '').trim().slice(0, 12) || '玩家';
    const taken = new Set([...this.clients.values()].map((c) => c.name));
    if (taken.has(name)) {
      let i = 2;
      while (taken.has(`${name}#${i}`)) i++;
      name = `${name}#${i}`;
    }
    const client = { id: `p${this.seq++}`, name, roomId: null, ws };
    this.clients.set(ws, client);
    this.byId.set(client.id, client);
    this.send(ws, { t: S.WELCOME, id: client.id, name: client.name });
    this.send(ws, { t: S.LOBBY, rooms: this.roomList() });
  }

  roomList() {
    return [...this.rooms.values()].map((r) => ({
      id: r.id, name: r.name, players: r.players.length, max: MAX_PLAYERS, inGame: r.inGame,
    }));
  }

  publicRoom(room) {
    return {
      id: room.id, name: room.name, hostId: room.hostId, inGame: room.inGame,
      // colorIndex 按 slot 顺序分配：进入房间时每个玩家一个颜色（同款角色也有不同颜色版本）
      players: room.players.map((p, i) => ({
        id: p.id, name: p.name, ready: p.ready, isBot: !!p.isBot, char: p.char, colorIndex: i,
      })),
    };
  }

  broadcastLobby() {
    const raw = JSON.stringify({ t: S.LOBBY, rooms: this.roomList() }); // 同一 payload 只序列化一次
    for (const [ws, c] of this.clients) if (!c.roomId && ws.readyState === 1) ws.send(raw);
  }

  broadcastRoom(room, obj) {
    const raw = JSON.stringify(obj); // 同一 payload 只序列化一次
    for (const p of room.players) {
      if (p.isBot) continue;
      const c = this.byId.get(p.id);
      if (c && c.ws.readyState === 1) c.ws.send(raw);
    }
  }

  broadcastRoomState(room) {
    this.broadcastRoom(room, { t: S.ROOM, room: this.publicRoom(room) });
  }

  onCreateRoom(client) {
    if (client.roomId) this.onLeaveRoom(client);
    const room = {
      id: `r${this.seq++}`, name: `${client.name} 的房间`, hostId: client.id,
      players: [{
        id: client.id, name: client.name, ready: false, isBot: false, char: DEFAULT_CHAR,
      }],
      inGame: false, game: null, brains: null, interval: null,
    };
    this.rooms.set(room.id, room);
    client.roomId = room.id;
    this.broadcastRoomState(room);
    this.broadcastLobby();
  }

  onJoinRoom(client, msg) {
    const room = this.rooms.get(msg.roomId);
    if (!room) return this.error(client, '房间不存在');
    if (client.roomId === room.id) return undefined;
    if (room.inGame) return this.error(client, '该房间正在对战中');
    if (room.players.length >= MAX_PLAYERS) return this.error(client, '房间已满');
    if (client.roomId) this.onLeaveRoom(client);
    // 加入房间默认就是准备状态，可在房间内取消
    room.players.push({
      id: client.id, name: client.name, ready: true, isBot: false, char: DEFAULT_CHAR,
    });
    client.roomId = room.id;
    this.broadcastRoomState(room);
    this.broadcastLobby();
    return undefined;
  }

  onLeaveRoom(client) {
    const room = this.rooms.get(client.roomId);
    client.roomId = null;
    if (room) {
      if (room.inGame && room.game) {
        // 对局中离开 = 阵亡，游戏结束时统一清理
        room.game.markDisconnected(client.id);
        room.players = room.players.filter((p) => p.id !== client.id);
      } else {
        room.players = room.players.filter((p) => p.id !== client.id);
        if (room.players.length === 0) {
          this.rooms.delete(room.id);
        } else {
          if (room.hostId === client.id) room.hostId = room.players[0].id; // 房主移交
          this.broadcastRoomState(room);
        }
      }
    }
    this.send(client.ws, { t: S.LOBBY, rooms: this.roomList() });
    this.broadcastLobby();
  }

  onReady(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (!room || room.inGame) return;
    const p = room.players.find((pl) => pl.id === client.id);
    if (p) {
      p.ready = !!msg.ready;
      this.broadcastRoomState(room);
    }
  }

  onSelectChar(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (!room || room.inGame || !isValidChar(msg.char)) return;
    const p = room.players.find((pl) => pl.id === client.id);
    if (p) {
      p.char = msg.char;
      this.broadcastRoomState(room);
    }
  }

  // 房间聊天：广播给全房（含发送者回显）；colorIndex 与 slot 颜色一致
  onChat(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (!room) return;
    const text = String(msg.text ?? '').trim().slice(0, 64);
    if (!text) return;
    const idx = room.players.findIndex((p) => p.id === client.id);
    if (idx < 0) return;
    this.broadcastRoom(room, {
      t: S.CHAT, id: client.id, name: room.players[idx].name, text, colorIndex: idx,
    });
  }

  onStart(client) {
    const room = this.rooms.get(client.roomId);
    if (!room || room.inGame) return;
    if (room.hostId !== client.id) return this.error(client, '只有房主可以开始游戏');
    const others = room.players.filter((p) => !p.isBot && p.id !== room.hostId);
    if (!others.every((p) => p.ready)) return this.error(client, '所有玩家准备后才能开始');
    this.startGame(room);
    return undefined;
  }

  onInput(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (room?.game) room.game.setInput(client.id, msg.dir);
  }

  onPlaceBomb(client) {
    const room = this.rooms.get(client.roomId);
    if (room?.game) room.game.placeBomb(client.id);
  }

  onUseItem(client) {
    const room = this.rooms.get(client.roomId);
    if (room?.game) room.game.useItem(client.id);
  }

  startGame(room) {
    // Bot 补位到最少 6 人；Bot 随机角色，以角色名命名
    while (room.players.length < MIN_PLAYERS) {
      const ch = CHARACTERS[Math.floor(this.random() * CHARACTERS.length)];
      room.players.push({
        id: `b${this.seq++}`, name: `${ch.name}(Bot)`, ready: true, isBot: true, char: ch.id,
      });
    }
    room.inGame = true;
    room.game = new Game(
      room.players.map((p) => ({
        id: p.id, name: p.name, isBot: p.isBot, char: p.char,
      })),
      { random: this.random },
    );
    room.brains = new Map();
    for (const p of room.players) if (p.isBot) room.brains.set(p.id, new BotBrain(p.id));
    const desc = room.players.map((p, i) => ({
      id: p.id, name: p.name, isBot: !!p.isBot, char: p.char, colorIndex: i,
    }));
    for (const p of room.players) {
      if (p.isBot) continue;
      this.sendTo(p.id, {
        t: S.GAME_START, map: room.game.gridRows(), players: desc, yourId: p.id, tileSize: TILE,
      });
    }
    room.interval = setInterval(() => this.tickRoom(room), 1000 / TICK_RATE);
    this.broadcastLobby();
  }

  tickRoom(room) {
    const game = room.game;
    if (!game) return;
    try {
      for (const [botId, brain] of room.brains) {
        const act = brain.decide(game);
        game.setInput(botId, act.dirs);
        if (act.place) game.placeBomb(botId);
        if (act.use) game.useItem(botId);
      }
      game.tick();
    } catch (e) {
      console.error('游戏循环异常', e);
    }
    this.broadcastRoom(room, { t: S.STATE, ...game.snapshot() });
    if (game.over) this.endGame(room);
  }

  endGame(room) {
    clearInterval(room.interval);
    const winner = room.game.winner;
    this.broadcastRoom(room, {
      t: S.GAME_OVER, winnerId: winner?.id ?? null, winnerName: winner?.name ?? null,
    });
    // 移除 Bot 与断线者，恢复默认准备状态，回到房间
    room.players = room.players.filter((p) => !p.isBot && this.isConnected(p.id));
    for (const p of room.players) p.ready = true;
    room.inGame = false;
    room.game = null;
    room.brains = null;
    room.interval = null;
    if (room.players.length === 0) {
      this.rooms.delete(room.id);
    } else {
      if (!room.players.some((p) => p.id === room.hostId)) room.hostId = room.players[0].id;
      this.broadcastRoomState(room);
    }
    this.broadcastLobby();
  }

  disconnect(ws) {
    const client = this.clients.get(ws);
    if (!client) return;
    this.clients.delete(ws);
    this.byId.delete(client.id);
    const room = this.rooms.get(client.roomId);
    if (room) {
      if (room.inGame && room.game) {
        room.game.markDisconnected(client.id); // 对局中断线按死亡处理
      } else {
        room.players = room.players.filter((p) => p.id !== client.id);
        if (room.players.length === 0) {
          this.rooms.delete(room.id);
        } else {
          if (room.hostId === client.id) room.hostId = room.players[0].id;
          this.broadcastRoomState(room);
        }
      }
    }
    this.broadcastLobby();
  }

  shutdown() {
    for (const room of this.rooms.values()) if (room.interval) clearInterval(room.interval);
  }
}
