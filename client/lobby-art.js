// 大厅界面美术：木纹边框、地图缩略图等全部用代码绘制（不用抠图）
// - applyLobbyTextures(): 生成无缝木纹贴图并以 CSS 变量 --ldb-wood 挂到 :root
// - drawMapThumb(canvas): 用对局同款贴图（floor/box/crate/cannon/mast.png）
//   拼绘「海盗14」地图缩略图，用作大厅房间卡片缩略图

// ---- 无缝木纹贴图 ----

function makeWoodTile(size = 192, plankH = 32) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d');

  // 每块木板：竖向渐变基色（略有深浅差异）
  for (let y = 0; y < size; y += plankH) {
    const shade = 0.92 + Math.random() * 0.16;
    const base = (l) => `rgb(${Math.round(150 * shade + l)}, ${Math.round(96 * shade + l * 0.7)}, ${Math.round(44 * shade + l * 0.4)})`;
    const grad = g.createLinearGradient(0, y, 0, y + plankH);
    grad.addColorStop(0, base(44));
    grad.addColorStop(0.35, base(14));
    grad.addColorStop(1, base(-16));
    g.fillStyle = grad;
    g.fillRect(0, y, size, plankH);
  }

  // 波浪木纹线条（x 方向三份平铺，保证横向无缝）
  for (let i = 0; i < 110; i++) {
    const y = Math.random() * size;
    const amp = 1 + Math.random() * 2.5;
    const dark = Math.random() < 0.6;
    g.strokeStyle = dark
      ? `rgba(88, 52, 16, ${0.05 + Math.random() * 0.1})`
      : `rgba(255, 214, 150, ${0.04 + Math.random() * 0.08})`;
    g.lineWidth = 0.6 + Math.random() * 1.4;
    const phase = Math.random() * Math.PI * 2;
    const freq = 0.02 + Math.random() * 0.05;
    for (const off of [-size, 0, size]) {
      g.beginPath();
      for (let x = 0; x <= size; x += 4) {
        const yy = y + Math.sin((x + phase * 100) * freq) * amp;
        if (x === 0) g.moveTo(off + x, yy);
        else g.lineTo(off + x, yy);
      }
      g.stroke();
    }
  }

  // 木节（避开左右边缘，防止接缝处被切开）
  const knots = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < knots; i++) {
    const kx = 20 + Math.random() * (size - 40);
    const ky = Math.random() * size;
    const kr = 3 + Math.random() * 4;
    for (let r = kr; r > 0; r -= 1) {
      g.strokeStyle = `rgba(80, 46, 14, ${0.18 + (kr - r) * 0.05})`;
      g.lineWidth = 0.8;
      g.beginPath();
      g.ellipse(kx, ky, r, r * 0.7, 0, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = 'rgba(64, 36, 10, 0.5)';
    g.beginPath();
    g.ellipse(kx, ky, 1.2, 0.9, 0, 0, Math.PI * 2);
    g.fill();
  }

  // 板缝：深色缝 + 下方一道高光（落在 plankH 整数倍上，纵向无缝）
  for (let y = 0; y < size; y += plankH) {
    g.fillStyle = 'rgba(60, 34, 10, 0.85)';
    g.fillRect(0, y, size, 2);
    g.fillStyle = 'rgba(255, 220, 160, 0.28)';
    g.fillRect(0, y + 2, size, 1);
  }

  return cv.toDataURL();
}

// ---- 绳索描边贴图（外框四角铆钉用不上，保持简单） ----

let applied = false;
export function applyLobbyTextures() {
  if (applied) return;
  applied = true;
  document.documentElement.style.setProperty('--ldb-wood', `url("${makeWoodTile()}")`);
}

// ---- 「海盗14」地图缩略图 ----
// 布局与 server/map.js 保持一致（逐格转录的正版截图布局）

const LAYOUT = [
  'oooo...o...oooo',
  'o#o..xx.xx..o#o',
  'oo.x.o.x.o.x.oo',
  'o.x.oooHooo.x.o',
  'o.xooooHoooox.o',
  'o.x.ooHHHoo.x.o',
  'o.xoooHHHooox.o',
  'oo.x.ooooo.x.oo',
  'ooo.xooooox.ooo',
  'oooo.x.o.x.oooo',
  'oo.oo.xxx.oo.oo',
  'o#.ooo...ooo.#o',
  'o..ooooooooo..o',
];

const TILE_NAMES = ['floor', 'box', 'crate', 'cannon', 'mast'];
const ASSET_V = '?v=sr4'; // 素材版本串（与 render.js 同步）
const tiles = {};
let tilesReady = false;
const pendingThumbs = new Set(); // 贴图未就绪时登记，加载完成后统一重绘

{
  let left = TILE_NAMES.length;
  for (const name of TILE_NAMES) {
    const img = new Image();
    img.onload = img.onerror = () => {
      left -= 1;
      if (left === 0) {
        tilesReady = true;
        for (const cv of pendingThumbs) if (cv.isConnected) renderThumb(cv);
        pendingThumbs.clear();
      }
    };
    img.src = `/assets/${name}.png${ASSET_V}`;
    tiles[name] = img;
  }
}

function renderThumb(cv) {
  const cols = LAYOUT[0].length;
  const rows = LAYOUT.length;
  const T = Math.floor(cv.width / cols); // 缩略图每格像素
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);

  // 先全铺地板，再逐行画障碍物：箱子贴图 40×48 底部阴影溢出格底，
  // 下一行（地板已铺完）的箱子盖住上一行溢出的阴影（同 render.js 的 2.5D 构图）
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (tilesReady && tiles.floor.complete) {
        g.drawImage(tiles.floor, x * T, y * T, T, T);
      } else {
        g.fillStyle = '#b98d35';
        g.fillRect(x * T, y * T, T, T);
      }
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ch = LAYOUT[y][x];
      if (ch === 'o') {
        if (tilesReady && tiles.box.complete) g.drawImage(tiles.box, x * T, y * T + T / 8, T, T * 1.2);
        else { g.fillStyle = '#d97706'; g.fillRect(x * T + 1, y * T + 1, T - 2, T - 2); }
      } else if (ch === 'x') {
        if (tilesReady && tiles.crate.complete) g.drawImage(tiles.crate, x * T, y * T + T / 8, T, T * 1.2);
        else { g.fillStyle = '#b45309'; g.fillRect(x * T + 1, y * T + 1, T - 2, T - 2); }
      } else if (ch === '#') { // 船炮：向上延伸一格（同 render.js）
        if (tilesReady && tiles.cannon.complete) g.drawImage(tiles.cannon, x * T, y * T - T + 1, T, T * 2);
        else { g.fillStyle = '#1f2937'; g.beginPath(); g.arc(x * T + T / 2, y * T + T / 2, T / 2 - 1, 0, Math.PI * 2); g.fill(); }
      }
    }
  }
  // 桅杆贴图锚点 cols 5..9 / rows 2..7（同 render.js）
  if (tilesReady && tiles.mast.complete) g.drawImage(tiles.mast, 5 * T, 2 * T, T * 5, T * 6);
}

// 把地图缩略图绘进给定 canvas；贴图未加载完时先画兜底色、加载完自动重绘
export function drawMapThumb(cv) {
  renderThumb(cv);
  if (!tilesReady) pendingThumbs.add(cv);
}
