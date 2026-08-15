const { homedir } = require('node:os');

const SCAN_ENTRIES_PS = `
param([string]$Json)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$data = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json)) | ConvertFrom-Json
foreach($e in $data.entries){
  $sum=0L
  foreach($p in $e.paths){
    if(Test-Path -LiteralPath $p){
      $sum += (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    }
  }
  Write-Output ('{"id":"' + $e.id + '","size":' + $sum + '}')
}
`;

const SCAN_TOPLEVEL_PS = `
param([string]$Json)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$data = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json)) | ConvertFrom-Json
# NOTE: Get-ChildItem -Recurse is NOT used here. On zh-CN Windows 11 + PS 5.1 it
# silently returns zero items (and emits errors) when the tree contains junction
# dirs (e.g. C:\\Users\\<user>\\Application Data), which zeroes out whole top-level
# dir sizes. A manual .NET stack walk skipping reparse points is junction-safe.
$list = @()
Get-ChildItem -LiteralPath $data.disk -Force -Directory -ErrorAction SilentlyContinue |
  Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
  ForEach-Object {
    $sum = 0L
    $stack = New-Object System.Collections.Stack
    $stack.Push($_.FullName)
    while($stack.Count -gt 0){
      $cur = $stack.Pop()
      try {
        foreach($f in [IO.Directory]::GetFiles($cur)){
          $sum += ([IO.FileInfo]::new($f)).Length
        }
        foreach($d in [IO.Directory]::GetDirectories($cur)){
          $di = [IO.DirectoryInfo]::new($d)
          if($di.Attributes -band [IO.FileAttributes]::ReparsePoint){ continue }
          $stack.Push($d)
        }
      } catch {}
    }
    # pscustomobject (not hashtable): Sort-Object -Property on raw hashtables in
    # PS 5.1 fails to extract key values and falls back to object comparison,
    # producing a scrambled order instead of a numeric descending sort.
    $list += [pscustomobject]@{ path = $_.FullName; size = $sum }
  }
$top = $list | Sort-Object size -Descending | Select-Object -First 10
# -InputObject @($top): piping $top unrolls single-element collections to a
# scalar, which ConvertTo-Json then emits as {...} instead of [{...}].
Write-Output (ConvertTo-Json -InputObject @($top) -Compress)
`;

const SCAN_SPECIAL_PS = `
param([string]$Json)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$data = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json)) | ConvertFrom-Json
$rb = 0L
try {
  $sh = New-Object -ComObject Shell.Application
  foreach($item in $sh.Namespace(0xA).Items()){ $rb += $item.Size }
} catch {}
Write-Output ('{"id":"recycle_bin","size":' + $rb + '}')
Write-Output '{"id":"winsxs","size":0}'
Write-Output '{"id":"driver_store","size":0}'
`;

const H = homedir();
const LOCAL = process.env.LOCALAPPDATA || (H + '\\AppData\\Local');
const SYSD = (process.env.SystemDrive || 'C:') + '\\';

const ITEMS = [
  { id: 'user_temp', label: '用户临时文件', scope: 'user', risk: 'low', paths: [LOCAL + '\\Temp'] },
  { id: 'win_temp', label: '系统临时文件', scope: 'system', risk: 'low', paths: [SYSD + 'Windows\\Temp'] },
  { id: 'recycle_bin', label: '回收站（所有磁盘）', scope: 'user', risk: 'low', paths: [] },
  { id: 'thumb_cache', label: '缩略图缓存', scope: 'user', risk: 'low', paths: [LOCAL + '\\Microsoft\\Windows\\Explorer'] },
  { id: 'crash_dumps', label: '崩溃转储', scope: 'user', risk: 'low', paths: [LOCAL + '\\CrashDumps', SYSD + 'Windows\\Minidump'] },
  { id: 'wu_cache', label: 'Windows 更新缓存', scope: 'system', risk: 'low', paths: [SYSD + 'Windows\\SoftwareDistribution\\Download'] },
  { id: 'inet_cache', label: '网络缓存', scope: 'user', risk: 'low', paths: [LOCAL + '\\Microsoft\\Windows\\INetCache'] },
  { id: 'pip_npm_cache', label: '包管理器缓存', scope: 'user', risk: 'low', paths: [LOCAL + '\\pip\\cache', LOCAL + '\\npm-cache'] },
  { id: 'd3d_cache', label: 'D3D 着色器缓存', scope: 'user', risk: 'low', paths: [LOCAL + '\\D3DSCache'] },
  { id: 'nvidia_shader', label: 'NVIDIA 着色器缓存', scope: 'user', risk: 'medium', paths: [LOCAL + '\\NVIDIA\\DXCache', LOCAL + '\\NVIDIA\\GLCache'] },
  { id: 'nvidia_driver', label: 'NVIDIA 驱动更新缓存', scope: 'system', risk: 'medium',
    paths: [process.env.ProgramData + '\\NVIDIA Corporation\\NVIDIA app\\UpdateFramework', process.env.ProgramData + '\\NVIDIA Corporation\\Downloader'] },
  { id: 'edge_cache', label: 'Edge 浏览器缓存', scope: 'user', risk: 'medium', paths: [LOCAL + '\\Microsoft\\Edge\\User Data\\Default\\Cache'] },
  { id: 'chrome_cache', label: 'Chrome 浏览器缓存', scope: 'user', risk: 'medium', paths: [LOCAL + '\\Google\\Chrome\\User Data\\Default\\Cache'] },
  { id: 'prefetch', label: '预读取文件', scope: 'system', risk: 'medium', paths: [SYSD + 'Windows\\Prefetch'] },
  { id: 'winsxs', label: 'WinSxS 组件清理', scope: 'system', risk: 'high', paths: [] },
  { id: 'hibernation', label: '休眠文件', scope: 'system', risk: 'high', paths: [SYSD + 'hiberfil.sys'] },
  { id: 'driver_store', label: '过期驱动包', scope: 'system', risk: 'high', paths: [] },
];

