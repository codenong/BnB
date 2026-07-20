// 经典地图「海盗14」：15×13 网格
// 布局按正版截图逐格转录（左右完全对称验证过）：
// 黄色木箱(o)与 X 纹木箱(x)棋盘式散布在木地板(.)上，均可炸毁；
// 四角 4 门船炮(#)、中央桅杆船首(H)不可破坏；正版无边界墙（出界即不可通行）。
// 出生点取截图中天然空格：顶部两个为截图实证出生位，其余按对称分布。

export const TILE = 40;   // 每格像素
export const COLS = 15;
export const ROWS = 13;

export const EMPTY = 0;
export const WALL = 1;    // 船炮（不可破坏）
export const SOFT = 2;    // 黄色木箱（可炸毁）
export const HOUSE = 3;   // 中央桅杆（不可破坏）
export const CRATE = 4;   // X 纹木箱（可炸毁）

export const isSoft = (t) => t === SOFT || t === CRATE;

// 逐格转录自正版截图（每行都是回文串 = 与原图左右对称一致）：
// o=黄色木箱 x=X纹木箱(均可炸) .=木地板 #=船炮 H=中央桅杆
// 注：(7,3) 旗顶尖在原版可穿行（贴图盖住角色=mask 效果），故为 '.' 而非 H
const LAYOUT = [
  'oooo...o...oooo',
  'o#o.xxx.xxx.o#o',
  'oo.x.o.x.o.x.oo',
  'o.x.ooo.ooo.x.o',
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

// 6 个出生点（地图内容不动，只选点）：均在天然通道末端，放泡后沿通道跑 3 格即脱险：
// (1,3)↔(1,6)、(2,11)↔(1,12) 互为逃生口袋，右侧镜像
export const SPAWNS = [
  [1, 6], [13, 6],
  [1, 3], [13, 3],
  [2, 11], [12, 11],
];

// 初始坐骑摆放：[x, y, 坐骑]，远离出生通道口的可达/孤岛位，180° 旋转成对
export const MOUNT_SPOTS = [
  [4, 0, 'turtle'], [10, 0, 'turtle'],
  [1, 5, 'owl'], [13, 5, 'owl'],
  [2, 12, 'pirateTurtle'], [12, 12, 'pirateTurtle'],
];

const CODES = { '.': EMPTY, '#': WALL, o: SOFT, H: HOUSE, x: CRATE };

export function buildMap() {
  return LAYOUT.flatMap((row, y) => {
    if (row.length !== COLS) throw new Error(`地图第 ${y} 行长度 ${row.length} 应为 ${COLS}`);
    return [[...row].map((ch) => CODES[ch] ?? EMPTY)];
  });
}

const CHARS = ['.', '#', 'o', 'H', 'x'];

// 序列化为字符串行，用于网络传输与客户端渲染
export function gridToRows(grid) {
  return grid.map((row) => row.map((t) => CHARS[t]).join(''));
}
