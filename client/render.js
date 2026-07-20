// Canvas 渲染：正版素材贴图地图、水泡、火焰、道具、角色精灵；快照间线性插值让移动平滑

import { drawCharacter, charSprite, teamColor } from './characters.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const RENDER_SCALE = 2; // 画布放大倍率（逻辑坐标不变，高倍率保证全屏清晰）
const DEBUG_GRID = new URLSearchParams(location.search).has('grid'); // ?grid=1 红色辅助线
const VISUAL_DY = 5; // 视觉网格下移量：与箱顶（红线）对齐，物品/角色/水泡统一下移
const SRC_SCALE = 4; // 素材已 4× 超分：帧图集（坐骑/行走帧/死亡帧/水花/大水泡/道具帧）
                     // 源裁切坐标统一 ×4，逻辑显示尺寸不变（原 1× 版在 git 历史里）
const ASSET_V = '?v=sr4'; // 素材版本串：整批换图时 +1，绕过 /assets 的一天缓存

// ---- 子帧预渲染缓存：key -> 离屏 canvas（物理显示尺寸） ----
// 4× 超分素材的每帧降采样是主要绘制成本（软渲染实测同帧净耗 2.7ms vs 1.6ms）；
// 改为一次性高质量预渲染，之后每帧 1:1 blit。单个子帧仅几 KB 内存
const SPRITE_CACHE = new Map();
function spriteCache(key, lw, lh, draw) {
  let c = SPRITE_CACHE.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(lw * RENDER_SCALE));
    c.height = Math.max(1, Math.round(lh * RENDER_SCALE));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high'; // 降采样只做这一次，用高质量
    draw(g, c.width, c.height);
    SPRITE_CACHE.set(key, c);
  }
  return c;
}
// 大图解码预热（开局 321 期间完成，避免对局首帧突发解码 4× 图集掉帧）
const warmImg = (img) => img?.decode?.().catch(() => {});

// ---- 正版素材贴图（按截图逐格抠出：client/assets/） ----
const tileImgs = {};
let tilesReady = false;
{
  const defs = {
    floor: 'floor', floorH: 'floor_h', box: 'box', crate: 'crate',
    cannon: 'cannon', mast: 'mast',
  };
  let pending = Object.keys(defs).length;
  for (const [k, name] of Object.entries(defs)) {
    const img = new Image();
    img.onload = () => { if (--pending === 0) tilesReady = true; };
    img.src = `/assets/${name}.png${ASSET_V}`;
    tileImgs[k] = img;
  }
}

// 水球序列帧（popo/b*.png 蓝；popo/r*.png 遥控橙）
const popoImgs = [];
const popoRemoteImgs = [];
{
  for (let i = 0; i < 3; i++) {
    const b = new Image();
    b.src = `/assets/popo/b${i}.png${ASSET_V}`;
    popoImgs.push(b);
    const r = new Image();
    r.src = `/assets/popo/r${i}.png${ASSET_V}`;
    popoRemoteImgs.push(r);
  }
}

// 坐骑贴图（原版整合格式：2 列×4 行，行=方向 0上/1下/2左/3右，列为行走帧）
const MOUNT_SPRITES = {};
{
  const defs = {
    turtle: ['SlowTurtle', 48, 32, 0.94],        // 绿乌龟（慢）
    pirateTurtle: ['Turtle', 48, 32, 0.94],      // 海盗龟（快，棕红）
    owl: ['Owl', 40, 40, 0.83],                  // 猫头鹰
    ufo: ['FastUFO', 52, 31, 0.98],              // 飞碟
  }; // 骑行贴图统一缩小 25%（原 1.25/1.25/1.1/1.3）
  for (const [kind, [name, fw, fh, scale]] of Object.entries(defs)) {
    const img = new Image();
    img.src = `/assets/pic/${name}.png${ASSET_V}`;
    MOUNT_SPRITES[kind] = { img, fw, fh, scale };
  }
}
const DIR_ROW = { '0,-1': 0, '0,1': 1, '-1,0': 2, '1,0': 3 };
const EMPTY_SET = new Set(); // 行缓存绘制用（无滑动箱需跳过）

// 原版行走帧图集（6 列×4 行；行=方向，60ms 级联帧）：宝宝 / 小海盗
const ANIM_SPRITES = {};
{
  const defs = {
    baobao: [48, 64],
    haidao: [56, 67],
  };
  for (const [cid, [fw, fh]] of Object.entries(defs)) {
    ANIM_SPRITES[cid] = { fw, fh, sheets: new Map() };
  }
}
function animSheet(cid, colorIndex) {
  const rec = ANIM_SPRITES[cid];
  if (!rec) return null;
  let img = rec.sheets.get(colorIndex);
  if (!img) {
    img = new Image();
    img.src = `/assets/anim/${cid}_${['red', 'blue', 'green', 'yellow', 'purple', 'orange'][Math.abs(colorIndex ?? 0) % 6]}.png${ASSET_V}`;
    rec.sheets.set(colorIndex, img);
  }
  return img.complete && img.naturalWidth ? { img, ...rec } : null;
}

