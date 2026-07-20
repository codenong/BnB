// 游戏引擎单元测试（node:test）

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game, TILE, BOMB_FUSE_TICKS, EXPLOSION_TICKS, TRAP_TICKS, ROUND_TICKS, WARMUP_TICKS, PUSH_TICKS,
} from '../server/game.js';
import {
  buildMap, COLS, ROWS, EMPTY, WALL, SOFT, HOUSE, CRATE, SPAWNS, isSoft,
} from '../server/map.js';
import { CHARACTERS } from '../server/characters.js';

const DEFS = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
];

// random 固定返回 0.99：默认不掉道具；warmup: 0 跳过开局 321 冻结
function makeGame(random = () => 0.99) {
  const game = new Game(DEFS.map((d) => ({ ...d })), { random, warmup: 0 });
  setTilePos(game, 'a', 1, 1); // 固定 a 到 (1,1)，便于构造道具场景
  return game;
}

// 清空整个场地与场上道具，便于构造实验场景（海盗14 无边界墙，全图清空）
function clearField(game) {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) game.grid[y][x] = EMPTY;
  }
  game.items = [];
}

function setTilePos(game, id, tx, ty) {
  const p = game.players.get(id);
  p.x = tx * TILE + TILE / 2;
  p.y = ty * TILE + TILE / 2;
}

test('开局 321 倒计时：热身期冻结，之后正常走表', () => {
  const game = new Game(DEFS.map((d) => ({ ...d })), { random: () => 0.99 });
  assert.equal(game.warmup, WARMUP_TICKS);
  // 热身期：不能放泡、不走表、不动
  const ax = game.players.get('a').x;
  assert.ok(!game.placeBomb('a'), '倒计时内不能放泡');
  game.setInput('a', ['down']);
  const y0 = game.players.get('a').y;
  for (let i = 0; i < 10; i++) game.tick();
  assert.equal(game.tickCount, 0, '倒计时内回合表不走');
  assert.equal(game.players.get('a').y, y0, '倒计时内玩家不动');
  assert.equal(ax, game.players.get('a').x);
  assert.equal(game.snapshot().warmup, WARMUP_TICKS - 10);
  // 热身结束：tick 开始推进，移动恢复
  for (let i = 0; i < WARMUP_TICKS - 10; i++) game.tick();
  assert.equal(game.warmup, 0);
  game.tick();
  assert.equal(game.tickCount, 1);
  assert.ok(game.players.get('a').y > y0, '倒计时结束后输入生效');
});

test('海盗14 地图结构合法', () => {
  const g = buildMap();
  assert.equal(g.length, ROWS);
  assert.ok(g.every((r) => r.length === COLS));
  // 出生点均为天然空格
  for (const [x, y] of SPAWNS) {
    assert.equal(g[y][x], EMPTY, `出生点 (${x},${y}) 应为空`);
  }
  // 正版截图逐格转录：黄箱 + X 木箱均超百个（可炸）
  const flat = g.flat();
  assert.ok(flat.filter(isSoft).length >= 100, '可炸箱子应遍布全场');
  assert.ok(flat.filter((t) => t === CRATE).length >= 20, 'X 纹木箱应足够多');
  // 四角船炮（不可破坏）+ 中央桅杆（旗杆/船帆/船首底座）
  for (const [x, y] of [[1, 1], [13, 1], [1, 11], [13, 11]]) {
    assert.equal(g[y][x], WALL, `(${x},${y}) 应为船炮`);
  }
  for (const [x, y] of [[7, 4], [6, 5], [7, 5], [8, 5], [6, 6], [7, 6], [8, 6]]) {
    assert.equal(g[y][x], HOUSE, `(${x},${y}) 应为桅杆`);
  }
  assert.equal(g[3][7], EMPTY, '(7,3) 旗顶尖可穿行（mask 效果，非实体）');
  // 左右对称（与正版截图一致，每行回文）
  for (let y = 0; y < ROWS; y++) {
    assert.deepEqual(g[y], [...g[y]].reverse(), `第 ${y} 行应左右对称`);
  }
});

