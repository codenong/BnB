// 外部 WebSocket 机器人：像真实玩家一样连接服务器（走完整协议，而非直接调用引擎），
// 决策逻辑复用 server/bot.js 里内置 Bot 的危险图 + BFS 寻路算法。
//
// 自带一个极简观战服务器（复用 client/ 页面代码，不用碰真正的游戏服务器）：
// 自己建房时会打印一个链接，浏览器打开就能用真实游戏画面看完整场对局，
// 不用手动点大厅、不用做任何操作（可以用 --watch-port 0 关掉这个功能）。
//
// 用法：
//   node tools/simPlayerBot.js --list                   # 只看当前大厅有哪些房间（id/名称/人数），不建房不加房
//   node tools/simPlayerBot.js                          # 建房自己开一局单人练习（Bot补位到6人），默认等8秒再开局
//   node tools/simPlayerBot.js --start-delay 15          # 自己建房时把等待时间改成15秒，留更多时间去浏览器里点进来观战
//   node tools/simPlayerBot.js --watch-port 4001          # 观战服务器监听端口，默认4001；传0关闭观战服务器
//   node tools/simPlayerBot.js --join r3                # 按房间号加入
//   node tools/simPlayerBot.js --join "欢乐斗泡"         # 按房间名加入（大小写不敏感，取第一个匹配且未开局的）
//   node tools/simPlayerBot.js --url ws://host:3001 --name 我的机器人
//
// 依赖：仅用到仓库自带的 ws 包，无需额外安装。

import { WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotBrain } from '../server/bot.js';
import { BOMB_FUSE_TICKS, TICK_RATE, DT, ROUND_TICKS, computeFlameCells } from '../server/game.js';
import { TILE, COLS, ROWS, EMPTY, WALL, SOFT, HOUSE, CRATE, isSoft } from '../server/map.js';
import { C, S } from '../server/protocol.js';

const tile = (v) => Math.floor(v / TILE);
const key = (x, y) => `${x},${y}`;
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ---- 观战用的极简静态文件服务器：复用 client/ 目录，逻辑照抄 server/index.js 里
// 托管静态资源的那部分（不含 WebSocket，游戏协议由浏览器直连真正的游戏服务器）----
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

function startWatchServer(port) {
    const server = http.createServer((req, res) => {
        let urlPath;
        try {
            urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        } catch {
            res.writeHead(400);
            res.end();
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
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
            res.end(data);
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, () => resolve(server));
    });
}

// 成长类道具优先级梯队：数组顺序即优先级——先攒速度/泡泡数，威力放最后。
// 每个 Set 是同一优先级内的道具（同梯队内谁近就去谁，不再细分）
const GROWTH_TIERS = [
    new Set(['shoe', 'bubble', 'devil']), // 第一梯队：速度鞋、泡泡数、红魔（瞬间拉满速度）
    new Set(['potion', 'gremlin']),        // 第二梯队：威力泡泡、紫魔（瞬间拉满威力）——放最后
];
// 可达安全空地 / 当前地图总空地 达到这个比例，才算"大片生存空间"
const OPEN_SPACE_THRESHOLD = 0.45;
// 吃道具时主动避开的道具/坐骑种类：绿乌龟(turtle)速度只有84，是全场最慢的坐骑
// （mounts.js 原作者注释就是"最慢，多数是坑"），骑上去等于自断双腿，宁可不捡。
// 以后想再排除别的道具，往这个 Set 里加 kind 字符串就行。
const AVOID_ITEMS = new Set(['turtle']);
// 哪怕空间够大，敌人近到这个曼哈顿距离（格）内也不优先捡道具，先顾眼前
const NEAR_ENEMY_GRACE = 3;