// 爆炸水花帧（560×200：14 列×5 行 40×40；行 0上/1下/2左/3右 端点臂，行 4 中心）
const explosionImg = new Image();
explosionImg.src = `/assets/pic/Explosion.png${ASSET_V}`;
// 被困大水泡帧（648×72：9 帧 72×72；0-3 生长并定格第 3 帧=被困，4-8 破裂）
const bigPopoImg = new Image();
bigPopoImg.src = `/assets/pic/BigPopo.png${ASSET_V}`;
// 角色死亡动画（原版 Role*Die：11 帧，角色缓缓裹进泡泡化掉）
const DIE_SPRITES = {
  baobao: { fw: 48, fh: 100, frames: 11, img: new Image() },
  haidao: { fw: 56, fh: 98, frames: 11, img: new Image() },
};
DIE_SPRITES.baobao.img.src = `/assets/pic/Role1Die.png${ASSET_V}`;
DIE_SPRITES.haidao.img.src = `/assets/pic/Role2Die.png${ASSET_V}`;
// 道具地面投影（36×9）
const shadowGiftImg = new Image();
shadowGiftImg.src = `/assets/pic/ShadowGift.png${ASSET_V}`;
// 角色地面投影（32×15）
const shadowRoleImg = new Image();
shadowRoleImg.src = `/assets/pic/ShadowRole.png${ASSET_V}`;

// 道具图标精灵（原版素材：pic/Gift* 三帧动画；items/* 盛大原版/派生）
const ITEM_SPRITES = {};
{
  // kind -> [src, 帧宽, 帧高, 帧数, 显示宽]
  const defs = {
    potion: ['/assets/pic/Gift3.png', 42, 45, 3, 26],
    bubble: ['/assets/pic/Gift1.png', 42, 45, 3, 26],
    shoe: ['/assets/pic/Gift2.png', 42, 45, 3, 28],
    gremlin: ['/assets/items2/gremlin.png', 42, 45, 1, 28], // 紫魔：威力满
    devil: ['/assets/items2/devil.png', 42, 45, 1, 28],     // 红魔：速度满
    turtle: ['/assets/pic/Gift8.png', 36, 41, 3, 34],
    owl: ['/assets/pic/Gift7.png', 36, 38, 3, 34],
    ufo: ['/assets/pic/Gift9.png', 40, 41, 3, 34],
    pirateTurtle: ['/assets/items/pirateTurtle.png', 36, 41, 3, 34],
    needle: ['/assets/items/needle.png', 28, 29, 1, 24],
    remote: ['/assets/items/remote.png', 34, 35, 1, 26],
    kick: ['/assets/pic/Gift6.png', 42, 46, 3, 28],
  };
  for (const [kind, [src, fw, fh, frames, dispW]] of Object.entries(defs)) {
    const img = new Image();
    img.src = src + ASSET_V;
    ITEM_SPRITES[kind] = { img, fw, fh, frames, dispW };
  }
}

// 道具图标：原版精灵图（三帧动画），未加载完时用仿盛大 Canvas 图标兜底
export function drawItemIcon(ctx, kind, cx, cy, now) {
  const yy = cy + Math.sin(now / 350 + cx) * 1.5; // 轻微浮动
  const sp = ITEM_SPRITES[kind];
  if (sp && sp.img.complete && sp.img.naturalWidth) {
    const f = Math.floor(now / 240) % sp.frames;
    const w = sp.dispW;
    const h = w * (sp.fh / sp.fw);
    const c = spriteCache(`item_${kind}_${f}`, w, h, (g, W, H) => {
      g.drawImage(sp.img, f * sp.fw * SRC_SCALE, 0, sp.fw * SRC_SCALE, sp.fh * SRC_SCALE, 0, 0, W, H);
    });
    ctx.drawImage(c, cx - w / 2, yy - h / 2, w, h);
    return;
  }
  drawItemIconCanvas(ctx, kind, cx, yy, now);
}

// 仿盛大版小物件造型兜底（水球/药瓶/鞋子/针/遥控器），坐骑用圆形徽章
const MOUNT_BADGE = {
  turtle: ['龟', '#16a34a'],
  owl: ['鹰', '#b45309'],
  pirateTurtle: ['龟', '#dc2626'],
  ufo: ['碟', '#475569'],
};