test('放水泡与数量上限', () => {
  const game = makeGame();
  assert.ok(game.placeBomb('a'));
  assert.ok(!game.placeBomb('a')); // 同一格不能重复放
  setTilePos(game, 'a', 3, 3);
  assert.ok(!game.placeBomb('a')); // maxBombs=1，第一个未爆
});

test('爆炸十字传播：摧毁软块、被墙阻挡、掉落道具', () => {
  const game = makeGame(() => 0); // random=0 → 必掉道具
  clearField(game);
  game.grid[3][3] = SOFT;
  game.grid[0][1] = WALL; // 海盗14 无边界墙，显式放墙验证阻断
  setTilePos(game, 'a', 1, 3);
  game.players.get('a').range = 3;
  assert.ok(game.placeBomb('a'));
  setTilePos(game, 'a', 6, 6); // 躲开火焰
  for (let i = 0; i < BOMB_FUSE_TICKS; i++) game.tick();

  assert.equal(game.explosions.length, 1);
  const cells = game.explosions[0].cells.map(([x, y]) => `${x},${y}`);
  // 向右：经过 (2,3)，被 (3,3) 软块挡住（软块格包含）
  assert.ok(cells.includes('1,3') && cells.includes('2,3') && cells.includes('3,3'));
  assert.ok(!cells.includes('4,3'), '软块应阻断火焰');
  // 向上：(1,2)(1,1)，(1,0) 是墙不包含
  assert.ok(cells.includes('1,2') && cells.includes('1,1'));
  assert.ok(!cells.includes('1,0'), '墙应阻断火焰');
  // 软块被摧毁且掉落道具
  assert.equal(game.grid[3][3], EMPTY);
  assert.equal(game.items.length, 1);
  assert.equal(game.items[0].kind, 'potion'); // random=0 → 第一种道具
});

test('连锁引爆', () => {
  const game = makeGame();
  clearField(game);
  setTilePos(game, 'a', 2, 2);
  setTilePos(game, 'b', 2, 3);
  assert.ok(game.placeBomb('a'));
  assert.ok(game.placeBomb('b'));
  setTilePos(game, 'a', 6, 6);
  setTilePos(game, 'b', 9, 9);
  for (let i = 0; i < BOMB_FUSE_TICKS; i++) game.tick();
  assert.equal(game.bombs.size, 0, '两个水泡都应在同一 tick 引爆');
  assert.equal(game.explosions.length, 2);
});

test('被炸中 → 困在水泡 → 超时死亡 → 分出胜负', () => {
  const game = makeGame();
  clearField(game);
  setTilePos(game, 'a', 5, 5);
  setTilePos(game, 'b', 5, 5);
  assert.ok(game.placeBomb('b'));
  setTilePos(game, 'b', 9, 9); // b 躲开

  for (let i = 0; i < BOMB_FUSE_TICKS; i++) game.tick();
  const a = game.players.get('a');
  assert.ok(a.alive && a.trapped, 'a 应被困在水泡里');

  for (let i = 0; i < TRAP_TICKS; i++) game.tick();
  assert.ok(!a.alive, '被困超时后死亡');
  assert.ok(game.over);
  assert.equal(game.winner?.id, 'b');
});

test('被困者被其他玩家触碰立即死亡', () => {
  const game = makeGame();
  clearField(game);
  setTilePos(game, 'a', 5, 5);
  setTilePos(game, 'b', 5, 5);
  assert.ok(game.placeBomb('b'));
  setTilePos(game, 'b', 9, 9);
  for (let i = 0; i < BOMB_FUSE_TICKS; i++) game.tick();
  assert.ok(game.players.get('a').trapped);

  for (let i = 0; i < EXPLOSION_TICKS + 2; i++) game.tick(); // 等火焰熄灭（被困状态仍持续）
  assert.ok(game.players.get('a').trapped);
  setTilePos(game, 'b', 5, 5); // b 走过去戳破
  game.tick();
  assert.ok(!game.players.get('a').alive);
});

