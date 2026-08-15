const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PS_DIR = path.join(process.env.ProgramData || 'C:\\ProgramData', 'DiskCleanAgent', 'ps');

function b64json(obj) { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); }

// Embedded script conventions:
// - Script bodies must be pure ASCII (zero non-ASCII bytes). Non-ASCII data (e.g.
//   Chinese paths) travels via the base64-encoded JSON param, never in the script source.
// - Every script body must set `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`
//   as its first executable line (immediately after the `param(...)` line, if any).
//   PS 5.1 defaults to GBK on zh-CN systems, which corrupts Chinese paths/names in
//   stdout; forcing UTF-8 keeps stdout parseable.
function runPs(scriptName, scriptBody, params = {}, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    let file;
    try {
      fs.mkdirSync(PS_DIR, { recursive: true });
      file = path.join(PS_DIR, scriptName);
      fs.writeFileSync(file, scriptBody, 'utf8');
    } catch (e) { reject(e); return; }
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file];
    if (params.json !== undefined) args.push('-Json', params.json);
    execFile('powershell.exe', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code == null ? -1 : err.code) : 0,
        timedOut: err && err.killed,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

async function runJson(scriptName, scriptBody, params = {}, opts = {}) {
  const r = await runPs(scriptName, scriptBody, { json: b64json(params) }, opts);
  if (r.timedOut) return { ok: false, error: 'timeout', raw: r };
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || ('exit ' + r.code), raw: r };
  try {
    const lines = r.stdout.split(/\r?\n/).filter(l => l.trim());
    const data = lines.map(l => JSON.parse(l.trim()));
    return { ok: true, data, raw: r };
  } catch (e) { return { ok: false, error: 'bad json output: ' + e.message, raw: r }; }
}

const SYSINFO_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$disks = @()
Get-PSDrive -PSProvider FileSystem | ForEach-Object {
  $disks += @{ name = $_.Root; total = [double]$_.Free + [double]$_.Used; free = [double]$_.Free }
}
$p = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$mg = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid
$procs = (Get-Process | Select-Object -ExpandProperty Name) -join ','
Write-Output ('{"disks":' + (ConvertTo-Json -InputObject @($disks) -Compress) + ',"isAdmin":' + $isAdmin.ToString().ToLower() + ',"machineGuid":"' + $mg + '","procs":"' + $procs + '"}')
`;

// PS 5.1 管道会把单元素数组展开成裸对象（$disks | ConvertTo-Json），
// 导致单盘机器上 data.disks 不是数组。双保险：PS 端 @() 包裹 + JS 端归一化。
function normalizeDisks(disks) {
  return Array.isArray(disks) ? disks : (disks ? [disks] : []);
}

async function getSysInfo() {
  const r = await runJson('sysinfo.ps1', SYSINFO_PS, {}, { timeoutMs: 60000 });
  if (!r.ok) throw new Error('sysinfo failed: ' + r.error);
  const info = r.data[0];
  info.disks = normalizeDisks(info.disks);
  return info;
}

module.exports = { b64json, runPs, runJson, getSysInfo, normalizeDisks, PS_DIR };