function drawItemIconCanvas(ctx, kind, cx, cy, now) {
  const yy = cy;
  if (kind === 'bubble') { // 泡泡：蓝色水球
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(cx, yy - 2, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0284c7';
    ctx.stroke();
    ctx.fillStyle = '#e0f2fe';
    ctx.beginPath();
    ctx.arc(cx - 3, yy - 5, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0284c7'; // 球结
    ctx.beginPath();
    ctx.moveTo(cx - 2, yy + 7);
    ctx.lineTo(cx + 2, yy + 7);
    ctx.lineTo(cx, yy + 11);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'potion') { // 药水：药瓶
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.roundRect(cx - 7, yy - 4, 14, 12, 4);
    ctx.fill();
    ctx.fillRect(cx - 3, yy - 9, 6, 5); // 瓶颈
    ctx.fillStyle = '#fff'; // 十字
    ctx.fillRect(cx - 5, yy - 1, 10, 3);
    ctx.fillRect(cx - 1.5, yy - 3.5, 3, 8);
  } else if (kind === 'gremlin' || kind === 'devil') { // 紫魔/红魔：带角小魔头
    ctx.fillStyle = kind === 'gremlin' ? '#9333ea' : '#dc2626';
    ctx.beginPath();
    ctx.moveTo(cx - 6, yy - 6); // 左角
    ctx.lineTo(cx - 9, yy - 12);
    ctx.lineTo(cx - 3, yy - 8);
    ctx.moveTo(cx + 6, yy - 6); // 右角
    ctx.lineTo(cx + 9, yy - 12);
    ctx.lineTo(cx + 3, yy - 8);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, yy, 9, 0, Math.PI * 2); // 脸
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx - 3.5, yy - 2, 2, 0, Math.PI * 2); // 双眼
    ctx.arc(cx + 3.5, yy - 2, 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'shoe') { // 鞋子
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.roundRect(cx - 10, yy + 1, 20, 6, 3); // 鞋底
    ctx.fill();
    ctx.roundRect(cx - 10, yy - 7, 10, 9, 3); // 鞋帮
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - 8, yy - 4, 6, 2); // 鞋带
  } else if (kind === 'needle') { // 针
    ctx.strokeStyle = '#9333ea';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - 6, yy + 8);
    ctx.lineTo(cx + 5, yy - 7);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#d8b4fe';
    ctx.beginPath();
    ctx.arc(cx + 5, yy - 7, 2.5, 0, Math.PI * 2); // 针眼
    ctx.stroke();
  } else if (kind === 'remote') { // 遥控器
    ctx.fillStyle = '#374151';
    ctx.beginPath();
    ctx.roundRect(cx - 6, yy - 8, 12, 16, 3);
    ctx.fill();
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, yy - 8);
    ctx.lineTo(cx + 4, yy - 13); // 天线
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(cx, yy - 3, 2.5, 0, Math.PI * 2); // 按钮
    ctx.fill();
    ctx.fillStyle = '#9ca3af';
    ctx.fillRect(cx - 3, yy + 3, 6, 2);
  } else { // 坐骑：圆形徽章
    const [txt, color] = MOUNT_BADGE[kind] ?? ['?', '#64748b'];
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, yy, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = color;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, cx, yy + 1);
  }
}

// 坐骑：原版 4 向贴图（行=方向，移动时两列切换）；未加载完时 Canvas 兜底
function drawMount(ctx, kind, x, y, now, dir = [0, 1], moving = false) {
  const sp = MOUNT_SPRITES[kind];
  if (sp && sp.img.complete && sp.img.naturalWidth) {
    const row = DIR_ROW[String(dir)] ?? 1;
    const col = moving ? Math.floor(now / 120) % 2 : 0;
    const w = sp.fw * sp.scale;
    const h = sp.fh * sp.scale;
    const c = spriteCache(`mount_${kind}_${row}_${col}`, w, h, (g, W, H) => {
      g.drawImage(sp.img, col * sp.fw * SRC_SCALE, row * sp.fh * SRC_SCALE, sp.fw * SRC_SCALE, sp.fh * SRC_SCALE, 0, 0, W, H);
    });
    ctx.drawImage(c, x - w / 2, y + 14 - h, w, h);
    return;
  }
  drawMountCanvas(ctx, kind, x, y, now);
}

