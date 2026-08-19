// 清理结果对比纯函数（浏览器 + Node 双兼容）。
(function (global) {
  /**
   * 将任意输入归一化为非负字节数。
   * @param {unknown} value 原始字节值。
   * @returns {number} 非负字节数。
   */
  function toBytes(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * 计算本次勾选清理项的扫描预估空间。
   * @param {Array<{id:string,sizeBytes?:number,error?:string}>} items 扫描结果项。
   * @param {string[]} ids 本次勾选的清理项 id。
   * @returns {number} 非负字节数。
   */
  function selectedEstimate(items, ids) {
    if (!Array.isArray(items) || !Array.isArray(ids) || ids.length === 0) return 0;
    const selected = new Set(ids);
    return items.reduce((sum, item) => {
      if (!item || item.error || !selected.has(item.id)) return sum;
      return sum + toBytes(item.sizeBytes);
    }, 0);
  }

  /**
   * 生成完成页的预估/实际差异说明。
   * @param {number} estimated 扫描预估字节数。
   * @param {number} actual 实际释放字节数。
   * @param {(n:number)=>string} formatBytes 字节格式化函数。
   * @returns {string} 可直接展示的差异文案。
   */
  function compareNote(estimated, actual, formatBytes) {
    const fmt = typeof formatBytes === 'function' ? formatBytes : String;
    estimated = toBytes(estimated);
    actual = toBytes(actual);
    const base = '实际释放按所选盘前后差值统计';
    if (estimated === 0 && actual === 0) return base;
    const diff = actual - estimated;
    if (diff === 0) return base + ' · 与扫描预估一致';
    return base + ' · 实际' + (diff > 0 ? '多释放 ' + fmt(diff) : '少释放 ' + fmt(-diff));
  }

  const api = { selectedEstimate, compareNote };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.dkcResult = api;
})(typeof window !== 'undefined' ? window : globalThis);
