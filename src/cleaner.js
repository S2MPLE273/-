// src/cleaner.js
const { homedir } = require('node:os');
const { ITEMS } = require('./scanner');
const { classifyError } = require('./diagnose');

const CLEAN_ENTRIES_PS = `
param([string]$Json)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$data = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json)) | ConvertFrom-Json
$out = @()
foreach($e in $data.entries){
  $before = (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -eq $data.disk } | Select-Object -First 1).Free
  $err = ''
  $ok = $true
  try {
    switch($e.kind){
      'dir' {
        foreach($p in $e.paths){
          if(Test-Path -LiteralPath $p){
            if($e.filters){
              Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like $e.filters } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            } else {
              Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            }
          }
        }
      }
      'recycle' { Clear-RecycleBin -Force -ErrorAction Stop }
      'dism' {
        [Console]::OutputEncoding = [Text.Encoding]::Default
        $r = Dism.exe /Online /Cleanup-Image /StartComponentCleanup 2>&1
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        if($LASTEXITCODE -ne 0){ $ok=$false; $err = ($r -join ' | ').Substring(0,[Math]::Min(500,($r -join ' | ').Length)) }
      }
      'hiber' {
        [Console]::OutputEncoding = [Text.Encoding]::Default
        $r = powercfg /h off 2>&1
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        if($LASTEXITCODE -ne 0){ $ok=$false; $err = (($r | Out-String).Trim()).Substring(0,[Math]::Min(300,(($r | Out-String).Trim()).Length)) }
      }
    }
  } catch { $ok=$false; $err=$_.Exception.Message }
  $after = (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -eq $data.disk } | Select-Object -First 1).Free
  $freed = 0L
  if($before -and $after){ $freed = [long]($after - $before); if($freed -lt 0){ $freed = 0 } }
  $out += ('{"id":"' + $e.id + '","ok":' + $ok.ToString().ToLower() + ',"freed":' + $freed + ',"error":"' + ($err -replace '"','\\"') + '"}')
}
Write-Output ($out -join "\`n")
`;

// PS single-quoted strings treat backslash literally, so '%LOCALAPPDATA%' would NOT
// expand in Test-Path. Compute the path in JS like scanner.js does.
const LOCAL = process.env.LOCALAPPDATA || (homedir() + '\\AppData\\Local');

// 特殊清理方式映射；其余有路径的项走通用 'dir' 清理（删除目录内子项，保留目录本身）
const KINDS = {
  winsxs: { kind: 'dism', paths: [] },
  hibernation: { kind: 'hiber', paths: [] },
  recycle_bin: { kind: 'recycle', paths: [] },
  thumb_cache: { kind: 'dir', paths: [LOCAL + '\\Microsoft\\Windows\\Explorer'], filters: 'thumbcache_*.db' },
};

function createCleaner({ psutil, diagnose }) {
  async function cleanOne(kind, id, paths, filters, disk) {
    const r = await psutil.runJson('clean_entries.ps1', CLEAN_ENTRIES_PS, { disk, entries: [{ id, kind, paths, filters }] }, { timeoutMs: 1800000 });
    if (r.ok && Array.isArray(r.data)) {
      const e = r.data.find(d => d.id === id);
      if (e) return e;
    }
    return { id, ok: false, freed: 0, error: r.error || 'clean failed' };
  }

  async function clean({ disk, items }, onProgress, { retryDelayMs = 2000 } = {}) {
    // Get-PSDrive 的 Root 是 'C:\' 形式，'C:' 匹配不到任何盘，全部条目会静默返回 ok:true freed:0
    disk = /^[A-Za-z]:$/.test(disk) ? disk + '\\' : disk;
    const results = [];
    let freedTotal = 0;
    // 串行执行（避免多 PowerShell 同时删文件造成磁盘争用），失败自动重试一次，再失败走诊断
    for (const id of items) {
      const def = ITEMS.find(i => i.id === id);
      if (!def) continue;
      // pnputil 驱动清理风险高，首版不做（见设计文档 5.2 high 项）
      if (id === 'driver_store') {
        const r = { id, ok: false, freed: 0, error: '此版本暂不支持清理过期驱动包' };
        results.push(r);
        onProgress(r);
        continue;
      }
      const spec = KINDS[id] || { kind: 'dir', paths: def.paths, filters: null };
      let r = await cleanOne(spec.kind, id, spec.paths, spec.filters, disk);
      if (!r.ok) {
        await new Promise(res => setTimeout(res, retryDelayMs));
        r = await cleanOne(spec.kind, id, spec.paths, spec.filters, disk);
      }
      if (!r.ok && diagnose) {
        const et = classifyError({ code: 0, stderr: r.error, timedOut: r.error === 'timeout' });
        r.diagnosis = await diagnose.diagnose(id, et);
      }
      freedTotal += r.freed || 0;
      results.push(r);
      onProgress(r);
    }
    return { results, freedTotal };
  }

  return { clean, _psutil: psutil };
}

module.exports = { createCleaner, CLEAN_ENTRIES_PS };
