// 游戏引擎：服务器权威，30Hz 固定步长
// 负责移动碰撞、水泡/爆炸、道具、被困/死亡、胜负判定

import {
  TILE, COLS, ROWS, buildMap, gridToRows,
  EMPTY, WALL, SOFT, HOUSE, CRATE, SPAWNS, MOUNT_SPOTS, isSoft,
} from './map.js';
import { getChar } from './characters.js';
import { MOUNTS } from './mounts.js';

export { TILE };
export const TICK_RATE = 30;         // 模拟/广播频率（提高以降低输入与画面延迟）
export const DT = 1 / TICK_RATE;
export const BOMB_FUSE_TICKS = Math.round(2.5 * TICK_RATE); // 水泡引信 2.5s
export const REMOTE_FUSE = 9999;     // 遥控水泡不倒计时（仅用于序列化，逻辑上跳过）
export const EXPLOSION_TICKS = Math.round(0.5 * TICK_RATE); // 火焰持续 0.5s
export const TRAP_TICKS = Math.round(4 * TICK_RATE);        // 被困 4s 后死亡
export const ROUND_TICKS = 180 * TICK_RATE;                 // 回合限时 3 分钟，超时判平局
export const WARMUP_TICKS = 3 * TICK_RATE;                  // 开局 321 倒计时 3s（全员冻结）
export const ITEM_DROP_RATE = 0.35;  // 软块掉道具概率
export const SHOE_STEP = 24;         // 每只鞋子提升的速度
export const PUSH_TICKS = 10;        // 长按方向约 0.33s 推动 X 纹木箱一格（原 12，判定耗时降 20%）
export const SLIDE_TICKS = 6;        // 推箱滑动时长（平滑过渡，6 tick≈0.2s）
export const KICK_SPEED = 360;       // 踢出的水泡滑动速度 px/s（一脚踢到底，撞停；原 240，踢泡移动 +50%）
export const DEATH_DROP_RATE = 0.3;  // 死亡时吃过的每个道具有 30% 概率撒回地图
export const LOOT_FLY_BASE = 5;      // 死亡抛射基础飞行 tick（约 0.17s）
export const LOOT_FLY_PER_TILE = 4;  // 抛射每飞一格追加的 tick
export const MAX_NEEDLE = 2;         // 针携带上限
export const MAX_REMOTE = 2;         // 遥控器携带上限

const HALF = 13;          // 玩家碰撞盒半宽（26px 盒子）
const ASSIST_RANGE = 12;  // 转角辅助容许的偏移
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIR_VEC = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] };

let bombSeq = 1;

// 计算水泡火焰覆盖格：含自身格；软块格包含且阻断该方向；墙/房屋阻断且不包含
export function computeFlameCells(grid, tx, ty, range) {
  const cells = [[tx, ty]];
  for (const [dx, dy] of DIRS4) {
    for (let i = 1; i <= range; i++) {
      const x = tx + dx * i;
      const y = ty + dy * i;
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break;
      const t = grid[y][x];
      if (t === WALL || t === HOUSE) break;
      cells.push([x, y]);
      if (isSoft(t)) break;
    }
  }
  return cells;
}

