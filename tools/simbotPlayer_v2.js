// 外部 WebSocket 机器人：像真实玩家一样连接服务器（走完整协议，而非直接调用引擎），
// 决策逻辑复用 server/bot.js 里内置 Bot 的危险图 + BFS 寻路算法。
//
// 用法：
//   node tools/simPlayerBot.js --list                   # 只看当前大厅有哪些房间（id/名称/人数），不建房不加房
//   node tools/simPlayerBot.js                          # 建房自己开一局单人练习（Bot补位到6人）
//   node tools/simPlayerBot.js --join r3                # 按房间号加入
//   node tools/simPlayerBot.js --join "欢乐斗泡"         # 按房间名加入（大小写不敏感，取第一个匹配且未开局的）
//   node tools/simPlayerBot.js --url ws://host:3001 --name 我的机器人
//
// 依赖：仅用到仓库自带的 ws 包，无需额外安装。

import { WebSocket } from 'ws';
import { BotBrain } from '../server/bot.js';
import { TILE, COLS, ROWS, EMPTY, WALL, SOFT, HOUSE, CRATE, isSoft } from '../server/map.js';
import { C, S } from '../server/protocol.js';

const tile = (v) => Math.floor(v / TILE);
const key = (x, y) => `${x},${y}`;
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// 成长类道具：速度鞋、泡泡数、红魔（瞬间拉满速度）——空档期优先抢
const GROWTH_ITEMS = new Set(['shoe', 'bubble', 'devil']);
// 可达安全空地 / 当前地图总空地 达到这个比例，才算"大片生存空间"
const OPEN_SPACE_THRESHOLD = 0.45;
// 哪怕空间够大，敌人近到这个曼哈顿距离（格）内也不优先捡道具，先顾眼前
const NEAR_ENEMY_GRACE = 3;

// 只给这个外部机器人加"空档期优先抢成长道具"的策略，不改动 server/bot.js，
// 所以内置 Bot（房间补位用的那些）行为完全不受影响。
// 通过继承 BotBrain 并重写 findObjective 实现：其余决策（逃命/放泡/追人/炸墙）
// 全部复用父类原逻辑，只在"没什么紧急事"时插入一段"优先去捡道具"的判断。
class GrowthPriorityBrain extends BotBrain {
    findObjective(game, me, tx, ty, danger) {
        const items = game.items;
        const enemies = [...game.players.values()].filter(
            (p) => p.id !== this.id && p.alive && !p.trapped,
        );

        const growthAvailable = items.some((it) => GROWTH_ITEMS.has(it.kind));
        if (growthAvailable) {
            const nearestEnemyDist = enemies.length
            ? Math.min(...enemies.map((e) => Math.abs(tile(e.x) - tx) + Math.abs(tile(e.y) - ty)))
            : Infinity;
            if (nearestEnemyDist >= NEAR_ENEMY_GRACE
                && this.safeSpaceRatio(game, tx, ty, danger) >= OPEN_SPACE_THRESHOLD) {
                const growthGoal = (x, y) => items.some((it) => x === it.x && y === it.y && GROWTH_ITEMS.has(it.kind));
            const path = this.bfs(game, tx, ty, growthGoal, { avoid: danger });
            if (path && path.length) return path;
                }
        }

        // 没触发"空档抢道具"时，原样走父类逻辑（追人/捡任意道具/炸软块）
        return super.findObjective(game, me, tx, ty, danger);
    }

    // 从(sx,sy)出发、避开danger格，BFS能到达的空地格数 / 当前地图空地总格数。
    // 用作"当前处境有多宽裕"的量化指标：越接近1说明活动范围越不受限，
    // 值得先去捡道具垫垫家底，而不是揣着基础属性到处莽
    safeSpaceRatio(game, sx, sy, danger) {
        let total = 0;
        for (let y = 0; y < ROWS; y++) {
            for (let x = 0; x < COLS; x++) if (game.grid[y][x] === EMPTY) total++;
        }
        if (total === 0) return 0;
        const visited = new Set([key(sx, sy)]);
        const queue = [[sx, sy]];
        let reachable = 1; // 起点本身（调用时机保证起点必安全）
        while (queue.length) {
            const [x, y] = queue.shift();
            for (const [dx, dy] of DIRS4) {
                const nx = x + dx;
                const ny = y + dy;
                const nk = key(nx, ny);
                if (visited.has(nk) || danger.has(nk) || !this.walkable(game, nx, ny)) continue;
                visited.add(nk);
                reachable++;
                queue.push([nx, ny]);
            }
        }
        return reachable / total;
    }
}