test('推箱子：长按方向键把 X 木箱推到空地；有阻挡时推不动', () => {
  const game = makeGame();
  clearField(game);
  // 推到动作为止的辅助（含走近箱子的几步）
  const pushedTo = (x, y, max = PUSH_TICKS + 10) => {
    for (let i = 0; i < max; i++) {
      game.tick();
      if (game.grid[y][x] === CRATE) return true;
    }
    return false;
  };
  game.grid[1][2] = CRATE; // a 在 (1,1)，向右推 (2,1)->(3,1)->(4,1)
  game.setInput('a', ['right']);
  for (let i = 0; i < 4; i++) game.tick();
  assert.equal(game.grid[1][2], CRATE, '刚到长按时间前不能秒推');
  assert.ok(pushedTo(3, 1), '长按后箱子被推到 (3,1)');
  assert.ok(pushedTo(4, 1, PUSH_TICKS + 22), '可连续推动到 (4,1)');
  // 前方是墙：推不动
  game.grid[1][5] = WALL;
  assert.ok(!pushedTo(5, 1), '墙挡着推不动');
  // 前方是箱子：推不动
  game.grid[1][5] = CRATE;
  for (let i = 0; i < PUSH_TICKS * 2; i++) game.tick();
  assert.equal(game.grid[1][4], CRATE, '箱子挡着推不动');
  // 前方是水泡：推不动
  game.grid[1][5] = EMPTY;
  setTilePos(game, 'b', 5, 1);
  assert.ok(game.placeBomb('b'));
  assert.ok(!pushedTo(5, 1), '水泡挡着推不动');
});

test('推箱子：黄箱不可推动，被推走的箱子仍可被炸毁', () => {
  const game = makeGame();
  clearField(game);
  game.grid[1][2] = SOFT; // 黄箱
  game.setInput('a', ['right']);
  for (let i = 0; i < PUSH_TICKS * 3; i++) game.tick();
  assert.equal(game.grid[1][2], SOFT, '黄箱推不动');
  // 推走后炸毁：推 (2,1) X 箱到 (3,1)，再在 (3,3) 放泡把它炸掉
  game.grid[1][2] = CRATE;
  game.setInput('a', ['right']);
  let pushed = false;
  for (let i = 0; i < PUSH_TICKS + 8 && !pushed; i++) {
    game.tick();
    pushed = game.grid[1][2] === EMPTY;
  }
  assert.ok(pushed, '长按后 (2,1) 箱子被推走');
  assert.equal(game.grid[1][3], CRATE);
  game.setInput('a', []);
  setTilePos(game, 'b', 3, 3);
  game.players.get('b').range = 2; // 本用例假设爆炸威力 2（宝宝初始威力 1，勿依赖角色默认值）
  assert.ok(game.placeBomb('b')); // 威力 2：向上 (3,2)(3,1)
  setTilePos(game, 'b', 9, 9);
  for (let i = 0; i < BOMB_FUSE_TICKS; i++) game.tick();
  assert.equal(game.grid[1][3], EMPTY, '被推走的箱子同样被炸毁');
});

test('推箱子：滑动途中被炸 → 滑动取消，目标格不生成箱子', () => {
  const game = makeGame();
  clearField(game);
  game.grid[1][2] = CRATE;
  game.setInput('a', ['right']);
  let started = false;
  for (let i = 0; i < PUSH_TICKS + 12 && !started; i++) {
    game.tick();
    started = game.crateSlides.length === 1;
  }
  assert.ok(started, '长按后应启动滑动');
  assert.equal(game.grid[1][2], CRATE, '滑动期间源格仍是箱子');
  game.grid[1][2] = EMPTY; // 模拟滑到一半被炸飞
  for (let i = 0; i < 10; i++) game.tick();
  assert.equal(game.crateSlides.length, 0);
  assert.equal(game.grid[1][3], EMPTY, '滑动取消，目标格不生成箱子');
});