export class Game {
  // playerDefs: [{id, name, isBot, char}]，最多 6 人
  // opts.warmup: 开局 321 冻结 tick（默认 WARMUP_TICKS；测试可传 0）
  constructor(playerDefs, { random = Math.random, warmup = WARMUP_TICKS } = {}) {
    this.random = random;
    this.grid = buildMap();
    this.tickCount = 0;
    this.players = new Map();
    playerDefs.forEach((def, i) => {
      const [sx, sy] = SPAWNS[i % SPAWNS.length];
      const ch = getChar(def.char);
      this.players.set(def.id, {
        id: def.id, name: def.name, isBot: !!def.isBot, colorIndex: i,
        char: ch.id,
        x: sx * TILE + TILE / 2, y: sy * TILE + TILE / 2,
        dirs: [],
        speed: ch.speed, maxBombs: ch.bombs, range: ch.range,
        caps: { ...ch.caps },
        inv: { needle: 0, remote: 0 }, // 主动道具背包
        eaten: [],          // 本局吃过的所有道具 kind（死亡时按 30% 撒回地图）
        kick: false,        // 踢水泡能力（碰到的水泡会被踢走）
        pushKey: null,      // 正在推的 X 木箱 "x,y,dir"
        pushAcc: 0,         // 长按推动计时
        mount: null,        // 坐骑（被炸时挡一命）
        grace: 0,           // 坐骑挡炸后的短暂无敌 tick
        alive: true, trapped: false, trapTicks: 0, disconnected: false,
      });
    });
    this.bombs = new Map();      // bombId -> {id, tx, ty, px, py, slide, range, ownerId, fuse, remote, pass:Set}
    this.bombsByPos = new Map(); // "x,y" -> bomb
    this.explosions = [];        // [{cells:[[x,y]...], ttl, ownerId}]
    this.crateSlides = [];       // 平滑推动中的 X 木箱 [{fx, fy, tx, ty, left, total}]
    this.items = MOUNT_SPOTS.map(([x, y, kind]) => ({ x, y, kind })); // [{x, y, kind}]，初始含地图坐骑
    this.lootShots = [];       // 死亡抛射中的道具 [{kind, tx, ty, x0, y0, x1, y1, left, total}]
    this.warmup = warmup;        // 开局 321 倒计时：全员冻结， tickCount 不走表
    this.over = false;
    this.winner = null;
    this.gridVer = 0;            // 地图版本号：箱子被炸/滑动完成时递增
    this._sentGridVer = -1;      // 上次快照携带的地图版本（不同才重发 grid）
  }

  gridRows() {
    return gridToRows(this.grid);
  }

  setInput(id, dirs) {
    const p = this.players.get(id);
    if (!p) return;
    const valid = new Set(['up', 'down', 'left', 'right']);
    p.dirs = (Array.isArray(dirs) ? dirs : []).filter((d) => valid.has(d)).slice(-4);
  }

  bombAt(tx, ty) {
    return this.bombsByPos.get(`${tx},${ty}`) ?? null;
  }

  // 自己是否有未爆的遥控水泡在场
  hasRemoteOut(id) {
    for (const b of this.bombs.values()) if (b.remote && b.ownerId === id) return true;
    return false;
  }

  // 引爆自己所有的遥控水泡（下一 tick 起爆）
  detonate(id) {
    let any = false;
    for (const b of this.bombs.values()) {
      if (b.remote && b.ownerId === id) {
        b.fuse = 0;
        any = true;
      }
    }
    return any;
  }

  // remote=false（空格）：自己有未爆遥控泡时改为将其引爆（盛大规则），否则放普通水泡；
  // remote=true（Ctrl）：消耗一个遥控器，放遥控水泡（不自动爆炸，空格引爆）
  placeBomb(id, remote = false) {
    const p = this.players.get(id);
    if (!p || !p.alive || p.trapped || this.over || this.warmup > 0) return false;
    if (!remote && this.hasRemoteOut(id)) return this.detonate(id);
    if (remote && p.inv.remote <= 0) return false;
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    if (this.bombAt(tx, ty)) return false;
    let owned = 0;
    for (const b of this.bombs.values()) if (b.ownerId === id) owned++;
    if (owned >= p.maxBombs) return false;
    if (remote) p.inv.remote--;
    const bomb = {
      id: bombSeq++, tx, ty, range: p.range, ownerId: id,
      px: tx * TILE + TILE / 2, py: ty * TILE + TILE / 2, // 像素中心（滑动时用）
      slide: null,   // 被踢后的滑动方向 {dx, dy}，落定归 null
      fuse: remote ? REMOTE_FUSE : BOMB_FUSE_TICKS,
      remote, pass: new Set(),
    };
    // 当前站在水泡格上的玩家可以穿过，完全离开后水泡对其变为实体
    for (const q of this.players.values()) {
      if (q.alive && this.overlapsTile(q, tx, ty)) bomb.pass.add(q.id);
    }
    this.bombs.set(bomb.id, bomb);
    this.bombsByPos.set(`${tx},${ty}`, bomb);
    return true;
  }

