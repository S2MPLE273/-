const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PS_DIR = path.join(process.env.ProgramData || 'C:\\ProgramData', 'DiskCleanAgent', 'ps');

function b64json(obj) { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); }

function runPs(scriptName, scriptBody, params = {}, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    fs.mkdirSync(PS_DIR, { recursive: true });
    const file = path.join(PS_DIR, scriptName);
    fs.writeFileSync(file, scriptBody, 'utf8');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file];
    if (params.json !== undefined) args.push('-Json', params.json);
    execFile('powershell.exe', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code === undefined ? -1 : err.code) : 0,
        timedOut: err && err.killed,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function runJson(scriptName, scriptBody, params = {}, opts = {}) {
  return new Promise(async (resolve) => {
    const r = await runPs(scriptName, scriptBody, { json: b64json(params) }, opts);
    if (r.code !== 0) return resolve({ ok: false, error: r.stderr.trim() || ('exit ' + r.code), raw: r });
    try {
      const lines = r.stdout.split(/\r?\n/).filter(l => l.trim());
      const data = lines.map(l => JSON.parse(l.trim()));
      resolve({ ok: true, data, raw: r });
    } catch (e) { resolve({ ok: false, error: 'bad json output: ' + e.message, raw: r }); }
  });
}

const SYSINFO_PS = `
$ErrorActionPreference='SilentlyContinue'
$disks = @()
Get-PSDrive -PSProvider FileSystem | ForEach-Object {
  $disks += @{ name = $_.Root; total = [double]$_.Free + [double]$_.Used; free = [double]$_.Free }
}
$p = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$mg = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid
$procs = (Get-Process | Select-Object -ExpandProperty Name) -join ','
Write-Output ('{"disks":' + ($disks | ConvertTo-Json -Compress) + ',"isAdmin":' + $isAdmin.ToString().ToLower() + ',"machineGuid":"' + $mg + '","procs":"' + $procs + '"}')
`;

async function getSysInfo() {
  const r = await runJson('sysinfo.ps1', SYSINFO_PS, {}, { timeoutMs: 60000 });
  if (!r.ok) throw new Error('sysinfo failed: ' + r.error);
  return r.data[0];
}

module.exports = { b64json, runPs, runJson, getSysInfo, PS_DIR };
