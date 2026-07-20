// 坐骑属性表（对齐盛大版）：骑上后由坐骑决定移动速度，替代角色自身速度；
// 被火焰炸中时坐骑挡一命（坐骑消失，人短暂无敌），再次被炸才会被困。
// 飞碟（UFO）可飞越场内障碍，但骑乘时捡不到任何道具。

export const MOUNTS = {
  turtle:       { id: 'turtle',       name: '绿乌龟', speed: 84,  fly: false }, // 最慢，多数是坑
  owl:          { id: 'owl',          name: '猫头鹰', speed: 156, fly: false }, // 中速
  pirateTurtle: { id: 'pirateTurtle', name: '海盗龟', speed: 204, fly: false }, // 飞快
  ufo:          { id: 'ufo',          name: '飞碟',   speed: 180, fly: true  }, // 飞越障碍，不能捡道具
};