// 只给这个外部机器人加"空档期优先抢成长道具"的策略，不改动 server/bot.js，
// 所以内置 Bot（房间补位用的那些）行为完全不受影响。
// 通过继承 BotBrain 并重写 findObjective 实现：其余决策（逃命/放泡/追人/炸墙）
// 全部复用父类原逻辑，只在"没什么紧急事"时插入一段"优先去捡道具"的判断。
class GrowthPriorityBrain extends BotBrain {
    // 拦截"被困"这一支：原版 BotBrain 一被困就立刻用针，但如果人还站在同一团
    // 尚未烧完的爆炸格里（爆炸最长烧 EXPLOSION_TICKS≈0.5s），自救瞬间又会被同一团火
    // 重新点着——针就这么被无声浪费掉（服务端 game.js 的坐骑挡炸逻辑对此专门补了
    // grace 无敌帧，唯独针自救这条路径漏了）。这里改成纯客户端 workaround：
    // 被困倒计时有 4s（TRAP_TICKS），远比爆炸烧完的 0.5s 长，等得起——
    // 先等脚下这团火烧完，确认不会白烧，再用针。
    decide(game) {
        const me = game.players.get(this.id);
        if (me && me.alive && me.trapped) return this.decideTrapped(game, me);
        return super.decide(game);
    }

    decideTrapped(game, me) {
        if (me.inv.needle <= 0) return { dirs: [], place: false, use: false };
        const tx = tile(me.x);
        const ty = tile(me.y);
        const stillBurning = game.explosions.some((e) => e.cells.some(([x, y]) => x === tx && y === ty));
        return { dirs: [], place: false, use: !stillBurning };
    }

    // 原版 tryPlace 有个"绝望值"机制：回合拖得越久（超过约40%时限后），
    // 越容易在没有确认逃生路线的情况下也硬放泡（残局临近超时时这个概率能到六成），
    // 目的是逼平局提前结束，代价是偶尔会把自己炸死。
    // 这里去掉这个赌博分支：其余判断（贴软块/贴敌人才放、遥控器优先）原样保留，
    // 唯独"没有逃生路线"这一条永远返回 null（不放），保证只在确认能逃出来时才放泡。
    tryPlace(game, me, tx, ty, flame, boom) {
        let owned = 0;
        for (const b of game.bombs.values()) if (b.ownerId === this.id) owned++;
        if (owned >= me.maxBombs || game.bombAt(tx, ty)) return null;
        const nearSoft = DIRS4.some(([dx, dy]) => isSoft(game.grid[ty + dy]?.[tx + dx]));
        const nearEnemy = [...game.players.values()].some(
            (p) => p.id !== this.id && p.alive && !p.trapped
            && Math.abs(p.x - me.x) < TILE * 1.5 && Math.abs(p.y - me.y) < TILE * 1.5,
        );
        if (!nearSoft && !nearEnemy) return null;

        const ownFlame = new Set(computeFlameCells(game.grid, tx, ty, me.range).map(([x, y]) => key(x, y)));
        const soft = new Set([...flame, ...ownFlame]);
        const escape = this.bfs(game, tx, ty, (x, y) => !soft.has(key(x, y)) && !boom.has(key(x, y)), {
            avoid: boom,
            blocked: new Set([key(tx, ty)]),
        });
        const margin = BOMB_FUSE_TICKS - Math.round(0.6 * TICK_RATE);
        let path = escape && escape.length ? escape : null;
        if (path && escape.length * (TILE / game.effSpeed(me) / DT) > margin) path = null;
        if (!path) return null; // 没有确认能逃出来的路线，绝不放泡——哪怕贴脸也不赌
        this.path = path;
        this.escape = true;
        console.log(`[调试][t=${game.tickCount}] 放泡 于(${tx},${ty}) 规划逃生路线=${JSON.stringify(path)} 当前像素位置=(${me.x.toFixed(1)},${me.y.toFixed(1)})`);
        if (nearEnemy && !nearSoft && me.inv.remote > 0) {
            return { dirs: this.followPath(me), place: false, use: true };
        }
        return { dirs: this.followPath(me), place: true };
    }