// 坐骑 Canvas 兜底
function drawMountCanvas(ctx, kind, x, y, now) {
  const bob = Math.sin(now / 300) * 1.5;
  if (kind === 'turtle' || kind === 'pirateTurtle') {
    const shell = kind === 'turtle' ? '#16a34a' : '#dc2626';
    const rim = kind === 'turtle' ? '#14532d' : '#7f1d1d';
    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.ellipse(x, y + 8 + bob, 15, 9, 0, 0, Math.PI * 2); // 龟壳
    ctx.fill();
    ctx.strokeStyle = rim;
    ctx.stroke();
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(x + 14, y + 6 + bob, 4, 0, Math.PI * 2); // 头
    ctx.fill();
  } else if (kind === 'owl') {
    const flap = Math.sin(now / 120) * 4;
    ctx.fillStyle = '#b45309';
    ctx.beginPath(); // 双翅
    ctx.ellipse(x - 10, y + 4 - flap, 9, 5, -0.5, 0, Math.PI * 2);
    ctx.ellipse(x + 10, y + 4 - flap, 9, 5, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#92400e';
    ctx.beginPath();
    ctx.ellipse(x, y + 8, 9, 7, 0, 0, Math.PI * 2); // 身体
    ctx.fill();
  } else if (kind === 'ufo') {
    ctx.fillStyle = 'rgba(186, 230, 253, 0.8)';
    ctx.beginPath();
    ctx.arc(x, y + 2 + bob, 7, Math.PI, 0); // 圆顶
    ctx.fill();
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.ellipse(x, y + 8 + bob, 16, 6, 0, 0, Math.PI * 2); // 碟身
    ctx.fill();
    ctx.strokeStyle = '#475569';
    ctx.stroke();
    ctx.fillStyle = '#facc15'; // 灯
    for (const dx of [-9, 0, 9]) {
      ctx.beginPath();
      ctx.arc(x + dx, y + 8 + bob, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// 自己头顶的蓝色水球标记（原版同款）
function drawSelfMarker(ctx, x, topY, now) {
  const bob = Math.sin(now / 400) * 2.5;
  const y = topY - 12 + bob;
  ctx.strokeStyle = 'rgba(240, 249, 255, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); // 细绳
  ctx.moveTo(x, topY);
  ctx.quadraticCurveTo(x + 3, y + 9, x, y + 6);
  ctx.stroke();
  const g = ctx.createRadialGradient(x - 3, y - 4, 1, x, y, 9);
  g.addColorStop(0, '#bae6fd');
  g.addColorStop(0.55, '#38bdf8');
  g.addColorStop(1, '#0369a1');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2); // 水球
  ctx.fill();
  ctx.fillStyle = '#0369a1'; // 球结
  ctx.beginPath();
  ctx.moveTo(x - 2.5, y + 6);
  ctx.lineTo(x + 2.5, y + 6);
  ctx.lineTo(x, y + 10);
  ctx.closePath();
  ctx.fill();
}

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false }); // 不透明画布：省合成开销（每帧全覆盖地板）
    this.prev = null;
    this.curr = null;
    this.prevAt = 0;
    this.currAt = 0;
    this.raf = 0;
    this.face = new Map();     // playerId -> [dx, dy] 朝向
    this.moving = new Map();   // playerId -> 最后一次移动的时间戳
    this.dead = new Set();     // 已播过死亡动画的 playerId
    this.effects = [];         // 死亡动画（水泡炸裂）实例
    this.trapAt = new Map();   // playerId -> 被困开始的本地时刻（播水泡生长帧）
    this.lift = new Map();     // playerId -> {v, t} 骑坐骑的抬升量（平滑上/下坐骑）
    this.lootSeen = new Map(); // 抛射物 key -> {t0, dur}（墙钟进度：终局快照停发也能飞完）
    this.grid = null;          // 最新地图（init 来自 gameStart；快照只在变化时携带 grid）
    this._floorCache = null;   // 地板离屏缓存（整幅静态，每帧一次 blit）
    this._rowCache = [];       // 各行障碍物离屏缓存（2.5D 遮挡需按行与角色交错，行变化时重建）
    this._tilesApplied = false; // 静态缓存是否已基于就绪贴图构建（贴图后加载完需重建）
  }

  init(msg) {
    this.tile = msg.tileSize;
    this.grid = msg.map; // 初始地图（首个快照到来前渲染用）
    this.yourId = msg.yourId;
    this.cv.width = msg.map[0].length * this.tile * RENDER_SCALE;
    this.cv.height = msg.map.length * this.tile * RENDER_SCALE;
    this.ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0); // 逻辑坐标绘制，放大输出
    this._floorCache = null;
    this._rowCache = [];
    // 解码预热：321 冻结期间把本局用到的 4× 图集提前解码，避免开局首帧掉帧
    warmImg(explosionImg);
    warmImg(bigPopoImg);
    warmImg(DIE_SPRITES.baobao.img);
    warmImg(DIE_SPRITES.haidao.img);
    for (const sp of Object.values(MOUNT_SPRITES)) warmImg(sp.img);
    for (const p of msg.players ?? []) {
      animSheet(p.char, p.colorIndex); // 触发本局角色图集加载（缺席时创建）
      const rec = ANIM_SPRITES[p.char];
      if (rec) warmImg(rec.sheets.get(p.colorIndex));
    }
  }

  pushState(s) {
    if (s.grid) { // 地图变化时快照才携带 grid：逐行对比，标脏变化行的障碍缓存
      if (this.grid) {
        for (let y = 0; y < s.grid.length; y++) {
          if (this.grid[y] !== s.grid[y]) this._rowCache[y] = null;
        }
      }
      this.grid = s.grid;
    }
    this.prev = this.curr;
    this.prevAt = this.currAt;
    this.curr = s;
    this.currAt = performance.now();
  }

  start() {
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  // 渲染时间比最新快照慢一拍，在两个快照间插值
  positions() {
    const now = performance.now();
    const span = Math.max(this.currAt - this.prevAt, 16);
    const alpha = clamp01((now - this.currAt) / span);
    const out = new Map();
    for (const p of this.curr.players) {
      const q = this.prev?.players.find((o) => o.id === p.id);
      let x = p.x;
      let y = p.y;
      if (q && q.alive && p.alive) {
        x = q.x + (p.x - q.x) * alpha;
        y = q.y + (p.y - q.y) * alpha;
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.5) {
          this.face.set(p.id, Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)]);
          this.moving.set(p.id, now);
        }
      }
      out.set(p.id, { ...p, x, y });
    }
    return out;
  }

  // 甲板地板离屏缓存：整幅静态（不参与遮挡排序），每帧一次 blit 替代逐格 drawImage
  renderFloorCache() {
    const { tile: T } = this;
    const rows = this.grid.length;
    const cols = this.grid[0].length;
    const cv = document.createElement('canvas');
    cv.width = cols * T * RENDER_SCALE;
    cv.height = rows * T * RENDER_SCALE;
    const g = cv.getContext('2d');
    g.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        // 甲板拼花：横竖两种木板纹理按 (x+y) 棋盘交错
        if (tilesReady) {
          g.drawImage((x + y) % 2 === 0 ? tileImgs.floor : tileImgs.floorH, x * T, y * T, T, T);
        } else {
          g.fillStyle = '#b98d35'; // 贴图未加载：木地板兜底色
          g.fillRect(x * T, y * T, T, T);
        }
      }
    }
    this._floorCache = cv;
  }

  // 第 y 行障碍物的离屏缓存：条带覆盖 [行顶上一格, 行底+箱子阴影溢出]（船炮向上延伸一格、
  // 箱子底部阴影溢出格底），按行序 blit 时下一行盖住上一行溢出的阴影，与逐行直接绘制一致
  renderRowCache(y) {
    const { tile: T } = this;
    const cols = this.grid[0].length;
    const h = Math.ceil(T * 2.4); // 上溢 1 格 + 本格 + 箱子 T*1.2 构图的阴影溢出
    const cv = document.createElement('canvas');
    cv.width = cols * T * RENDER_SCALE;
    cv.height = h * RENDER_SCALE;
    const g = cv.getContext('2d');
    g.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
    g.translate(0, T - y * T); // 条带原点对应逻辑坐标 (0, y*T - T)
    this.drawObstacleRow(this.grid, y, EMPTY_SET, g);
    this._rowCache[y] = cv;
  }

  // 第 y 行的障碍物（黄箱/X木箱/船炮；滑动中的箱子按其插值位置单独画）
  // g：目标上下文（默认主画布；渲染行缓存时传条带上下文）
  drawObstacleRow(grid, y, slidingFrom, g = this.ctx) {
    const { tile: T } = this;
    for (let x = 0; x < grid[y].length; x++) {
      const ch = grid[y][x];
      // 箱子贴图 40×48（原版 2.5D 构图）：顶边在格顶下 5px，底部双层阴影溢出格底 13px；
      // 逐行绘制时下一行箱子盖住上一行溢出的阴影，形成堆叠感
      if (ch === 'o' && tilesReady) g.drawImage(tileImgs.box, x * T, y * T + T / 8, T, T * 1.2);
      else if (ch === 'x' && tilesReady && !slidingFrom.has(`${x},${y}`)) {
        g.drawImage(tileImgs.crate, x * T, y * T + T / 8, T, T * 1.2);
      } else if ((ch === 'o' || ch === 'x') && !tilesReady) { // 兜底
        g.fillStyle = '#d97706';
        g.fillRect(x * T + 2, y * T + 2, T - 4, T - 4);
      } else if (ch === '#') { // 船炮：向上延伸一格（资源图1 整格切图，含甲板底座）
        if (tilesReady) g.drawImage(tileImgs.cannon, x * T, y * T - T, T, T * 2);
        else {
          g.fillStyle = '#111827';
          g.beginPath();
          g.arc(x * T + T / 2, y * T + T / 2, T / 2 - 2, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  }

  drawItem(it, now) {
    const { ctx, tile: T } = this;
    const icx = it.x * T + T / 2;
    if (shadowGiftImg.complete && shadowGiftImg.naturalWidth) {
      ctx.drawImage(shadowGiftImg, icx - 14, it.y * T + T - 11 + VISUAL_DY, 28, 7);
    }
    drawItemIcon(ctx, it.kind, icx, it.y * T + T / 2 + VISUAL_DY, now);
  }

  drawBomb(b, now) {
    const { ctx, tile: T } = this;
    const cx = b.sx ?? b.x * T + T / 2;
    const cy = (b.sy ?? b.y * T + T / 2) + VISUAL_DY;
    const urgent = !b.remote && b.fuse < 20;
    const frame = Math.floor(now / (urgent ? 90 : 300)) % 3;
    const img = (b.remote ? popoRemoteImgs : popoImgs)[frame];
    if (img?.complete && img.naturalWidth) {
      const w = T * 0.95;
      const h = w * (img.naturalHeight / img.naturalWidth);
      const scale = urgent ? 1 + 0.08 * Math.sin(now / 60) : 1;
      const c = spriteCache(`popo_${b.remote ? 'r' : 'b'}${frame}_${T}`, w, h, (g, W, H) => {
        g.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, W, H);
      });
      ctx.drawImage(c, cx - (w * scale) / 2, cy - (h * scale) / 2 - 2, w * scale, h * scale);
    } else { // 兜底：渐变水球
      const r = 13 * (urgent ? 1 + 0.12 * Math.sin(now / 60) : 1);
      const body = b.remote ? '#f97316' : '#38bdf8';
      const edge = b.remote ? '#c2410c' : '#0284c7';
      const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r * 1.1);
      g.addColorStop(0, '#e0f2fe');
      g.addColorStop(0.5, body);
      g.addColorStop(1, edge);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.stroke();
    }
    if (b.remote) { // 遥控水泡的小天线
      ctx.strokeStyle = '#c2410c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 14);
      ctx.lineTo(cx, cy - 20);
      ctx.stroke();
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(cx, cy - 21, 2.5 + Math.sin(now / 150), 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1;
    }
  }


  draw() {
    const { ctx, tile: T } = this;
    const grid = this.grid;
    if (!grid) return;
    if (tilesReady && !this._tilesApplied) { // 贴图加载完成：重建静态缓存（此前画的是兜底色）
      this._tilesApplied = true;
      this._floorCache = null;
      this._rowCache = [];
    }
    const now = performance.now();
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);

    // 1) 甲板地板（静态离屏缓存，整幅 blit）
    if (!this._floorCache) this.renderFloorCache();
    ctx.drawImage(this._floorCache, 0, 0, grid[0].length * T, grid.length * T);

    // 2) 画家算法（拟 2.5D，从下往上算坐标）：按行自远及近，
    //    第 y 行障碍物（离屏缓存）→ 该行地面物（道具/水泡）→ 落在该行的滑箱 →
    //    基线 ≤ (y+1)*T 的角色（含坐骑）；行越靠下越能遮住远的
    const slides = this.curr?.crateSlides ?? [];
    const slidingFrom = new Set(slides.map((s) => `${s.fx},${s.fy}`));
    const slideRows = new Set(slides.map((s) => s.fy)); // 滑出源行不能用缓存（源格箱子正在滑走）
    const H = T * 1.3; // 精灵身高 ~1.3 格
    const players = [];
    if (this.curr) {
      for (const p of this.positions().values()) {
        players.push({ p, by: p.y + T * 0.42 + VISUAL_DY - (this.lift.get(p.id)?.v ?? 0) });
      }
      players.sort((a, b) => a.by - b.by);
      const ids = new Set(players.map((e) => e.p.id)); // 清掉离场玩家的残留状态
      for (const key of this.lift.keys()) if (!ids.has(key)) this.lift.delete(key);
      for (const key of this.trapAt.keys()) if (!ids.has(key)) this.trapAt.delete(key);
    }
    let pi = 0;
    const flushPlayers = (limitY) => {
      while (pi < players.length && players[pi].by <= limitY) {
        this.drawPlayer(players[pi++].p, now, H);
      }
    };
    for (let y = 0; y < grid.length; y++) {
      if (slideRows.has(y)) { // 有箱子滑出：该行动态绘制
        this.drawObstacleRow(grid, y, slidingFrom);
      } else {
        if (!this._rowCache[y]) this.renderRowCache(y);
        const rc = this._rowCache[y];
        ctx.drawImage(rc, 0, y * T - T, grid[0].length * T, rc.height / RENDER_SCALE);
      }
      if (tilesReady && y === 7) {
        // 中央桅杆（海盗旗）：锚定在基座所在行之后，前排行/角色可遮住其底座
        ctx.drawImage(tileImgs.mast, 5 * T, 2 * T, T * 5, T * 6);
      }
      if (this.curr) {
        for (const it of this.curr.items) if (it.y === y) this.drawItem(it, now);
        for (const b of this.curr.bombs) if (b.y === y) this.drawBomb(b, now);
        if (tilesReady) {
          for (const s of slides) {
            const prog = 1 - s.left / s.total;
            const lerpY = s.fy + (s.ty - s.fy) * prog;
            if (Math.floor(lerpY) === y) {
              ctx.drawImage(tileImgs.crate,
                (s.fx + (s.tx - s.fx) * prog) * T, lerpY * T + T / 8, T, T * 1.2);
            }
          }
        }
      }
      flushPlayers((y + 1) * T);
    }
    flushPlayers(Infinity);

    // 3) 爆炸火焰、死亡抛射、死亡特效（最上层，见下）
    this.drawExplosions(now, T);
    this.drawLootShots(now);
    this.drawDeathEffects(now);

    // 4) 321 等待期：在自己头顶画醒目下箭头指示位置
    this.drawCountdownArrow(now);

    // 5) 调试：?grid=1 时画红色格子辅助线（最上层，便于核对地板/箱子对齐）
    if (DEBUG_GRID) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.55)';
      ctx.lineWidth = 1 / RENDER_SCALE; // 1 物理像素细线
      for (let x = 0; x <= grid[0].length; x++) {
        ctx.beginPath();
        ctx.moveTo(x * T, 0);
        ctx.lineTo(x * T, grid.length * T);
        ctx.stroke();
      }
      for (let y = 0; y <= grid.length; y++) {
        ctx.beginPath(); // 横线下移 5px：与箱子上边缘齐平
        ctx.moveTo(0, y * T + 5);
        ctx.lineTo(grid[0].length * T, y * T + 5);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawCountdownArrow(now) {
    if (!this.curr?.warmup) return;
    const me = this.curr.players.find((p) => p.id === this.yourId && p.alive);
    if (!me) return;
    const { ctx, tile: T } = this;
    const H = T * 1.3;
    const feetY = me.y + T * 0.42 + VISUAL_DY - (this.lift.get(me.id)?.v ?? 0);
    const topY = feetY - H;
    const bob = Math.abs(Math.sin(now / 220)) * 12;
    const y = Math.max(topY - 34 - bob, 16);
    ctx.save();
    ctx.translate(me.x, y);
    ctx.fillStyle = '#ff3b30';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 16); // 指向下方的尖角
    ctx.lineTo(-17, -7);
    ctx.lineTo(-7, -7);
    ctx.lineTo(-7, -18);
    ctx.lineTo(7, -18);
    ctx.lineTo(7, -7);
    ctx.lineTo(17, -7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // 死亡爆装备的抛射物：从死亡点沿抛物线飞到落点（飞完由服务器生成地面道具）
  // 进度用本地墙钟而非快照 left：终局后快照停发，仍要飞完落地
  drawLootShots(now) {
    if (!this.curr) return;
    const shots = this.curr.loot ?? [];
    const { ctx, tile: T } = this;
    const alive = new Set();
    for (const s of shots) {
      const key = `${s.kind}:${s.x0},${s.y0}>${s.x1},${s.y1}`;
      alive.add(key);
      if (!this.lootSeen.has(key)) this.lootSeen.set(key, { t0: now, dur: s.total * (1000 / 30) });
      const { t0, dur } = this.lootSeen.get(key);
      const prog = Math.min(1, (now - t0) / dur);
      if (prog >= 1) { // 已落地（服务器还没来得及生成/快照停发）：画地面形态
        const icx = s.x1;
        if (shadowGiftImg.complete && shadowGiftImg.naturalWidth) {
          ctx.drawImage(shadowGiftImg, icx - 14, s.y1 + T / 2 - 11 + VISUAL_DY, 28, 7);
        }
        drawItemIcon(ctx, s.kind, icx, s.y1 + VISUAL_DY, now);
        continue;
      }
      const px = s.x0 + (s.x1 - s.x0) * prog;
      const arc = (T * 0.9 + Math.hypot(s.x1 - s.x0, s.y1 - s.y0) * 0.25) * Math.sin(Math.PI * prog);
      const py = s.y0 + (s.y1 - s.y0) * prog - arc;
      drawItemIcon(ctx, s.kind, px, py + VISUAL_DY, now);
    }
    for (const key of this.lootSeen.keys()) if (!alive.has(key)) this.lootSeen.delete(key);
  }

  drawExplosions(now, T) {
    const { ctx } = this;
    if (!this.curr) return;
    // 爆炸火焰（原版水花帧：爆心循环帧、臂段静态、端点 8 帧突进）
    for (const e of this.curr.expl) {
      if (explosionImg.complete && explosionImg.naturalWidth) {
        const [cx0, cy0] = e.cells[0]; // 首格为爆心
        const set = new Set(e.cells.map(([x, y]) => `${x},${y}`));
        const prog = Math.min(1, (15 - e.ttl) / 15); // 火焰生命周期进度
        const tipF = Math.min(7, Math.floor(prog * 8));
        const centerF = Math.floor(now / 100) % 4;
        for (const [x, y] of e.cells) {
          let row;
          let col;
          if (x === cx0 && y === cy0) {
            row = 4;
            col = centerF; // 中心循环
          } else {
            const sgn = y === cy0 ? Math.sign(x - cx0) : Math.sign(y - cy0);
            const horiz = y === cy0;
            row = horiz ? (sgn > 0 ? 3 : 2) : (sgn > 0 ? 1 : 0);
            const isTip = horiz ? !set.has(`${x + sgn},${y}`) : !set.has(`${x},${y + sgn}`);
            col = isTip ? 6 + tipF : 3; // 端点突进帧 / 臂段静态帧
          }
          const c = spriteCache(`expl_${row}_${col}_${T}`, T, T, (g, W, H) => {
            g.drawImage(explosionImg, col * 40 * SRC_SCALE, row * 40 * SRC_SCALE, 40 * SRC_SCALE, 40 * SRC_SCALE, 0, 0, W, H);
          });
          ctx.drawImage(c, x * T, y * T, T, T);
        }
      } else { // 兜底：蓝色火焰块
        const a = Math.max(e.ttl / 10, 0) * 0.9;
        for (const [x, y] of e.cells) {
          ctx.fillStyle = `rgba(125, 211, 252, ${a * 0.85})`;
          ctx.fillRect(x * T + 3, y * T + 3, T - 6, T - 6);
          ctx.fillStyle = `rgba(255, 255, 255, ${a * 0.9})`;
          ctx.fillRect(x * T + T / 2 - 7, y * T + T / 2 - 7, 14, 14);
        }
      }
    }
  }

  drawPlayer(p, now, H) {
    const { ctx, tile: T } = this;
    if (!p.alive) { // 刚阵亡：在原地播一次死亡动画（角色化泡 + 水泡破裂）
      if (!this.dead.has(p.id)) {
        this.dead.add(p.id);
        this.effects.push({ x: p.x, y: p.y, at: now, char: p.char });
      }
      return;
    }
    // 记录被困开始时刻（本地首见 trapped 的一帧，用于播水泡生长帧）
    if (p.trapped) { if (!this.trapAt.has(p.id)) this.trapAt.set(p.id, now); }
    else this.trapAt.delete(p.id);

    // 骑坐骑的抬升量：上坐骑平滑升起，坐骑被打掉平滑落下
    const ls = this.lift.get(p.id) ?? { v: 0, t: now };
    const k = Math.min(1, (now - ls.t) / 125); // 约 0.4s 完成过渡
    const lift = ls.v + ((p.mount ? T * 0.26 : 0) - ls.v) * k;
    this.lift.set(p.id, { v: lift, t: now });

    const isMoving = now - (this.moving.get(p.id) ?? 0) < 150;
    const groundY = p.y + T * 0.42 + VISUAL_DY; // 地面基线（不含坐骑抬升）
    const feetY = groundY - lift;
    const faceDir = this.face.get(p.id) ?? [0, 1];

    // 地面投影（脚下；骑乘时角色抬高、阴影留在地面）
    if (shadowRoleImg.complete && shadowRoleImg.naturalWidth) {
      ctx.drawImage(shadowRoleImg, p.x - 12, groundY - 9, 24, 11.25);
    }
    // 坐骑遮挡层级：动物坐骑（龟/鹰）垫在角色脚下，人物在上层；
    // 飞碟（ufo）在人物之后再画，碟身盖住人物下半身——原版同款坐在座舱里的观感
    if (p.mount && p.mount !== 'ufo') {
      drawMount(ctx, p.mount, p.x, p.y + VISUAL_DY, now, faceDir, isMoving);
    }

    const anim = ANIM_SPRITES[p.char] ? animSheet(p.char, p.colorIndex) : null;
    if (anim) { // 宝宝/小海盗：原版 4 向 6 帧行走（被困 0/1 帧挣扎，闲置定格 0）
      const row = DIR_ROW[String(faceDir)] ?? 1;
      // 上/下坐骑的过渡中角色先站住（定格 0 帧），抬升/落下到位后再走
      const settling = Math.abs((p.mount ? T * 0.26 : 0) - lift) > 0.5;
      const f = p.trapped ? Math.floor(now / 120) % 2 : (isMoving && !settling) ? Math.floor(now / 100) % 6 : 0;
      const w = anim.fw * (H / anim.fh);
      const c = spriteCache(`anim_${p.char}_${p.colorIndex}_${row}_${f}`, w, H, (g, W, H2) => {
        g.drawImage(anim.img, f * anim.fw * SRC_SCALE, row * anim.fh * SRC_SCALE, anim.fw * SRC_SCALE, anim.fh * SRC_SCALE, 0, 0, W, H2);
      });
      ctx.drawImage(c, p.x - w / 2, feetY - H, w, H);
    } else {
      drawCharacter(ctx, p.char, p.colorIndex, p.x, feetY, H, isMoving ? now : 0, true);
    }

    if (p.mount === 'ufo') { // 飞碟上层：盖住人物下半身（大水泡/名字仍在更上层）
      drawMount(ctx, p.mount, p.x, p.y + VISUAL_DY, now, faceDir, isMoving);
    }

    // 被困：BigPopo 大水泡包住角色（0-3 帧生长，定格第 3 帧直到脱困）
    if (p.trapped) {
      if (bigPopoImg.complete && bigPopoImg.naturalWidth) {
        const f = Math.min(3, Math.floor((now - (this.trapAt.get(p.id) ?? now)) / 110));
        const bw = H * 1.25;
        const c = spriteCache(`big_${f}_${Math.round(bw)}`, bw, bw, (g, W, H2) => {
          g.drawImage(bigPopoImg, f * 72 * SRC_SCALE, 0, 72 * SRC_SCALE, 72 * SRC_SCALE, 0, 0, W, H2);
        });
        ctx.drawImage(c, p.x - bw / 2, feetY - H * 0.5 - bw / 2, bw, bw);
      } else { // 兜底：半透明水泡
        const cy = feetY - H * 0.45;
        ctx.fillStyle = 'rgba(125, 211, 252, 0.5)';
        ctx.beginPath();
        ctx.arc(p.x, cy, H * 0.42 + Math.sin(now / 200) * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    const topY = feetY - H;

    // 名字（队伍颜色，被困时避开大水泡；顶部出生者下移避免出界）
    const nameY = Math.max(topY - (p.trapped ? 10 : 2), 12);
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(12, 74, 110, 0.8)';
    ctx.strokeText(p.name, p.x, nameY);
    ctx.fillStyle = teamColor(p.colorIndex);
    ctx.fillText(p.name, p.x, nameY);

    // 自己的头顶蓝色水球标记（顶行者右移避免与名字重叠/出界）
    if (p.id === this.yourId) {
      const headRoom = topY - 9 >= 20;
      drawSelfMarker(ctx, p.x + (headRoom ? 0 : 14), Math.max(topY - 9, 22), now);
    }

    if (p.trapped) {
      // 有针时在头顶脉动提示自救按键
      if (p.inv.needle > 0) {
        const pulse = 1 + 0.08 * Math.sin(now / 150);
        ctx.save();
        ctx.translate(p.x, topY - 22);
        ctx.scale(pulse, pulse);
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(12, 74, 110, 0.8)';
        ctx.strokeText('按 Ctrl 自救', 0, 0);
        ctx.fillStyle = '#fef08a';
        ctx.fillText('按 Ctrl 自救', 0, 0);
        ctx.restore();
      }
    }
  }

  // 死亡动画：角色 Role*Die 11 帧化泡（1.1s）+ 大水泡破裂（BigPopo 第 4-8 帧，0.6s）
  drawDeathEffects(now) {
    const { ctx, tile: T } = this;
    this.effects = this.effects.filter((e) => now - e.at < 1100);
    for (const e of this.effects) {
      const age = now - e.at;
      // 角色死亡帧（与行走图同比例，底部对齐死亡位置）
      const die = DIE_SPRITES[e.char];
      if (die && die.img.complete && die.img.naturalWidth) {
        const f = Math.min(die.frames - 1, Math.floor(age / 100));
        const scale = (T * 1.3) / (ANIM_SPRITES[e.char]?.fh ?? 64);
        const w = die.fw * scale;
        const h = die.fh * scale;
        const feetY = e.y + T * 0.42 + VISUAL_DY;
        const c = spriteCache(`die_${e.char}_${f}_${Math.round(h)}`, w, h, (g, W, H2) => {
          g.drawImage(die.img, f * die.fw * SRC_SCALE, 0, die.fw * SRC_SCALE, die.fh * SRC_SCALE, 0, 0, W, H2);
        });
        ctx.drawImage(c, e.x - w / 2, feetY - h, w, h);
      }
      // 水泡破裂（前 0.6s）
      const t = age / 600;
      if (t < 1) {
        if (bigPopoImg.complete && bigPopoImg.naturalWidth) {
          const f = 4 + Math.min(4, Math.floor(t * 5));
          const w = T * 1.7;
          const c = spriteCache(`bigb_${f}_${Math.round(w)}`, w, w, (g, W, H2) => {
            g.drawImage(bigPopoImg, f * 72 * SRC_SCALE, 0, 72 * SRC_SCALE, 72 * SRC_SCALE, 0, 0, W, H2);
          });
          ctx.drawImage(c, e.x - w / 2, e.y + VISUAL_DY - w / 2 - 8, w, w);
          continue;
        }
        const r = 16 + t * 30;
        ctx.strokeStyle = `rgba(186, 230, 253, ${1 - t})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(125, 211, 252, ${1 - t})`;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r * 0.8, 3.5 * (1 - t), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.lineWidth = 1;
      }
    }
  }
}

export { charSprite };
