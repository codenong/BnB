// Bot AI：危险图 + BFS 寻路的状态机
// 优先级：逃命 > 放泡（确认有逃生路线）> 捡道具 / 找炸点 / 追人

import { TILE, COLS, ROWS, EMPTY, isSoft } from './map.js';
import { computeFlameCells, BOMB_FUSE_TICKS, ROUND_TICKS, TICK_RATE, DT } from './game.js';

const tile = (v) => Math.floor(v / TILE);
const key = (x, y) => `${x},${y}`;
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// 所有未爆水泡未来的火焰覆盖（软危险：可以穿过，但不能停留）
// 遥控水泡不会自行爆炸，不计入危险（由持有者的引爆逻辑单独处理）
export function flameDangerMap(game) {
  const danger = new Set();
  for (const b of game.bombs.values()) {
    if (b.remote) continue;
    for (const [x, y] of computeFlameCells(game.grid, b.tx, b.ty, b.range)) danger.add(key(x, y));
  }
  return danger;
}

// 正在爆炸的格子（硬危险：绝不踏入）
export function explosionSet(game) {
  const set = new Set();
  for (const e of game.explosions) for (const [x, y] of e.cells) set.add(key(x, y));
  return set;
}

export class BotBrain {
  constructor(id) {
    this.id = id;
    this.path = [];      // 剩余路径（格坐标，不含当前格）
    this.lastX = 0;
    this.lastY = 0;
    this.stuck = 0;
    this.escape = false; // 当前路径是否为逃生路径（逃生路径允许穿过未来火焰格）
    this._wp = null;     // followPath 正在走向的路径点标识
  }

  // 返回 {dirs: [...], place: boolean, use: boolean}
  decide(game) {
    const me = game.players.get(this.id);
    if (!me || !me.alive) return { dirs: [], place: false, use: false };
    // 被困时有针就自救
    if (me.trapped) return { dirs: [], place: false, use: me.inv.needle > 0 };
    const tx = tile(me.x);
    const ty = tile(me.y);
    const k = key(tx, ty);
    const flame = flameDangerMap(game);
    const boom = explosionSet(game);
    const union = new Set([...flame, ...boom]);

    // 自己的遥控水泡：一旦脱离其火焰范围就引爆（place = 空格语义，引擎内仲裁为引爆）
    for (const b of game.bombs.values()) {
      if (b.remote && b.ownerId === this.id) {
        const cells = computeFlameCells(game.grid, b.tx, b.ty, b.range);
        if (!cells.some(([x, y]) => x === tx && y === ty)) {
          return { dirs: this.followPath(me), place: true, use: false };
        }
      }
    }

    // 卡死检测：长时间没挪动就清空路径重新决策
    if (Math.abs(me.x - this.lastX) < 1 && Math.abs(me.y - this.lastY) < 1) this.stuck++;
    else this.stuck = 0;
    this.lastX = me.x;
    this.lastY = me.y;
    if (this.stuck > Math.round(1.25 * TICK_RATE)) { // 约 1.25s 没挪动
      this.path = [];
      this.escape = false;
      this.stuck = 0;
    }

    // 路径保持粘性：只在路径失效，或身处危险且无路可走时才重算逃生路。
    // 每 tick 按当前格重算会让路径点在格子边界处提前切换，导致斜切拐弯卡进砖块
    const invalid = this.pathInvalid(game, union, boom);
    if (invalid || (union.has(k) && this.path.length === 0)) {
      this.path = this.bfs(game, tx, ty, (x, y) => !union.has(key(x, y)), { avoid: boom })
        ?? this.randomStep(game, tx, ty, union);
      this.escape = true;
    } else if (this.path.length === 0) {
      const placed = this.tryPlace(game, me, tx, ty, flame, boom);
      if (placed) return placed;
      // 目标寻路失败时也随意挪一步，避免呆站
      this.path = this.findObjective(game, me, tx, ty, union)
      // findObjective 找不到任何目标(没道具没人没软块可炸)时,会掉到 randomStep 随便走一步——但传给它的危险集合是空的 new Set(),
      // 完全没把 union(当前所有危险格,包括自己那颗还没炸的泡)带进去!
      // ?? this.randomStep(game, tx, ty, new Set())
      ?? this.randomStep(game, tx, ty, union)
      ?? [];
      this.escape = false;
    }
    return { dirs: this.followPath(me), place: false };
  }

  // 路径是否失效：终点必须仍是安全格；途经格不能踩正爆炸的火焰、不能被新水泡堵住；
  // 非逃生路径额外要求不穿过任何危险格
  pathInvalid(game, union, boom) {
    if (this.path.length === 0) return false;
    for (const [x, y] of this.path) {
      if (boom.has(key(x, y)) || game.bombAt(x, y)) return true;
      if (!this.escape && union.has(key(x, y))) return true;
    }
    const [ex, ey] = this.path[this.path.length - 1];
    return union.has(key(ex, ey));
  }