test('踢水泡：一脚踢到底，撞上墙/箱子/其他水泡才停下', () => {
  const game = makeGame();
  clearField(game);
  const a = game.players.get('a');
  game.items.push({ x: 1, y: 1, kind: 'kick' });
  game.tick();
  assert.equal(a.kick, true, '吃到踢水泡能力');
  game.grid[1][6] = WALL;
  setTilePos(game, 'b', 2, 1);
  assert.ok(game.placeBomb('b')); // 水泡在 (2,1)
  const b = [...game.bombs.values()][0];
  game.setInput('a', ['right']);
  // 踢飞后会滑动；持续按住会反复再踢（正常），先滑到 (5,1) 再松手
  for (let i = 0; i < 60 && b.tx !== 5; i++) game.tick();
  assert.equal(b.tx, 5, '水泡滑到墙前一格 (5,1) 才停');
  game.setInput('a', []);
  for (let i = 0; i < 12 && b.slide; i++) game.tick(); // 等最后一次再踢的滑动落定
  assert.equal(b.slide, null, '松手后水泡落定');
  assert.equal(b.tx, 5);
  game.setInput('a', []);
  // 再验证：水泡撞上另一个水泡时，停在其前一格
  const g2 = makeGame();
  clearField(g2);
  setTilePos(g2, 'b', 2, 1);
  assert.ok(g2.placeBomb('b')); // b 的泡挡在 (5,1) 之前…先放远处障碍泡 (5,1)
  setTilePos(g2, 'a', 5, 1);
  assert.ok(g2.placeBomb('a')); // a 的泡 (5,1) 作障碍
  g2.players.get('a').kick = true;
  setTilePos(g2, 'a', 1, 1);
  g2.setInput('a', ['right']);
  const kicked = [...g2.bombs.values()].find((bb) => bb.tx === 2 && bb.ty === 1);
  for (let i = 0; i < 40; i++) g2.tick();
  assert.equal(kicked.tx, 4, '水泡滑到另一个水泡前一格 (4,1) 停下');
});

test('乘骑时踢技暂不生效，下马后恢复', () => {
  const game = makeGame();
  clearField(game);
  const a = game.players.get('a'); // 出生在 (1,1)
  a.kick = true;
  a.mount = 'turtle'; // 乘骑状态
  setTilePos(game, 'b', 2, 1);
  assert.ok(game.placeBomb('b')); // 水泡在 (2,1)
  const b = [...game.bombs.values()][0];
  game.setInput('a', ['right']);
  for (let i = 0; i < 30; i++) game.tick();
  assert.equal(b.slide ?? null, null, '乘骑时踢不动水泡');
  assert.equal(b.tx, 2, '水泡原地不动');
  // 坐骑被打掉（下马）后恢复踢技
  a.mount = null;
  game.grid[1][6] = WALL;
  for (let i = 0; i < 60 && b.tx !== 5; i++) game.tick();
  assert.equal(b.tx, 5, '下马后恢复踢技，水泡滑到墙前一格 (5,1)');
});

test('踢泡无视地面漂浮道具（直接穿过，道具还在）', () => {
  const game = makeGame();
  clearField(game);
  const a = game.players.get('a');
  a.kick = true;
  setTilePos(game, 'b', 2, 1);
  assert.ok(game.placeBomb('b')); // 水泡在 (2,1)
  setTilePos(game, 'b', 10, 10); // b 挪走，不挡路
  const b = [...game.bombs.values()][0];
  game.items.push({ x: 4, y: 1, kind: 'potion' }); // 滑动路径上的漂浮道具
  game.grid[1][7] = WALL;
  game.setInput('a', ['right']);
  for (let i = 0; i < 60 && b.tx !== 6; i++) game.tick();
  assert.equal(b.tx, 6, '水泡穿过道具，滑到墙前一格 (6,1)');
  assert.ok(game.items.some((it) => it.x === 4 && it.y === 1 && it.kind === 'potion'), '道具原地保留');
});

test('踢泡被角色拦截：撞到人即停在其前一格', () => {
  const game = makeGame();
  clearField(game);
  const a = game.players.get('a');
  a.kick = true;
  setTilePos(game, 'b', 2, 1);
  assert.ok(game.placeBomb('b')); // 水泡在 (2,1)
  setTilePos(game, 'b', 5, 1); // b 站在 (5,1) 拦截
  const b = [...game.bombs.values()][0];
  game.setInput('a', ['right']);
  for (let i = 0; i < 40; i++) game.tick();
  assert.equal(b.tx, 4, '水泡被人挡住，停在 (4,1)');
  assert.equal(b.ty, 1);
});

