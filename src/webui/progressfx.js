// 进度视觉合成纯函数（浏览器 + Node 双兼容）。
// 语义：视觉进度向真实进度缓动；真实进度停住时缓慢爬升至 99% 封顶，
// 任务完成由调用方直接置 100%。条只前进不后退。
(function (global) {
  const MAX_PCT = 99;
  const CRAWL_PER_SEC = 0.4; // 真实进度停住时的爬升速率（%/秒）
  const EASE_RATE = 3; // 缓动速率（指数逼近，1-exp(-rate*dt)）

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function stepVisual(visual, target, dtSec) {
    visual = clamp(Number(visual) || 0, 0, MAX_PCT);
    target = clamp(Number(target) || 0, 0, MAX_PCT);
    dtSec = Math.max(0, Number(dtSec) || 0);
    if (target > visual) {
      visual += (target - visual) * (1 - Math.exp(-EASE_RATE * dtSec));
    } else if (visual < MAX_PCT) {
      visual = Math.min(MAX_PCT, visual + CRAWL_PER_SEC * dtSec);
    }
    return visual;
  }

  function nextQuip(list, idx) {
    if (!Array.isArray(list) || list.length === 0) return { text: '', idx: 0 };
    const i = Number.isInteger(idx) && idx >= 0 && idx < list.length ? idx : 0;
    return { text: list[i], idx: (i + 1) % list.length };
  }

  function fmtElapsed(ms) {
    const total = Math.floor((Number(ms) || 0) / 1000);
    if (total <= 0) return '00:00';
    const p = (n) => String(n).padStart(2, '0');
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }

  const api = { stepVisual, nextQuip, fmtElapsed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.dkcProgress = api;
})(typeof window !== 'undefined' ? window : globalThis);
