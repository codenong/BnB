// WebSocket 消息类型约定（客户端使用相同的字符串字面量）

// 客户端 → 服务端
export const C = {
  HELLO: 'hello',          // {t, name} 登录（只需名字）
  CREATE_ROOM: 'createRoom',
  JOIN_ROOM: 'joinRoom',   // {t, roomId}
  SPECTATE_ROOM: 'spectateRoom', // {t, roomId} 纯观战：不占玩家位、不用选角色，能看到房间和对局的完整广播
  LEAVE_ROOM: 'leaveRoom',
  READY: 'ready',          // {t, ready}
  SELECT_CHAR: 'selectChar', // {t, char} 房间内选择角色
  CHAT: 'chat',          // {t, text} 房间内聊天
  START: 'start',          // 仅房主
  INPUT: 'input',          // {t, dir: ['up'|'down'|'left'|'right'...]} 当前按住的方向（按下的先后顺序）
  PLACE_BOMB: 'placeBomb', // 空格：放水泡；自己有未爆遥控泡时改为引爆
  USE_ITEM: 'useItem',     // Ctrl/Shift 使用主动道具：被困时针自救，否则放遥控水泡
};

// 服务端 → 客户端
export const S = {
  WELCOME: 'welcome',      // {t, id, name}
  LOBBY: 'lobby',          // {t, rooms: [{id, name, players, max, inGame}]}
  ROOM: 'room',            // {t, room: {id, name, hostId, inGame, players: [{id, name, ready, isBot, char, colorIndex}]}}
  CHAT: 'chat',            // {t, id, name, text, colorIndex} 房间聊天广播
  GAME_START: 'gameStart', // {t, map, players, yourId, tileSize}
  STATE: 'state',          // {t, tick, warmup, players, bombs, expl, items, grid?} 30Hz 快照（warmup>0 时为 321 冻结倒计时）；
                           // players 只含动态字段（name/char/isBot/colorIndex 见 gameStart），grid 仅在地图变化时携带
  GAME_OVER: 'gameOver',   // {t, winnerId, winnerName}
  ERROR: 'error',          // {t, msg}
};