test('死亡爆装备：吃过的道具按 30% 从死亡点四面抛射，落地后生成', () => {
  // 3 人对局：a 死后游戏不结束，抛射继续飞
  const game = new Game([
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
  ], { random: () => 0.1, warmup: 0 });
  clearField(game);
  const a = game.players.get('a');
  setTilePos(game, 'a', 1, 1);
  game.items.push({ x: 1, y: 1, kind: 'potion' });
  game.tick();
  game.items.push({ x: 1, y: 1, kind: 'bubble' });
  game.tick();
  game.items.push({ x: 1, y: 1, kind: 'shoe' });
  game.tick();
  assert.deepEqual(a.eaten, ['potion', 'bubble', 'shoe'], '吃过的道具被记录');
  game.kill(a);
  assert.equal(a.eaten.length, 0, '抛出后清空记录');
  assert.equal(game.items.length, 0, '抛射飞行中地上还没有');
  assert.equal(game.lootShots.length, 3, 'random=0.1<0.3 全部抛出');
  const targets = new Set();
  for (const s of game.lootShots) {
    const dist = Math.abs(s.tx - 1) + Math.abs(s.ty - 1);
    assert.ok(dist >= 1, '从死亡点 (1,1) 向外抛');
    assert.equal(game.grid[s.ty][s.tx], EMPTY, '落点可通行');
    targets.add(`${s.tx},${s.ty}`);
  }
  assert.equal(targets.size, 3, '落点互不重叠');
  for (let i = 0; i < 12; i++) game.tick();
  assert.equal(game.lootShots.length, 0, '抛射飞完');
  assert.equal(game.items.length, 3, '落地生成道具');
  assert.deepEqual(game.items.map((it) => it.kind).sort(), ['bubble', 'potion', 'shoe']);
});

test('道具拾取与属性成长', () => {
  const game = makeGame();
  const a = game.players.get('a'); // 出生在 (1,1)
  game.items.push({ x: 1, y: 1, kind: 'bubble' });
  game.tick();
  assert.equal(a.maxBombs, 2, '宝宝初始水泡 1，吃一颗到 2');
  game.items.push({ x: 1, y: 1, kind: 'potion' });
  game.tick();
  assert.equal(a.range, 2, '宝宝初始威力 1，吃一瓶药水到 2');
});

test('最后存活者获胜', () => {
  const game = makeGame();
  game.kill(game.players.get('b'));
  game.tick();
  assert.ok(game.over);
  assert.equal(game.winner?.id, 'a');
});

test('角色初始能力不同（名册：宝宝/小海盗）', () => {
  const game = new Game([
    { id: 'a', name: 'A', char: 'baobao' },
    { id: 'b', name: 'B', char: 'haidao' },
  ], { warmup: 0 });
  const a = game.players.get('a');
  const b = game.players.get('b');
  // 平衡版数值（官方为锚微调）：早期泡数持平（各 1）；海盗威 2 换宝宝速度快 1 级
  assert.equal(a.range, 1, '宝宝初始威力 1');
  assert.equal(b.range, 2, '小海盗初始威力 2（爆破型：隔箱安全放泡的小优势）');
  assert.equal(a.maxBombs, 1, '宝宝初始水泡 1');
  assert.equal(b.maxBombs, 1, '小海盗初始水泡 1（泡+1≈开荒翻倍，不给）');
  assert.equal(a.speed, 144, '宝宝初始速度 6 级（速度型快人一步）');
  assert.equal(b.speed, 120, '小海盗初始速度 5 级');
  // 后期分工：威力同到 7；宝宝极速 10 级 > 小海盗 9 级；小海盗水泡 8 > 宝宝 6
  assert.deepEqual(a.caps, { speed: 240, range: 7, bombs: 6 });
  assert.deepEqual(b.caps, { speed: 216, range: 7, bombs: 8 });
  // 未指定角色时回退默认（宝宝）
  const g2 = makeGame();
  assert.equal(g2.players.get('a').char, 'baobao');
});