// ---- 命令行参数 ----
const args = process.argv.slice(2);
const opt = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : def;
};
const URL = opt('--url', 'ws://localhost:3001');
const NAME = opt('--name', `Bot玩家${Math.floor(Math.random() * 1000)}`);
const JOIN_ROOM = opt('--join', null); // 房间号或房间名；不传则自己建房单人开局
const LIST_ONLY = args.includes('--list'); // 只打印大厅房间列表，不建房不加房

// 地图字符 -> 数值编码，和 server/map.js 里的 CODES 保持一致
const CHAR_CODES = { '.': EMPTY, '#': WALL, o: SOFT, H: HOUSE, x: CRATE };
const rowsToGrid = (rows) => rows.map((row) => [...row].map((ch) => CHAR_CODES[ch] ?? EMPTY));

// 用服务端下发的快照数据重建一个满足 BotBrain.decide(game) 接口的"只读 Game 视图"。
// 注意：STATE 快照里水泡没有携带 range 字段（真实 Bomb.range 只存在于服务器内存里），
// 这里退而求其次，用"当前拥有者的实时 range"近似替代——绝大多数情况下等价
// （只有"放泡后立刻吃到威力道具"这种极短窗口会有偏差），对纯外部客户端是无法避免的信息缺口。
class GameView {
    constructor() {
        this.grid = null;
        this.players = new Map();
        this.bombs = new Map();
        this.items = [];
        this.explosions = [];
        this.tickCount = 0;
        this.warmup = 0;
        this.over = false;
        this._statics = new Map(); // id -> {name, isBot, char, colorIndex}（gameStart 里下发，之后不再重复）
    }

    applyGameStart(msg) {
        this.grid = rowsToGrid(msg.map);
        this._statics = new Map(msg.players.map((p) => [p.id, p]));
        this.yourId = msg.yourId;
        this.over = false;
    }

    applyState(msg) {
        this.tickCount = msg.tick;
        this.warmup = msg.warmup;
        if (msg.grid) this.grid = rowsToGrid(msg.grid);

        this.players.clear();
        for (const p of msg.players) {
            this.players.set(p.id, { ...this._statics.get(p.id), ...p });
        }

        this.bombs.clear();
        msg.bombs.forEach((b, i) => {
            this.bombs.set(i, {
                tx: b.x, ty: b.y, px: b.sx, py: b.sy,
                range: this.players.get(b.owner)?.range ?? 1, // 近似值，见类注释
                           ownerId: b.owner, remote: b.remote, fuse: b.fuse,
            });
        });

        this.items = msg.items;
        this.explosions = msg.expl;
    }

    bombAt(tx, ty) {
        for (const b of this.bombs.values()) if (b.tx === tx && b.ty === ty) return b;
        return null;
    }

    // 服务器快照里的 speed 已经是结算过坐骑/道具后的最终有效速度，直接用即可
    effSpeed(p) {
        return p.speed;
    }
}

class SimPlayerBot {
    constructor(url, name, joinRoomId, listOnly) {
        this.url = url;
        this.name = name;
        this.joinRoomId = joinRoomId;
        this.listOnly = listOnly;
        this.view = new GameView();
        this.brain = null;
        this.myId = null;
        this.roomId = null;
        this.isHost = false;
        this.hasActed = false; // 是否已经处理过第一次大厅列表（决定建房/加房/仅列出）
        // 边沿触发：place/use 只在"从 false 变 true"的那一刻发消息，避免刷屏
        this.lastPlace = false;
        this.lastUse = false;
        this.lastDirsKey = '';
    }

    connect() {
        this.ws = new WebSocket(this.url);
        this.ws.on('open', () => this.send({ t: C.HELLO, name: this.name }));
        this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
        this.ws.on('close', () => console.log(`[${this.name}] 连接已断开`));
        this.ws.on('error', (e) => console.error(`[${this.name}] 连接错误`, e.message));
    }

