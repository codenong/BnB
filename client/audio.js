// 全局统一音频管理：BGM 单轨（同刻仅一首）+ 音效池 + 首次手势解锁 + 持久化静音
// 用法：import { audio } from '/audio.js'
//   audio.playScene('login' | 'lobby' | 'game' | null)  —— 切场景背景乐（null 停止）
//   audio.sfx('explode', 0.5)                           —— 放音效（复用缓存的 Audio，打断重播）
//   audio.toggleMuted() / audio.muted                   —— 全局静音（localStorage 持久化）
//   audio.onMuteChange(cb)                              —— 静音状态变化（给 ♪ 按钮同步 UI）

// 场景 → 背景乐（音量各自约定，切换时单曲循环接管）
const SCENES = {
  login: { src: '/assets/snd/登录_login.mp3', vol: 0.32 },
  lobby: { src: '/assets/snd/游戏大厅_lobby_scene.mp3', vol: 0.35 },
  game:  { src: '/assets/snd/海盗船_patrit.mp3', vol: 0.25 },
};

const MUTE_KEY = 'bnb.muted';

class AudioManager {
  constructor() {
    this._tracks = new Map(); // scene -> HTMLAudioElement
    this._sfxPool = new Map(); // name -> HTMLAudioElement
    this._scene = null;        // 当前场景名
    this._muted = localStorage.getItem(MUTE_KEY) === '1';
    this._muteCbs = new Set();
    this._playCbs = new Set(); // 首次 BGM 真正开播（自动播放解锁）时通知
    this._played = false;
    this._unlockBound = false;
    this._bindUnlock();
  }

  get muted() { return this._muted; }
  get scene() { return this._scene; }

  onMuteChange(cb) { this._muteCbs.add(cb); return () => this._muteCbs.delete(cb); }

  // BGM 首次实际开始播放时回调（已开播的立即补调）——首页“点我开音乐”提示据此隐藏
  onPlaying(cb) {
    this._playCbs.add(cb);
    if (this._played) cb();
    return () => this._playCbs.delete(cb);
  }

  toggleMuted() {
    this._muted = !this._muted;
    localStorage.setItem(MUTE_KEY, this._muted ? '1' : '0');
    if (this._muted) {
      for (const t of this._tracks.values()) t.pause();
    } else {
      this._playCurrent();
    }
    for (const cb of this._muteCbs) cb(this._muted);
    return this._muted;
  }

  // 切换 BGM：同场景不重复起播；旧曲目立即停掉，保证单轨
  playScene(name) {
    if (name === this._scene) { this._playCurrent(); return; }
    if (this._scene) {
      const prev = this._tracks.get(this._scene);
      if (prev) { prev.pause(); prev.currentTime = 0; }
    }
    this._scene = name;
    if (name) this._playCurrent();
  }

  // 音效：name 不含斜杠 → /assets/snd/<name>.wav；含斜杠 → /assets/<name>.wav（如 snd/victory）；
  //       自带扩展名（如 snd/role_die.mp3）→ /assets/<name> 原样使用
  sfx(name, vol = 0.5) {
    if (this._muted) return;
    try {
      let a = this._sfxPool.get(name);
      if (!a) {
        const src = /\.\w{2,4}$/.test(name) ? `/assets/${name}`
          : name.includes('/') ? `/assets/${name}.wav` : `/assets/snd/${name}.wav`;
        a = new Audio(src);
        this._sfxPool.set(name, a);
      }
      a.volume = vol;
      a.currentTime = 0;
      a.play().catch(() => {});
    } catch { /* 无声音环境忽略 */ }
  }

  // ---- 内部 ----

  _track(scene) {
    let t = this._tracks.get(scene);
    if (!t) {
      const def = SCENES[scene];
      if (!def) return null;
      t = new Audio(encodeURI(def.src));
      t.loop = true;
      t.volume = def.vol;
      t.addEventListener('playing', () => {
        if (this._played) return;
        this._played = true;
        for (const cb of this._playCbs) cb();
      });
      this._tracks.set(scene, t);
    }
    return t;
  }

  _playCurrent() {
    if (this._muted || !this._scene) return;
    const t = this._track(this._scene);
    if (t?.paused) t.play().catch(() => {}); // 被自动播放策略拦截时，等首次手势补播
  }

  // 浏览器自动播放限制：首次用户手势时补播当前场景乐
  _bindUnlock() {
    if (this._unlockBound) return;
    this._unlockBound = true;
    const unlock = () => this._playCurrent();
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      document.addEventListener(ev, unlock, { passive: true });
    }
  }
}

export const audio = new AudioManager();

// 兼容旧入口：首页 ♪ 按钮等可直接同步
window.__audio = audio;