test('火焰会烧毁地面上的道具', () => {
  const game = makeGame();
  clearField(game);
  setTilePos(game, 'a', 1, 1);
  game.items.push({ x: 2, y: 1, kind: 'potion' });
  game.items.push({ x: 1, y: 2, kind: 'bubble' });
  game.items.push({ x: 6, y: 6, kind: 'shoe' }); // 火焰覆盖不到
  assert.ok(game.placeBomb('a')); // (1,1) 威力 2 → 覆盖 (2,1) 与 (1,2)
  setTilePos(game, 'a', 8, 8); // 躲开火焰，也避免踩到 (6,6) 的道具
  for (let i = 0; i < BOMB_FUSE_TICKS; i++) game.tick();
  assert.deepEqual(game.items, [{ x: 6, y: 6, kind: 'shoe' }]);
});

test('共 2 个角色且成长上限互不相同', () => {
  assert.equal(CHARACTERS.length, 2);
  const ids = new Set(CHARACTERS.map((c) => c.id));
  assert.deepEqual([...ids].sort(), ['baobao', 'haidao']);
  assert.notDeepEqual(CHARACTERS[0].caps, CHARACTERS[1].caps, '成长上限应互不相同');
});

test('针：被困时使用可自救', () => {
  const game = makeGame();
  clearField(game);
  const a = game.players.get('a');
  game.items.push({ x: 1, y: 1, kind: 'needle' });
  game.tick(); // a 出生在 (1,1)，捡起针
  assert.equal(a.inv.needle, 1);

  setTilePos(game, 'a', 5, 5);
  setTilePos(game, 'b', 5, 5);
  assert.ok(game.placeBomb('b'));
  setTilePos(game, 'b', 9, 9);
  for (let i = 0; i < BOMB_FUSE_TICKS; i++) game.tick();
  assert.ok(a.trapped, 'a 应被困');

  assert.ok(game.useItem('a'), '有针时自救成功');
  assert.ok(!a.trapped);
  assert.equal(a.inv.needle, 0, '针被消耗');
});

test('遥控水泡：Ctrl 放出、不自动爆炸、空格引爆、可被连锁引爆', () => {
  const game = makeGame();
  clearField(game);
  const a = game.players.get('a');
  game.items.push({ x: 1, y: 1, kind: 'remote' });
  game.items.push({ x: 1, y: 1, kind: 'remote' });
  game.tick();
  game.tick(); // 捡起 2 个遥控器
  assert.equal(a.inv.remote, 2);

  // 普通放泡不再消耗遥控器
  setTilePos(game, 'a', 2, 2);
  assert.ok(game.placeBomb('a'));
  assert.equal(a.inv.remote, 2, '普通水泡不消耗遥控器');
  setTilePos(game, 'a', 8, 8);
  for (const b of game.bombs.values()) b.fuse = 0; // 直接引爆清场
  game.tick();
  assert.equal(game.bombs.size, 0);

  // Ctrl（useItem）放遥控水泡，消耗遥控器
  setTilePos(game, 'a', 3, 3);
  assert.ok(game.useItem('a'), 'useItem 放遥控水泡');
  assert.equal(a.inv.remote, 1, '放遥控水泡消耗遥控器');
  setTilePos(game, 'a', 8, 8);
  for (let i = 0; i < 80; i++) game.tick(); // 远超普通引信时间
  assert.equal(game.bombs.size, 1, '遥控水泡不自动爆炸');

  // 空格语义：自己有未爆遥控泡时 placeBomb 改为引爆
  assert.ok(game.placeBomb('a'), '空格引爆遥控水泡');
  game.tick();
  assert.equal(game.bombs.size, 0);
  assert.ok(game.explosions.length >= 1);

  // 第二个遥控水泡被普通水泡连锁引爆
  setTilePos(game, 'a', 5, 5);
  assert.ok(game.useItem('a')); // 遥控
  setTilePos(game, 'b', 5, 6);
  assert.ok(game.placeBomb('b')); // 普通，火焰覆盖 (5,5)
  setTilePos(game, 'a', 9, 9);
  setTilePos(game, 'b', 1, 9);
  for (let i = 0; i < BOMB_FUSE_TICKS + 1; i++) game.tick();
  assert.equal(game.bombs.size, 0, '遥控水泡应被连锁引爆');
});

