const SECURITY_SOFT = [
  { name: '火绒安全', procs: ['HipsDaemon', 'HipsTray', 'usysdiag', 'wsctrlsvc'],
    hint: '打开火绒 → 防护中心 → 临时关闭「文件实时防护」→ 回到本页点击重试。清理完成后再开启防护。' },
  { name: '360 安全卫士', procs: ['360Tray', '360Safe', 'ZhuDongFangYu'],
    hint: '打开 360 安全卫士 → 防护中心 → 临时关闭「文件防护」→ 回到本页点击重试。' },
  { name: '腾讯电脑管家', procs: ['QQPCRTP', 'QQPCTray'],
    hint: '打开腾讯电脑管家 → 病毒查杀 → 实时防护 → 临时关闭 → 回到本页点击重试。' },
  { name: '金山毒霸', procs: ['kxescore', 'kxetray'],
    hint: '打开金山毒霸 → 实时防护 → 临时关闭 → 回到本页点击重试。' },
  { name: 'Microsoft Defender', procs: ['MsMpEng'],
    hint: '系统自带 Defender 可能在扫描，等待片刻后重试；如仍失败可暂时关闭实时保护。' },
];

function classifyError({ code = 0, stderr = '', timedOut = false }) {
  const s = String(stderr || '').toLowerCase();
  if (timedOut) return 'timeout';
  if (code === 5 || s.includes('0x80070005') || s.includes('access is denied') || s.includes('denied') || s.includes('refused')) return 'access_denied';
  if (code === 32 || s.includes('0x80070020') || s.includes('being used') || s.includes('in use') || s.includes('lock')) return 'file_locked';
  return 'unknown';
}

function createDiagnose({ listProcs }) {
  async function diagnose(itemId, errorType) {
    const detected = [];
    let procs = [];
    try { procs = await listProcs(); } catch (e) { procs = []; }
    for (const soft of SECURITY_SOFT) {
      if (soft.procs.some(p => procs.includes(p))) detected.push({ name: soft.name, hint: soft.hint });
    }
    const relevant = errorType === 'access_denied' || errorType === 'file_locked';
    let suggestion;
    if (relevant && detected.length > 0) {
      const s = detected[0];
      suggestion = `检测到${s.name}正在运行，本项清理很可能被其文件防护拦截。建议：${s.hint}`;
    } else if (relevant) {
      suggestion = '文件可能被其他程序占用或权限不足。建议关闭相关程序后重试。';
    } else {
      suggestion = '清理未成功，请重试；若持续失败可跳过本项。';
    }
    return { errorType, detected, suggestion, retryable: relevant };
  }
  return { diagnose };
}

module.exports = { classifyError, createDiagnose, SECURITY_SOFT };