function createScanner({ psutil }) {
  async function scanAll(disk, onItem, onPhase) {
    // 'C:' without a trailing backslash is the drive-relative current directory
    // (usually C:\Windows\system32), not the drive root. Normalize to 'C:\'.
    disk = /^[A-Za-z]:$/.test(disk) ? disk + '\\' : disk;
    const items = [];
    const scanable = ITEMS.filter(i => i.paths.length > 0);
    // 分批并发 4 个（避免一次性拉起 15 个 PowerShell 进程）
    const batchSize = 4;
    for (let i = 0; i < scanable.length; i += batchSize) {
      const batch = scanable.slice(i, i + batchSize);
      if (onPhase) onPhase({ phase: 'items', labels: batch.map(b => b.label) });
      await Promise.all(batch.map(async (def) => {
        const r = await psutil.runJson('scan_entries.ps1', SCAN_ENTRIES_PS, { entries: [def] });
        let item;
        if (r.ok && r.data[0]) {
          item = { id: def.id, label: def.label, scope: def.scope, risk: def.risk, sizeBytes: r.data[0].size };
        } else {
          item = { id: def.id, label: def.label, scope: def.scope, risk: def.risk, sizeBytes: 0, error: r.error || 'scan failed' };
        }
        items.push(item);
        onItem(item);
      }));
    }
    // 空间分布（所选盘，独立）
    if (onPhase) onPhase({ phase: 'space' });
    const rTop = await psutil.runJson('scan_toplevel.ps1', SCAN_TOPLEVEL_PS, { disk });
    const spaceDist = (rTop.ok && Array.isArray(rTop.data[0])) ? rTop.data[0] : [];
    // 特殊项：回收站 / WinSxS / driver_store 用轻量统计（预估）
    if (onPhase) onPhase({ phase: 'special' });
    const special = await scanSpecial(psutil, disk);
    for (const s of special) { items.push(s); onItem(s); }
    return { items, spaceDist, disk };
  }

  async function scanSpecial(psutil, disk) {
    const out = [];
    const r = await psutil.runJson('scan_special.ps1', SCAN_SPECIAL_PS, { disk });
    if (r.ok && r.data.length) {
      for (const d of r.data) {
        const def = ITEMS.find(i => i.id === d.id);
        if (def) out.push({ id: def.id, label: def.label, scope: def.scope, risk: def.risk, sizeBytes: d.size, error: d.error });
      }
    }
    for (const def of ITEMS.filter(i => i.paths.length === 0 && !out.some(o => o.id === i.id))) {
      out.push({ id: def.id, label: def.label, scope: def.scope, risk: def.risk, sizeBytes: 0, error: 'unavailable' });
    }
    return out;
  }

  return { scanAll, getItems: () => ITEMS, ps: { SCAN_ENTRIES_PS, SCAN_TOPLEVEL_PS, SCAN_SPECIAL_PS } };
}

module.exports = { createScanner, ITEMS, SCAN_ENTRIES_PS, SCAN_TOPLEVEL_PS, SCAN_SPECIAL_PS };
