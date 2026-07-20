// 角色展示数据与精灵图绘制（与 server/characters.js 的属性保持一致）
// 名册 2 人（均有原版 4 向行走帧）：宝宝 / 小海盗；每角色 6 套队伍配色精灵图

export const CHARACTERS = [
  {
    id: 'baobao', name: '宝宝', desc: '速度型',
    speed: 144, range: 1, bombs: 1,
  },
  {
    id: 'haidao', name: '小海盗', desc: '爆破型',
    speed: 120, range: 2, bombs: 1,
  },
];

// 6 套队伍配色（进入房间按 slot 顺序分配；同一角色也有不同颜色版本）
export const TEAM_KEYS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
export const TEAM_COLORS = ['#e23b3b', '#2f7fe0', '#3fae4e', '#e0a92e', '#9b59d0', '#ef7a1a'];

export function getChar(id) {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}

export const teamKey = (colorIndex) => TEAM_KEYS[Math.abs(colorIndex ?? 0) % TEAM_KEYS.length];
export const teamColor = (colorIndex) => TEAM_COLORS[Math.abs(colorIndex ?? 0) % TEAM_COLORS.length];

// ---- 精灵图加载（按需、缓存） ----
const sprites = new Map(); // "char_team" -> {img, loaded}
const ASSET_V = '?v=sr4'; // 素材版本串（与 render.js 同步）：整批换图时 +1，绕缓存

export function charSprite(charId, colorIndex) {
  const key = `${getChar(charId).id}_${teamKey(colorIndex)}`;
  let rec = sprites.get(key);
  if (!rec) {
    rec = { img: new Image(), loaded: false };
    rec.img.onload = () => { rec.loaded = true; };
    rec.img.src = `/assets/chars/${key}.png${ASSET_V}`;
    sprites.set(key, rec);
  }
  return rec;
}

// 在游戏内绘制角色：脚底锚点为 (cx, feetY)，身高 h（逻辑像素）。
// t 为动画时间（0 表示静止），shadow 为是否画地面投影。
// 移动时播放行走动画：上下颠步 + 左右小幅倾斜（原版立绘无序列帧的角色用此法示意行走）
export function drawCharacter(ctx, charId, colorIndex, cx, feetY, h, t = 0, shadow = true) {
  const rec = charSprite(charId, colorIndex);
  if (shadow) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.25)';
    ctx.beginPath();
    ctx.ellipse(cx, feetY - h * 0.02, h * 0.3, h * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (rec.loaded) {
    const w = (rec.img.width / rec.img.height) * h;
    if (t) { // 行走示意动画
      const step = Math.sin(t / 130);
      const bob = -Math.abs(step) * h * 0.045;
      ctx.save();
      ctx.translate(cx, feetY);
      ctx.rotate(step * 0.07);
      ctx.scale(1, 1 - Math.abs(step) * 0.04);
      ctx.drawImage(rec.img, -w / 2, -h + bob, w, h);
      ctx.restore();
      return;
    }
    ctx.drawImage(rec.img, cx - w / 2, feetY - h, w, h);
    return;
  }
  // 精灵未加载完时的兜底：队伍色小球
  const bob = t ? Math.sin(t / 150) * h * 0.05 : 0;
  ctx.fillStyle = teamColor(colorIndex);
  ctx.beginPath();
  ctx.arc(cx, feetY - h * 0.45 + bob, h * 0.28, 0, Math.PI * 2);
  ctx.fill();
}

// 头像（房间卡片/玩家列表用）：取头部特写，返回 canvas
// HEAD_TOP：头部窗口起点（占全身高的比例）；小海盗的海盗帽占顶部约 1/4，
// 窗口下移 0.22 才能露出面部（宝宝头部贴顶部，保持 0）
const HEAD_TOP = { haidao: 0.22 };
// 预渲染基础头像缓存：对局面板每 500ms 重建 DOM，避免反复对 4× 立绘做大降采样
const AVATAR_CACHE = new Map(); // "char_color_size" -> {cv}
export function avatarCanvas(charId, size = 64, colorIndex = 0) {
  const key = `${getChar(charId).id}_${colorIndex}_${size}`;
  let base = AVATAR_CACHE.get(key);
  if (!base) {
    base = { cv: document.createElement('canvas') };
    base.cv.width = base.cv.height = size;
    const bctx = base.cv.getContext('2d');
    const rec = charSprite(charId, colorIndex);
    const draw = () => {
      bctx.imageSmoothingQuality = 'high';
      const scale = size / (rec.img.height * 0.62); // 头部窗口高占全身 62%
      const w = rec.img.width * scale;
      const top = HEAD_TOP[getChar(charId).id] ?? 0;
      bctx.drawImage(rec.img, (size - w) / 2, -top * rec.img.height * scale, w, rec.img.height * scale);
    };
    if (rec.loaded) draw();
    else rec.img.addEventListener('load', draw, { once: true });
    AVATAR_CACHE.set(key, base);
  }
  const cv = document.createElement('canvas'); // 返回 1:1 拷贝：同一头像可被多处同时挂载
  cv.width = cv.height = size;
  cv.getContext('2d').drawImage(base.cv, 0, 0);
  return cv;
}

// 全身立绘（结算胜者/角色选择卡用）
export function portraitCanvas(charId, size = 72, colorIndex = 0) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  const rec = charSprite(charId, colorIndex);
  const draw = () => {
    ctx.clearRect(0, 0, size, size);
    const h = size * 0.96;
    const w = (rec.img.width / rec.img.height) * h;
    ctx.drawImage(rec.img, (size - w) / 2, size - h, w, h);
  };
  if (rec.loaded) draw();
  else rec.img.addEventListener('load', draw, { once: true });
  return cv;
}