  // 使用主动道具（Ctrl/Shift）：被困时用针自救；否则放遥控水泡（消耗遥控器）
  useItem(id) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.over) return false;
    if (p.trapped) {
      if (p.inv.needle <= 0) return false;
      p.inv.needle--;
      p.trapped = false;
      p.trapTicks = 0;
      return true;
    }
    return this.placeBomb(id, true);
  }

  overlapsTile(p, tx, ty) {
    return p.x + HALF > tx * TILE && p.x - HALF < tx * TILE + TILE
        && p.y + HALF > ty * TILE && p.y - HALF < ty * TILE + TILE;
  }

  solidFor(tx, ty, p) {
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return true;
    const t = this.grid[ty][tx];
    if (t !== EMPTY) {
      // 飞碟可飞越场内障碍（货箱/船体/立柱），但飞不出边界墙
      const border = tx === 0 || ty === 0 || tx === COLS - 1 || ty === ROWS - 1;
      if (!(p.mount === 'ufo' && !border)) return true;
    }
    // 滑动中的 X 木箱其目标格在滑完前也视为实体
    if (this.crateSlides.some((s) => s.tx === tx && s.ty === ty)) return true;
    const b = this.bombAt(tx, ty);
    if (b && !b.pass.has(p.id)) return true;
    return false;
  }

  collides(p, x, y) {
    const x0 = Math.floor((x - HALF) / TILE);
    const x1 = Math.floor((x + HALF - 0.01) / TILE);
    const y0 = Math.floor((y - HALF) / TILE);
    const y1 = Math.floor((y + HALF - 0.01) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (this.solidFor(tx, ty, p)) return true;
      }
    }
    return false;
  }

  tryMove(p, dx, dy) {
    const nx = p.x + dx;
    const ny = p.y + dy;
    if (!this.collides(p, nx, ny)) {
      p.x = nx;
      p.y = ny;
      return true;
    }
    return false;
  }

  // 有效速度：骑乘坐骑时由坐骑决定（替代角色自身速度）
  effSpeed(p) {
    return p.mount ? MOUNTS[p.mount].speed : p.speed;
  }

  movePlayer(p) {
    const dir = p.dirs[p.dirs.length - 1]; // 最近按下的方向优先
    if (!dir) {
      p.pushKey = null;
      p.pushAcc = 0;
      return;
    }
    const step = this.effSpeed(p) * DT;
    let dx = 0;
    let dy = 0;
    if (dir === 'left') dx = -step;
    else if (dir === 'right') dx = step;
    else if (dir === 'up') dy = -step;
    else if (dir === 'down') dy = step;
    if (this.tryMove(p, dx, dy)) {
      p.pushKey = null;
      p.pushAcc = 0;
      return;
    }
    // 转角辅助：被挡住时向相邻行/列的中心线靠拢，便于滑入通道
    if (dx !== 0) {
      const c = Math.floor(p.y / TILE) * TILE + TILE / 2;
      for (const cy of [c, c - TILE, c + TILE]) {
        const d = cy - p.y;
        if (d === 0 || Math.abs(d) > ASSIST_RANGE) continue;
        const shift = Math.abs(d) <= step ? d : Math.sign(d) * step;
        if (!this.collides(p, p.x, p.y + shift)) {
          p.y += shift;
          if (this.tryMove(p, dx, 0)) {
            p.pushKey = null;
            p.pushAcc = 0;
          }
          return;
        }
      }
    } else {
      const c = Math.floor(p.x / TILE) * TILE + TILE / 2;
      for (const cx of [c, c - TILE, c + TILE]) {
        const d = cx - p.x;
        if (d === 0 || Math.abs(d) > ASSIST_RANGE) continue;
        const shift = Math.abs(d) <= step ? d : Math.sign(d) * step;
        if (!this.collides(p, p.x + shift, p.y)) {
          p.x += shift;
          if (this.tryMove(p, 0, dy)) {
            p.pushKey = null;
            p.pushAcc = 0;
          }
          return;
        }
      }
    }
    // 完全受阻：有踢技时先把前方水泡踢走；正前方是 X 纹木箱时，长按方向键推动它
    this.tryKick(p, dir);
    this.tryPush(p, dir);
  }

  // 玩家正前方的 X 纹木箱格（只有 X 木箱可以推动，黄箱/船炮/桅杆不可）
  // 玩家正前方的实体格候选（可能贴住的两格：当前前缘覆盖格与前邻格）
  frontTiles(p, dir) {
    const [vx, vy] = DIR_VEC[dir];
    const bx = Math.floor((p.x + vx * HALF) / TILE);
    const by = Math.floor((p.y + vy * HALF) / TILE);
    return [[bx, by], [bx + vx, by + vy]];
  }

  // 玩家正前方的 X 纹木箱格（只有 X 木箱可以推动，黄箱/船炮/桅杆不可）
  pushCandidate(p, dir) {
    for (const [tx, ty] of this.frontTiles(p, dir)) {
      if (this.grid[ty]?.[tx] === CRATE) return [tx, ty];
    }
    return null;
  }

  // 踢水泡：拥有踢技的玩家走向水泡时把它踢飞（一脚踢到底，撞到阻挡才停）
  tryKick(p, dir) {
    if (!p.kick || p.mount) return; // 乘骑状态下踢技暂不生效（能力保留，下马恢复）
    const [vx, vy] = DIR_VEC[dir];
    let b = null;
    for (const [tx, ty] of this.frontTiles(p, dir)) {
      b = this.bombAt(tx, ty);
      if (b) break;
    }
    if (!b || b.slide) return; // 已踢飞中的不再重复踢
    b.slide = { dx: vx, dy: vy };
  }

  // 踢飞的水泡每 tick 滑动；前方是边界/箱子/桅杆/其他水泡/角色时落定（无视地面漂浮的道具，直接穿过）
  updateBombSlides() {
    for (const b of this.bombs.values()) {
      if (!b.slide) continue;
      const { dx, dy } = b.slide;
      b.px += dx * KICK_SPEED * DT;
      b.py += dy * KICK_SPEED * DT;
      const tx = Math.floor(b.px / TILE);
      const ty = Math.floor(b.py / TILE);
      if (tx === b.tx && ty === b.ty) continue; // 还没跨格
      let blocked = tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS
        || this.grid[ty][tx] !== EMPTY
        || (this.bombAt(tx, ty) && this.bombAt(tx, ty) !== b);
      if (!blocked) {
        for (const q of this.players.values()) { // 角色拦截：撞到人即停
          if (q.alive && this.overlapsTile(q, tx, ty)) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) { // 停靠：退回原格中心
        b.px = b.tx * TILE + TILE / 2;
        b.py = b.ty * TILE + TILE / 2;
        b.slide = null;
        b.pass = new Set(); // 追泡的人可能已走进本格，让其可穿过不被卡住
        for (const q of this.players.values()) {
          if (q.alive && this.overlapsTile(q, b.tx, b.ty)) b.pass.add(q.id);
        }
        continue;
      }
      // 安全越格：更新瓦片坐标与索引，重算可穿过玩家
      this.bombsByPos.delete(`${b.tx},${b.ty}`);
      b.tx = tx;
      b.ty = ty;
      this.bombsByPos.set(`${tx},${ty}`, b);
      b.pass = new Set();
      for (const q of this.players.values()) {
        if (q.alive && this.overlapsTile(q, tx, ty)) b.pass.add(q.id);
      }
    }
  }

  // 长按推动：启动 X 木箱向推动方向的平滑滑动（SLIDE_TICKS 内移到目标格）
  tryPush(p, dir) {
    const c = this.pushCandidate(p, dir);
    const key = c ? `${c[0]},${c[1]},${dir}` : null;
    if (c && key === p.pushKey) p.pushAcc++;
    else {
      p.pushKey = key;
      p.pushAcc = c ? 1 : 0;
    }
    if (!c || p.pushAcc < PUSH_TICKS) return;
    p.pushAcc = 0;
    const [vx, vy] = DIR_VEC[dir];
    const [tx, ty] = c;
    const nx = tx + vx;
    const ny = ty + vy;
    if (this.crateSlides.some((s) => s.tx === nx && s.ty === ny)) return; // 已有箱滑向该格
    if (this.crateSlides.some((s) => s.fx === tx && s.fy === ty)) return; // 该箱正在滑动
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) return;
    if (this.grid[ny][nx] !== EMPTY) return;
    if (this.bombAt(nx, ny)) return;
    if (this.items.some((it) => it.x === nx && it.y === ny)) return;
    for (const q of this.players.values()) {
      if (q.alive && this.overlapsTile(q, nx, ny)) return; // 不能推到玩家身上
    }
    this.crateSlides.push({ fx: tx, fy: ty, tx: nx, ty: ny, left: SLIDE_TICKS, total: SLIDE_TICKS });
  }

  updateCrateSlides() {
    for (const s of [...this.crateSlides]) {
      s.left--;
      if (s.left > 0) continue;
      this.crateSlides.splice(this.crateSlides.indexOf(s), 1);
      // 源格滑动途中被炸毁 → 滑动取消，目标格不生成
      if (this.grid[s.fy][s.fx] === CRATE) {
        this.grid[s.fy][s.fx] = EMPTY;
        this.grid[s.ty][s.tx] = CRATE;
        this.gridVer++;
      }
    }
  }

  updateBombPass() {
    for (const b of this.bombs.values()) {
      for (const pid of [...b.pass]) {
        const q = this.players.get(pid);
        if (!q || !q.alive || !this.overlapsTile(q, b.tx, b.ty)) b.pass.delete(pid);
      }
    }
  }

  updateBombs() {
    const queue = [];
    for (const b of this.bombs.values()) {
      if (!b.remote) b.fuse--; // 遥控水泡不倒计时
      if (b.fuse <= 0) queue.push(b);
    }
    const destroyed = new Set();
    while (queue.length) {
      const b = queue.shift();
      if (!this.bombs.has(b.id)) continue; // 可能已被连锁引爆
      this.bombs.delete(b.id);
      this.bombsByPos.delete(`${b.tx},${b.ty}`);
      const cells = computeFlameCells(this.grid, b.tx, b.ty, b.range);
      this.explosions.push({ cells, ttl: EXPLOSION_TICKS, ownerId: b.ownerId });
      // 火焰烧毁地面上的道具
      const cellSet = new Set(cells.map(([x, y]) => `${x},${y}`));
      this.items = this.items.filter((it) => !cellSet.has(`${it.x},${it.y}`));
      for (const [x, y] of cells) {
        if (isSoft(this.grid[y][x])) destroyed.add(`${x},${y}`);
        const chained = this.bombAt(x, y);
        if (chained) queue.push(chained); // 连锁引爆（含遥控水泡）
      }
    }
    for (const key of destroyed) {
      const [x, y] = key.split(',').map(Number);
      if (!isSoft(this.grid[y][x])) continue;
      this.grid[y][x] = EMPTY;
      this.gridVer++;
      if (this.random() < ITEM_DROP_RATE) this.items.push({ x, y, kind: this.rollItem() });
    }
  }

  rollItem() {
    const r = this.random();
    if (r < 0.28) return 'potion';      // 威力 +1
    if (r < 0.48) return 'bubble';      // 水泡上限 +1
    if (r < 0.64) return 'shoe';        // 速度 +24
    if (r < 0.72) return 'needle';      // 主动：被困时自救
    if (r < 0.8) return 'remote';       // 主动：放遥控水泡
    if (r < 0.88) return 'kick';        // 踢水泡能力（白鞋）
    if (r < 0.945) return 'gremlin';  // 紫魔：威力直接满值
    if (r < 0.965) return 'devil';     // 红魔：速度直接满值
    if (r < 0.9775) return 'pirateTurtle'; // 坐骑：飞快
    if (r < 0.99) return 'owl';           // 坐骑：中速
    return 'ufo';                         // 坐骑：飞越障碍，不能捡道具
  }

  updateExplosions() {
    for (const e of this.explosions) e.ttl--;
    this.explosions = this.explosions.filter((e) => e.ttl > 0);
  }

  // 火焰格上的玩家被困进水泡；有坐骑时坐骑挡一命（坐骑消失，人短暂无敌）
  applyFlameDamage() {
    if (!this.explosions.length) return;
    const danger = new Set();
    for (const e of this.explosions) for (const [x, y] of e.cells) danger.add(`${x},${y}`);
    for (const p of this.players.values()) {
      if (!p.alive || p.trapped) continue;
      const key = `${Math.floor(p.x / TILE)},${Math.floor(p.y / TILE)}`;
      if (!danger.has(key)) continue;
      if (p.grace > 0) continue;
      if (p.mount) {
        p.mount = null; // 坐骑挡一命：坐骑消失，人不被困
        p.grace = EXPLOSION_TICKS + 4; // 落地短暂无敌，否则立刻被同一团火困住
        continue;
      }
      p.trapped = true;
      p.trapTicks = TRAP_TICKS;
      p.dirs = [];
    }
  }

  kill(p) {
    p.alive = false;
    p.trapped = false;
    p.dirs = [];
    this.dropLoot(p);
  }

  // 死亡爆装备：吃过的每个道具有 30% 概率从死亡地点向四面抛射（飞行一段后落地）
  dropLoot(p) {
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    for (const kind of p.eaten) {
      if (this.random() >= DEATH_DROP_RATE) continue;
      const shot = this.makeLootShot(kind, tx, ty);
      if (shot) this.lootShots.push(shot);
    }
    p.eaten = [];
  }

  // 从 (tx,ty) 向随机方向抛出道具：飞 1~3 格，落在沿途最远的可落格；四面全堵则落原地
  makeLootShot(kind, tx, ty) {
    const dirs = [...DIRS4];
    for (let i = dirs.length - 1; i > 0; i--) { // 洗牌方向
      const j = Math.floor(this.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    const reserved = new Set(this.lootShots.map((s) => `${s.tx},${s.ty}`));
    for (const [vx, vy] of dirs) {
      const dist = 1 + Math.floor(this.random() * 3);
      let land = null;
      for (let d = 1; d <= dist; d++) {
        if (!this.lootLandable(tx + vx * d, ty + vy * d, reserved)) break;
        land = [tx + vx * d, ty + vy * d];
      }
      if (land) return this.lootShot(kind, tx, ty, land[0], land[1]);
    }
    if (this.lootLandable(tx, ty, reserved)) return this.lootShot(kind, tx, ty, tx, ty);
    return null;
  }

  lootShot(kind, fx, fy, tx, ty) {
    const dist = Math.abs(tx - fx) + Math.abs(ty - fy);
    const total = LOOT_FLY_BASE + dist * LOOT_FLY_PER_TILE;
    return {
      kind, tx, ty,
      x0: fx * TILE + TILE / 2, y0: fy * TILE + TILE / 2,
      x1: tx * TILE + TILE / 2, y1: ty * TILE + TILE / 2,
      left: total, total,
    };
  }

  // 抛射可落格：场内空格、无水泡、无道具、未被其他抛射物预定
  lootLandable(x, y, reserved) {
    return x >= 0 && y >= 0 && x < COLS && y < ROWS
      && this.grid[y][x] === EMPTY
      && !this.bombAt(x, y)
      && !this.items.some((it) => it.x === x && it.y === y)
      && !reserved.has(`${x},${y}`);
  }

  // 抛射物飞行推进；落地时目标格仍是空格才生成道具
  updateLootShots() {
    for (const s of [...this.lootShots]) {
      s.left--;
      if (s.left > 0) continue;
      this.lootShots.splice(this.lootShots.indexOf(s), 1);
      if (s.tx >= 0 && s.ty >= 0 && s.tx < COLS && s.ty < ROWS && this.grid[s.ty][s.tx] === EMPTY) {
        this.items.push({ x: s.tx, y: s.ty, kind: s.kind });
      }
    }
  }

  updateTraps() {
    for (const p of this.players.values()) {
      if (!p.alive || !p.trapped) continue;
      p.trapTicks--;
      if (p.trapTicks <= 0) this.kill(p);
    }
    // 自由玩家触碰被困者 → 立即戳破
    const trapped = [];
    const free = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      (p.trapped ? trapped : free).push(p);
    }
    for (const t of trapped) {
      for (const f of free) {
        if (Math.abs(t.x - f.x) < TILE * 0.7 && Math.abs(t.y - f.y) < TILE * 0.7) {
          this.kill(t);
          break;
        }
      }
    }
  }

  updateItems() {
    for (const p of this.players.values()) {
      if (!p.alive || p.trapped) continue;
      if (p.mount === 'ufo') continue; // 骑飞碟时捡不到道具
      const tx = Math.floor(p.x / TILE);
      const ty = Math.floor(p.y / TILE);
      const idx = this.items.findIndex((it) => it.x === tx && it.y === ty);
      if (idx < 0) continue;
      const it = this.items.splice(idx, 1)[0];
      p.eaten.push(it.kind); // 记录吃过的道具（死亡时按 30% 撒回地图）
      if (it.kind === 'potion') p.range = Math.min(p.range + 1, p.caps.range);
      else if (it.kind === 'bubble') p.maxBombs = Math.min(p.maxBombs + 1, p.caps.bombs);
      else if (it.kind === 'shoe') p.speed = Math.min(p.speed + SHOE_STEP, p.caps.speed);
      else if (it.kind === 'gremlin') p.range = p.caps.range; // 紫魔：威力达到角色最大
      else if (it.kind === 'devil') p.speed = p.caps.speed;   // 红魔：速度达到角色最大
      else if (it.kind === 'needle') p.inv.needle = Math.min(p.inv.needle + 1, MAX_NEEDLE);
      else if (it.kind === 'remote') p.inv.remote = Math.min(p.inv.remote + 1, MAX_REMOTE);
      else if (it.kind === 'kick') p.kick = true; // 踢水泡能力
      else if (MOUNTS[it.kind]) p.mount = it.kind; // 坐骑：骑上（新坐骑替换旧坐骑）
    }
  }

  // 对局中断线按死亡处理
  markDisconnected(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.disconnected = true;
    if (p.alive) this.kill(p);
    this.checkOver();
  }

  checkOver() {
    if (this.over) return;
    const all = [...this.players.values()];
    const alive = all.filter((p) => p.alive);
    // 真人也全部断线 → 直接收场
    if (!all.some((p) => !p.isBot && !p.disconnected)) {
      this.over = true;
      this.winner = null;
      return;
    }
    if (alive.length <= 1) {
      this.over = true;
      this.winner = alive[0] ?? null;
    }
  }

  tick() {
    if (this.over) { // 终局后仍让死亡抛射落地（正常对局 interval 已停，仅供测试/兜底）
      this.updateLootShots();
      return;
    }
    // 开局 321 倒计时：全员冻结，回合表不走（看清楚自己的出生位置）
    if (this.warmup > 0) {
      this.warmup--;
      return;
    }
    this.tickCount++;
    for (const p of this.players.values()) if (p.grace > 0) p.grace--; // 坐骑挡炸的无敌期
    this.updateCrateSlides();
    this.updateBombSlides();
    this.updateBombPass();
    for (const p of this.players.values()) {
      if (p.alive && !p.trapped && !p.disconnected) this.movePlayer(p);
    }
    this.updateBombs();
    this.updateExplosions();
    this.applyFlameDamage();
    this.updateTraps();
    this.updateItems();
    this.updateLootShots();
    this.checkOver();
    // 回合超时：判平局
    if (!this.over && this.tickCount >= ROUND_TICKS) {
      this.over = true;
      this.winner = null;
    }
  }

  // 30Hz 快照：只带动态数据。玩家静态信息（name/char/isBot/colorIndex）在 gameStart 已下发；
  // grid 只在版本变化时携带（客户端保留上一份），两者合计省约 1/4 带宽
  snapshot() {
    const withGrid = this.gridVer !== this._sentGridVer;
    this._sentGridVer = this.gridVer;
    return {
      tick: this.tickCount,
      warmup: this.warmup,
      timeLeft: Math.max(0, Math.ceil((ROUND_TICKS - this.tickCount) / TICK_RATE)),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        x: Math.round(p.x), y: Math.round(p.y),
        alive: p.alive, trapped: p.trapped, mount: p.mount, kick: p.kick,
        speed: this.effSpeed(p), maxBombs: p.maxBombs, range: p.range,
        inv: { ...p.inv },
      })),
      bombs: [...this.bombs.values()].map((b) => ({
        x: b.tx, y: b.ty, sx: Math.round(b.px * 10) / 10, sy: Math.round(b.py * 10) / 10,
        fuse: b.fuse, remote: b.remote, owner: b.ownerId,
      })),
      expl: this.explosions.map((e) => ({ cells: e.cells, ttl: e.ttl })),
      items: this.items.map((it) => ({ x: it.x, y: it.y, kind: it.kind })),
      loot: this.lootShots.map((s) => ({
        kind: s.kind, x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, left: s.left, total: s.total,
      })),
      crateSlides: this.crateSlides.map((s) => ({ ...s })),
      ...(withGrid ? { grid: this.gridRows() } : {}),
    };
  }
}