    findObjective(game, me, tx, ty, danger) {
        // 先把不想要的道具/坐骑（目前只有绿乌龟）从候选里剔除，后面所有目标搜索
        // 都基于这份过滤后的列表，保证任何分支都不会主动把它当目标
        const items = game.items.filter((it) => !AVOID_ITEMS.has(it.kind));
        const enemies = [...game.players.values()].filter(
            (p) => p.id !== this.id && p.alive && !p.trapped,
        );

        const growthAvailable = items.some((it) => GROWTH_TIERS.some((tier) => tier.has(it.kind)));
        if (growthAvailable) {
            const nearestEnemyDist = enemies.length
            ? Math.min(...enemies.map((e) => Math.abs(tile(e.x) - tx) + Math.abs(tile(e.y) - ty)))
            : Infinity;
            if (nearestEnemyDist >= NEAR_ENEMY_GRACE
                && this.safeSpaceRatio(game, tx, ty, danger) >= OPEN_SPACE_THRESHOLD) {
                // 按梯队顺序依次尝试：这一梯队场上没有就跳过；有但BFS走不到（比如被危险格挡住）
                // 就落到下一梯队，都不行才交给下面的兜底逻辑
                for (const tier of GROWTH_TIERS) {
                    if (!items.some((it) => tier.has(it.kind))) continue;
                    const tierGoal = (x, y) => items.some((it) => x === it.x && y === it.y && tier.has(it.kind));
                    const path = this.bfs(game, tx, ty, tierGoal, { avoid: danger });
                    if (path && path.length) return path;
                }
                }
        }

        // 兜底逻辑：和父类 BotBrain.findObjective 完全一致（追人/捡道具/炸软块的
        // 三选一及25%~75%的追击概率），唯一区别是 itemGoal 用的是上面过滤过的 items，
        // 绿乌龟不会被当成"随手捡"的目标（但如果它恰好挡在去别处的必经之路上，
        // 走过去时仍会被自动骑上——这里只保证不主动去找它，不做强制绕路）
        const itemGoal = (x, y) => items.some((it) => it.x === x && it.y === y);
        const enemyGoal = (x, y) => enemies.some((e) => tile(e.x) === x && tile(e.y) === y);
        const softGoal = (x, y) => DIRS4.some(([dx, dy]) => isSoft(game.grid[y + dy]?.[x + dx]));
        const chase = Math.min(0.25 + (game.tickCount / ROUND_TICKS) * 0.5, 0.75);
        const tries = Math.random() < chase && enemies.length
        ? [enemyGoal, itemGoal, softGoal]
        : [itemGoal, softGoal, enemyGoal];
        for (const goal of tries) {
            const path = this.bfs(game, tx, ty, goal, { avoid: danger });
            if (path && path.length) return path;
        }
        return null;
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
const WS_URL = opt('--url', 'ws://localhost:3001');
// ws://host:port → http://host:port，用来拼观战链接（?room=<id> 由客户端 main.js 自动加房，见下方改动）
const HTTP_URL = WS_URL.replace(/^ws/, 'http');
const NAME = opt('--name', `Bot玩家${Math.floor(Math.random() * 1000)}`);
const JOIN_ROOM = opt('--join', null); // 房间号或房间名；不传则自己建房单人开局
const LIST_ONLY = args.includes('--list'); // 只打印大厅房间列表，不建房不加房
const START_DELAY_MS = Number(opt('--start-delay', '15')) * 1000; // 自己建房时，等这么久再自动开局，留时间在浏览器大厅里点进来观战
const WATCH_PORT = Number(opt('--watch-port', '4001')); // 观战服务器监听端口（0 = 不启动观战服务器）
// const WATCH_HOST = opt('--watch-host', new URL(WS_URL).hostname); // 观战链接里打印的主机名，默认取 --url 里的主机
const WATCH_HOST = opt('--watch-host', "localhost"); // 观战链接里打印的主机名，默认取 --url 里的主机

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
        this.startTimer = null; // 自己建房时的延迟开局定时器
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
                // 房主等所有人都准备好后开局（练习模式=只有自己时也能直接开）。
                // 但如果是自己建的房（没用--join加别人的房），不立刻开——延迟 START_DELAY_MS
                // 再开，留出时间让人在浏览器大厅列表里点进这个房间"陪跑"围观
                // （只要是房间成员就能收到后续所有画面广播，哪怕站着不动甚至被炸死也照样能看）
                if (this.isHost && !msg.room.inGame && msg.room.players.every((p) => p.ready) && !this.startTimer) {
                    if (this.joinRoomId) {
                        this.send({ t: C.START });
                    } else {
                        // const watchUrl = WATCH_PORT
                        // ? `http://${WATCH_HOST}:${WATCH_PORT}/?room=${encodeURIComponent(msg.room.id)}&server=${encodeURIComponent(WS_URL)}`
                        // : `${HTTP_URL}/?room=${encodeURIComponent(msg.room.id)}`;

                        const watchUrl = WATCH_PORT
                            ? `http://${WATCH_HOST}:${WATCH_PORT}/?room=${encodeURIComponent(msg.room.id)}&server=${encodeURIComponent(WS_URL)}&name=${encodeURIComponent(this.name)}`
                            : `${HTTP_URL}/?room=${encodeURIComponent(msg.room.id)}&name=${encodeURIComponent(this.name)}`;

                        console.log(`[${this.name}] 房间「${msg.room.name}」已就绪，${START_DELAY_MS / 1000}秒后自动开局——`
                        + `打开这个链接直接进房观战（复用真实客户端画面，不用手动点大厅、不用操作）：\n  ${watchUrl}`);
                        this.startTimer = setTimeout(() => {
                            this.startTimer = null;
                            this.send({ t: C.START });
                        }, START_DELAY_MS);
                    }
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
        const me = this.view.players.get(this.myId);

        // 滚动缓冲区：记录死前约6秒(200tick，覆盖完整的"被困→自救/超时"生命周期)内的
        // 每帧位置/路线/危险格判断，平时不打印，一旦检测到自己死亡就整段吐出来
        this.recentLog = this.recentLog ?? [];
        if (me) {
            const myBombNearby = [...this.view.bombs.values()].filter((b) => b.ownerId === this.myId);
            const standingOnBomb = [...this.view.bombs.values()].some((b) => b.tx === Math.floor(me.x / TILE) && b.ty === Math.floor(me.y / TILE));
            let line = `t=${this.view.tickCount} pos=(${me.x.toFixed(1)},${me.y.toFixed(1)}) tile=(${Math.floor(me.x / TILE)},${Math.floor(me.y / TILE)}) `
            + `dirs=${JSON.stringify(act.dirs ?? [])} place=${!!act.place} trapped=${me.trapped} alive=${me.alive} 脚下有泡=${standingOnBomb} pathLen=${this.brain.path?.length ?? 0} 我的泡=${JSON.stringify(myBombNearby.map((b) => [b.tx, b.ty, b.fuse]))} 全场泡=${JSON.stringify([...this.view.bombs.values()].map((b) => [b.tx, b.ty, b.fuse, b.ownerId]))} 当前爆炸格=${JSON.stringify(this.view.explosions.flatMap((e) => e.cells))}`;
            if (this.wasTrapped === false && me.trapped === true) line += '  ←←← 刚被困！';
            this.recentLog.push(line);
            if (this.recentLog.length > 200) this.recentLog.shift();
            this.wasTrapped = me.trapped;
        }
        if (this.wasAlive && me && !me.alive) {
            console.error(`[${this.name}] ！！死亡，回放死前约6秒内的决策日志：`);
            console.error(this.recentLog.join('\n'));
        }
        this.wasAlive = me?.alive ?? this.wasAlive;

        const dirsKey = (act.dirs ?? []).join(',');
        if (dirsKey !== this.lastDirsKey) {
            this.lastDirsKey = dirsKey;
            this.send({ t: C.INPUT, dir: act.dirs ?? [] });
        }
        if (act.place && !this.lastPlace) this.send({ t: C.PLACE_BOMB });
        if (act.use && !this.lastUse) {
            this.send({ t: C.USE_ITEM });
            if (this.view.players.get(this.myId)?.trapped) {
                console.log(`[${this.name}] 被泡泡困住了，使用针自救`);
            }
        }
        this.lastPlace = !!act.place;
        this.lastUse = !!act.use;
    }
}

const bot = new SimPlayerBot(WS_URL, NAME, JOIN_ROOM, LIST_ONLY);

let watchServer = null;
(async () => {
    if (!LIST_ONLY && WATCH_PORT) {
        try {
            watchServer = await startWatchServer(WATCH_PORT);
            console.log(`[${NAME}] 观战服务器已启动：http://${WATCH_HOST}:${WATCH_PORT}（复用 client/ 页面，见下方房间链接）`);
        } catch (err) {
            console.error(`[${NAME}] 观战服务器启动失败（端口 ${WATCH_PORT} 可能被占用），不影响机器人本身运行：${err.message}`);
        }
    }
    bot.connect();
})();

process.on('SIGINT', () => {
    if (bot.startTimer) clearTimeout(bot.startTimer);
    bot.ws?.close();
    watchServer?.close();
    process.exit(0);
});