  // 贴软块或贴敌人时放泡，前提是存在能在引信内走完的逃生路线
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
      blocked: new Set([key(tx, ty)]), // 放完后水泡格变实体，路径不能回穿
    });
    // 残局（时限过半后）逐步放松逃生要求：贴近敌人时即使没有稳妥逃生路也放泡，
    // 以换命促成对局终结，避免 Bot 残局无限僵持
    const desperation = game.tickCount / ROUND_TICKS;
    const margin = BOMB_FUSE_TICKS - Math.round(0.6 * TICK_RATE) - Math.floor(desperation * 1.5 * TICK_RATE);
    let path = escape && escape.length ? escape : null;
    if (path && escape.length * (TILE / game.effSpeed(me) / DT) > margin) path = null;
    if (!path && !(nearEnemy && Math.random() < Math.max(0, desperation - 0.4))) return null;
    this.path = path ?? [];
    this.escape = !!path;
    // 背包有遥控器且目标是打人（而非炸软块）时放遥控水泡（use = Ctrl 语义），
    // 脱离其火焰范围后由 decide 开头的分支引爆
    if (nearEnemy && !nearSoft && me.inv.remote > 0) {
      return { dirs: this.followPath(me), place: false, use: true };
    }
    return { dirs: this.followPath(me), place: true };
  }

  findObjective(game, me, tx, ty, danger) {
    const items = game.items;
    const enemies = [...game.players.values()].filter(
      (p) => p.id !== this.id && p.alive && !p.trapped,
    );
    const itemGoal = (x, y) => items.some((it) => it.x === x && it.y === y);
    const enemyGoal = (x, y) => enemies.some((e) => tile(e.x) === x && tile(e.y) === y);
    const softGoal = (x, y) => DIRS4.some(([dx, dy]) => isSoft(game.grid[y + dy]?.[x + dx]));
    // 基础 25% 概率主动追人，随回合推进越来越激进（配合回合时限促使对局收敛）
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

  randomStep(game, tx, ty, danger) {
    const options = [];
    for (const [dx, dy] of DIRS4) {
      const x = tx + dx;
      const y = ty + dy;
      if (this.walkable(game, x, y) && !danger.has(key(x, y))) options.push([x, y]);
    }
    return options.length ? [options[Math.floor(Math.random() * options.length)]] : [];
  }

  walkable(game, x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
    if (game.grid[y][x] !== EMPTY) return false;
    return !game.bombAt(x, y);
  }

  // BFS 最短路；avoid 中的格子不可进入也不可作终点；返回不含起点的路径，找不到返回 null
  bfs(game, sx, sy, isGoal, { avoid = new Set(), blocked = new Set(), maxDepth = 64 } = {}) {
    if (isGoal(sx, sy) && !avoid.has(key(sx, sy))) return [];
    const visited = new Set([key(sx, sy), ...blocked]);
    const queue = [[sx, sy, []]];
    while (queue.length) {
      const [x, y, path] = queue.shift();
      if (path.length >= maxDepth) continue;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx;
        const ny = y + dy;
        const nk = key(nx, ny);
        if (visited.has(nk) || !this.walkable(game, nx, ny)) continue;
        visited.add(nk);
        const np = [...path, [nx, ny]];
        if (isGoal(nx, ny) && !avoid.has(nk)) return np;
        if (!avoid.has(nk)) queue.push([nx, ny, np]);
      }
    }
    return null;
  }

  // 沿路径下一格输出方向（取像素偏差较大的轴）
  // 路径点必须走到格中心附近才算到达：提前转向会让碰撞盒横跨两列/两行，
  // 在窄通道里被砖块卡住（转角辅助只能纠正 ≤12px 的偏差）。
  // 到达判定 = 距中心 ≤3px，或某一轴的偏差符号翻转（防高速时跨过中心来回振荡）
  followPath(me) {
    while (this.path.length) {
      const [nx, ny] = this.path[0];
      const dx = nx * TILE + TILE / 2 - me.x;
      const dy = ny * TILE + TILE / 2 - me.y;
      const wp = `${nx},${ny}`;
      if (this._wp !== wp) {
        this._wp = wp;
        this._pdx = dx;
        this._pdy = dy;
      }
      const crossed = (dx !== 0 && this._pdx !== 0 && Math.sign(dx) !== Math.sign(this._pdx))
        || (dy !== 0 && this._pdy !== 0 && Math.sign(dy) !== Math.sign(this._pdy));
      if ((Math.abs(dx) <= 3 && Math.abs(dy) <= 3) || crossed) {
        this.path.shift();
        this._wp = null;
        continue;
      }
      this._pdx = dx;
      this._pdy = dy;
      if (Math.abs(dx) >= Math.abs(dy)) return [dx > 0 ? 'right' : 'left'];
      return [dy > 0 ? 'down' : 'up'];
    }
    return [];
  }
}