    send(obj) {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    }

    // 打印大厅当前的房间列表：{id, name, players, max, inGame}
    printLobby(rooms) {
        if (rooms.length === 0) {
            console.log(`[${this.name}] 大厅当前没有房间`);
            return;
        }
        console.log(`[${this.name}] 大厅房间列表（共 ${rooms.length} 个）：`);
        for (const r of rooms) {
            console.log(`  - id=${r.id}  名称="${r.name}"  人数=${r.players}/${r.max}  ${r.inGame ? '对局中' : '等待中'}`);
        }
    }

    // 按房间号（精确匹配 id）或房间名（大小写不敏感、取第一个未开局的匹配）解析出真正的 roomId
    resolveRoomId(rooms) {
        if (!this.joinRoomId) return null;
        const byId = rooms.find((r) => r.id === this.joinRoomId);
        if (byId) return byId.id;
        const needle = this.joinRoomId.toLowerCase();
        const byName = rooms.find((r) => r.name.toLowerCase() === needle && !r.inGame)
        ?? rooms.find((r) => r.name.toLowerCase().includes(needle) && !r.inGame);
        return byName ? byName.id : null;
    }

    actOnLobby(rooms) {
        if (this.listOnly) {
            this.ws.close();
            return;
        }
        if (!this.joinRoomId) {
            this.send({ t: C.CREATE_ROOM });
            return;
        }
        const roomId = this.resolveRoomId(rooms);
        if (!roomId) {
            console.error(`[${this.name}] 没找到匹配 "${this.joinRoomId}" 的可加入房间（房间号需精确匹配，房间名不区分大小写），已退出`);
            this.ws.close();
            return;
        }
        this.send({ t: C.JOIN_ROOM, roomId });
    }

    onMessage(msg) {
        switch (msg.t) {
            case S.WELCOME:
                this.myId = msg.id;
                console.log(`[${this.name}] 已登录，id=${this.myId}`);
                break;

            case S.LOBBY:
                this.printLobby(msg.rooms);
                if (!this.hasActed) {
                    this.hasActed = true;
                    this.actOnLobby(msg.rooms);
                }
                break;

            case S.ROOM: {
                this.roomId = msg.room.id;
                this.isHost = msg.room.hostId === this.myId;
                const me = msg.room.players.find((p) => p.id === this.myId);
                // 建房的一方默认未准备，需要自己确认准备；加房默认已是准备状态
                if (this.isHost && me && !me.ready) this.send({ t: C.READY, ready: true });
                // 简单策略：房主等所有人都准备好后就开局（练习模式=只有自己时也能直接开）
                if (this.isHost && !msg.room.inGame && msg.room.players.every((p) => p.ready)) {
                    this.send({ t: C.START });
                }
                break;
            }

            case S.GAME_START:
                this.view.applyGameStart(msg);
                this.brain = new GrowthPriorityBrain(this.myId);
                console.log(`[${this.name}] 对局开始`);
                break;

            case S.STATE:
                this.view.applyState(msg);
                this.tick();
                break;

            case S.GAME_OVER:
                console.log(`[${this.name}] 对局结束，胜者：${msg.winnerName ?? '平局'}`);
                this.brain = null;
                break;

            case S.ERROR:
                console.error(`[${this.name}] 服务端错误：${msg.msg}`);
                break;

            default:
                break;
        }
    }

    tick() {
        if (!this.brain || this.view.warmup > 0) return; // 321倒计时期间全员冻结，不必发输入
        const act = this.brain.decide(this.view);

        const dirsKey = (act.dirs ?? []).join(',');
        if (dirsKey !== this.lastDirsKey) {
            this.lastDirsKey = dirsKey;
            this.send({ t: C.INPUT, dir: act.dirs ?? [] });
        }
        if (act.place && !this.lastPlace) this.send({ t: C.PLACE_BOMB });
        if (act.use && !this.lastUse) this.send({ t: C.USE_ITEM });
        this.lastPlace = !!act.place;
        this.lastUse = !!act.use;
    }
}

const bot = new SimPlayerBot(URL, NAME, JOIN_ROOM, LIST_ONLY);
bot.connect();

process.on('SIGINT', () => {
    bot.ws?.close();
    process.exit(0);
});
