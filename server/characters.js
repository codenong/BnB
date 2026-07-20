// 角色设定：盛大泡泡堂原版角色（拥有 4 向行走序列帧的两名基本角色）
// 客户端 client/characters.js 保存同一份数据的展示副本
//
// 官方口径存档（百度百科角色词条"初始值/上限值"体系；盛大官网只公布性格描述、无数值表）：
//   宝宝：初始 泡1/威1/速5 → 极限 泡6/威7/速10（"唯一速度满值"口径）
//   小海盗（官方名"海盗船长" Lodumani，原版隐藏角色）：初始 泡3/威3/速6 → 极限 泡9/威7/速9
// 原口径下小海盗早/后期全方位压制宝宝（原版它是随机摇出的隐藏角色，不讲究平衡），
// 现调整为双人对决平衡版（官方为锚，早期对收、后期留分工）：
//   宝宝（速度型）：初始 泡1/威1/速6 → 极限 泡6/威7/速10
//   小海盗（爆破型）：初始 泡1/威2/速5 → 极限 泡8/威7/速9
//   早期威力/水泡：海盗威 2 换宝宝速 1 级——泡数持平（各 1），因为早期泡+1 ≈ 开箱
//   效率翻倍（可并发双泡加速道具获取、滚雪球），是三项早期增益里最强一档，只给
//   海盗留威力上较小且不同质的优势（爆炸十字碰箱即止，威 2 主要利于隔箱安全放泡）
//   后期宝宝极速快 1 级（10>9）、小海盗多 2 泡（8>6），威力同 7
// 游戏内换算：速度 1 级 = 24 px/s（与鞋子 +24 一致）；威力=格数、水泡=个数

export const CHARACTERS = [
  {
    id: 'baobao', name: '宝宝', desc: '速度',
    speed: 144, range: 1, bombs: 1,
    caps: { speed: 240, range: 7, bombs: 6 },
  },
  {
    id: 'haidao', name: '小海盗', desc: '爆破',
    speed: 120, range: 2, bombs: 1,
    caps: { speed: 216, range: 7, bombs: 8 },
  },
];

export const DEFAULT_CHAR = 'baobao';

export function getChar(id) {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}

export function isValidChar(id) {
  return CHARACTERS.some((c) => c.id === id);
}