test('紫魔与红魔：威力/速度直接满值', () => {
  const game = makeGame();
  const a = game.players.get('a');
  game.items.push({ x: 1, y: 1, kind: 'gremlin' });
  game.tick();
  assert.equal(a.range, 7, '紫魔：威力达到宝宝上限 7');
  game.items.push({ x: 1, y: 1, kind: 'devil' });
  game.tick();
  assert.equal(a.speed, 240, '红魔：速度达到宝宝上限 240');
});

test('回合限时 3 分钟：超时判平局', () => {
  const game = makeGame();
  game.tickCount = ROUND_TICKS - 1; // 快进到最后一刻
  game.tick();
  assert.ok(game.over);
  assert.equal(game.winner, null, '超时无胜者（平局）');
});

test('坐骑：骑上替代速度，新坐骑替换旧的', () => {
  const game = makeGame();
  const a = game.players.get('a'); // 出生在 SPAWNS[0]
  assert.equal(game.effSpeed(a), 144, '宝宝初始速度 6 级');
  game.items.push({ x: 1, y: 1, kind: 'turtle' });
  game.tick();
  assert.equal(a.mount, 'turtle');
  assert.equal(game.effSpeed(a), 84, '绿乌龟很慢（负面）');
  game.items.push({ x: 1, y: 1, kind: 'owl' });
  game.tick();
  assert.equal(a.mount, 'owl', '新坐骑替换旧的');
  assert.equal(game.effSpeed(a), 156);
});

test('坐骑挡一命：被炸先掉坐骑，再炸才被困', () => {
  const game = makeGame();
  clearField(game);
  const a = game.players.get('a');
  game.items.push({ x: 1, y: 1, kind: 'pirateTurtle' });
  game.tick();
  assert.equal(a.mount, 'pirateTurtle');

  setTilePos(game, 'a', 5, 5);
  setTilePos(game, 'b', 5, 5);
  assert.ok(game.placeBomb('b'));
  setTilePos(game, 'b', 9, 9);
  for (let i = 0; i < BOMB_FUSE_TICKS; i++) game.tick();
  assert.equal(a.mount, null, '坐骑被炸没');
  assert.ok(!a.trapped, '人没被困（坐骑挡了一命）');
  assert.ok(a.grace > 0, '落地短暂无敌');

  // 无敌期过后再被炸 → 被困
  a.grace = 0;
  setTilePos(game, 'b', 6, 5);
  assert.ok(game.placeBomb('b'));
  setTilePos(game, 'b', 1, 9);
  for (let i = 0; i < BOMB_FUSE_TICKS + 1; i++) game.tick();
  assert.ok(a.trapped, '没有坐骑后被困');
});

test('飞碟：飞越场内障碍但不能捡道具，也飞不出地图', () => {
  const game = makeGame();
  const a = game.players.get('a');
  game.items.push({ x: 1, y: 1, kind: 'ufo' });
  game.tick();
  assert.equal(a.mount, 'ufo');
  game.grid[3][3] = SOFT;
  assert.ok(!game.solidFor(3, 3, a), '飞碟可越过软块');
  assert.ok(game.solidFor(-1, 3, a), '地图边界不可越过');
  assert.ok(game.solidFor(3, -1, a), '地图边界不可越过');
  // 骑飞碟捡不到道具
  game.items.push({ x: 1, y: 1, kind: 'potion' });
  game.tick();
  assert.ok(game.items.some((it) => it.kind === 'potion'), '道具还在地上');
  assert.equal(a.range, 1, '没捡到（威力不变）');
});

test('地图初始摆放 6 只坐骑（180° 对称成对）', () => {
  const game = makeGame();
  const mounts = game.items.filter((it) => ['turtle', 'owl', 'pirateTurtle', 'ufo'].includes(it.kind));
  assert.equal(mounts.length, 6);
  assert.equal(mounts.filter((m) => m.kind === 'turtle').length, 2);
  assert.equal(mounts.filter((m) => m.kind === 'owl').length, 2);
  assert.equal(mounts.filter((m) => m.kind === 'pirateTurtle').length, 2);
});
