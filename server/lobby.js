// 大厅与房间管理：建房/进房/准备/选角/聊天/开局/Bot 补位/断线处理/游戏循环驱动

import { Game, TICK_RATE, TILE } from './game.js';
import { BotBrain } from './bot.js';
import { C, S } from './protocol.js';
import { CHARACTERS, DEFAULT_CHAR, isValidChar } from './characters.js';

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 6; // 开局人数不足时用 Bot 补到这个数

function random_name()
{
    /* 骰子随机昵称 */
    const FIRST = ['快乐', '无敌', '闪电', '暴走', '泡泡', '奶茶', '深海', '元气', '榴莲', '章鱼', '海盗', '甜心', '蓝莓', '冲锋'];
    const SECOND = ['宝宝', '小乖', '战士', '船长', '鱼丸', '果冻', '皮皮', '球球', '大侠', '萌新', '骑士', '魔王', '胖胖', '糖豆'];
      const pick = (arr) => arr[(Math.random() * arr.length) | 0];
      let name = pick(FIRST) + pick(SECOND);
      if (Math.random() < 0.25) name += ((Math.random() * 98) | 0) + 1;
      return name.slice(0, 12);
}


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
      case C.SPECTATE_ROOM: return client && this.onSpectateRoom(client, msg);
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
      spectators: room.spectators.size,
      // colorIndex 按 slot 顺序分配：进入房间时每个玩家一个颜色（同款角色也有不同颜色版本）
      players: room.players.map((p, i) => ({
        id: p.id, name: p.name, ready: p.ready, isBot: !!p.isBot, char: p.char, colorIndex: i,
      })),
    };
  }

  // 玩家静态名册（gameStart 用）：id/名字/是否Bot/角色/队伍颜色，按 slot 顺序
  playersDesc(room) {
    return room.players.map((p, i) => ({
      id: p.id, name: p.name, isBot: !!p.isBot, char: p.char, colorIndex: i,
    }));
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
    for (const specId of room.spectators) {
      const c = this.byId.get(specId);
      if (c && c.ws.readyState === 1) c.ws.send(raw);
    }
  }

  broadcastRoomState(room) {
    this.broadcastRoom(room, { t: S.ROOM, room: this.publicRoom(room) });
  }

  onCreateRoom(client) {
    if (client.roomId) this.leaveCurrentRoom(client);
    const room = {
      id: `r${this.seq++}`, name: `${client.name} 的房间`, hostId: client.id,
      players: [{
        id: client.id, name: client.name, ready: false, isBot: false, char: DEFAULT_CHAR,
      }],
      inGame: false, game: null, brains: null, interval: null, spectators: new Set(),
    };
    console.log(`New room id: ${room.id}`);
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
    if (client.roomId) this.leaveCurrentRoom(client);
    // 加入房间默认就是准备状态，可在房间内取消
    room.players.push({
      id: client.id, name: client.name, ready: true, isBot: false, char: DEFAULT_CHAR,
    });
    client.roomId = room.id;
    this.broadcastRoomState(room);
    this.broadcastLobby();
    return undefined;
  }

  // 纯观战：不占玩家位、不用选角色，能收到这个房间之后所有的 room/state/chat/gameOver 广播。
  // 对局中也能中途加入观战（真正的玩家加入则不行，见上面 onJoinRoom 的 inGame 检查）。
  // 视角上，客户端会把 gameStart 的 yourId 当成"要跟拍/显示 HUD 的那个人"：
  // 这里用房主的 id，让观众获得"跟着房主视角看"的体验，不用改客户端摄像机逻辑。
  onSpectateRoom(client, msg) {
    const room = this.rooms.get(msg.roomId);
    if (!room) return this.error(client, '房间不存在');
    if (client.roomId === room.id && room.spectators.has(client.id)) return undefined;
    if (client.roomId) this.leaveCurrentRoom(client);
    room.spectators.add(client.id);
    client.roomId = room.id;
    this.send(client.ws, { t: S.ROOM, room: this.publicRoom(room) });
    if (room.inGame && room.game) {
      this.send(client.ws, {
        t: S.GAME_START,
        map: room.game.gridRows(),
                players: this.playersDesc(room),
                yourId: room.hostId,
                tileSize: TILE,
      });
      this.send(client.ws, { t: S.STATE, ...room.game.snapshot() });
    }
    this.broadcastLobby();
    return undefined;
  }

  onLeaveRoom(client) {
    this.leaveCurrentRoom(client);
    this.send(client.ws, { t: S.LOBBY, rooms: this.roomList() });
    this.broadcastLobby();
  }

  // 把客户端从当前所在的房间移除（不管之前是玩家还是观众），处理房间清理/房主转移。
  // 不负责"回大厅"相关的播报，调用方各自决定要不要发（onLeaveRoom 发，
  // onCreateRoom/onJoinRoom/onSpectateRoom 紧接着会发新房间的状态，不用重复发大厅列表）
  leaveCurrentRoom(client) {
    const room = this.rooms.get(client.roomId);
    client.roomId = null;
    if (!room) return;
    if (room.spectators.has(client.id)) {
      room.spectators.delete(client.id);
      return; // 观众离开不影响玩家列表/房主/开局逻辑，也不用重新广播房间状态
    }
      if (room.inGame && room.game) {
        // 对局中离开 = 阵亡，游戏结束时统一清理
        room.game.markDisconnected(client.id);
        room.players = room.players.filter((p) => p.id !== client.id);
      } else {
        room.players = room.players.filter((p) => p.id !== client.id);
      if (room.players.length === 0 && room.spectators.size === 0) {
          this.rooms.delete(room.id);
        return;
      }
      if (room.hostId === client.id && room.players.length) room.hostId = room.players[0].id;
          this.broadcastRoomState(room);
        }
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
      let bot_name = random_name();
      room.players.push({
        // id: `b${this.seq++}`, name: `${ch.name}(Bot)`, ready: true, isBot: true, char: ch.id,
        id: `b${this.seq++}`, name: `${bot_name}`, ready: true, isBot: true, char: ch.id,
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
    const desc = this.playersDesc(room);
    for (const p of room.players) {
      if (p.isBot) continue;
      this.sendTo(p.id, {
        t: S.GAME_START, map: room.game.gridRows(), players: desc, yourId: p.id, tileSize: TILE,
      });
    }
    // 开局前就已经在房间里的观众也要收到 gameStart，才能初始化画面；
    // yourId 用房主的，观众客户端据此"跟拍"房主视角（不用改客户端摄像机逻辑）
    for (const specId of room.spectators) {
      this.sendTo(specId, {
        t: S.GAME_START, map: room.game.gridRows(), players: desc, yourId: room.hostId, tileSize: TILE,
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
    if (room.players.length === 0 && room.spectators.size === 0) {
      this.rooms.delete(room.id);
    } else {
      if (room.players.length && !room.players.some((p) => p.id === room.hostId)) {
        room.hostId = room.players[0].id;
      }
      this.broadcastRoomState(room);
    }
    this.broadcastLobby();
  }

  disconnect(ws) {
    const client = this.clients.get(ws);
    if (!client) return;
    this.clients.delete(ws);
    this.byId.delete(client.id);
    this.leaveCurrentRoom(client);
    this.broadcastLobby();
  }

  shutdown() {
    for (const room of this.rooms.values()) if (room.interval) clearInterval(room.interval);
  }
}
