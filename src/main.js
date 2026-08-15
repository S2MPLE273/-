const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { createServer } = require('./server');
const { createLicense } = require('./license');
const { createScanner } = require('./scanner');
const { createCleaner } = require('./cleaner');
const { createDiagnose } = require('./diagnose');
const psutil = require('./psutil');

let isSea = false;
try { isSea = require('node:sea').isSea(); } catch (e) {}

// 构建期由 esbuild define 替换（开发期未定义时走环境变量兜底）
const MASTER_KEY = typeof __MASTER_KEY__ !== 'undefined' ? __MASTER_KEY__ : '';

function resolveMasterKey() {
  if (MASTER_KEY && MASTER_KEY.length === 64 && /^[0-9a-f]{64}$/i.test(MASTER_KEY)) return MASTER_KEY.toLowerCase();
  if (isSea) { console.error('FATAL: master key not injected in packaged build'); process.exit(1); }
  return process.env.DKC_MASTER_KEY || 'a'.repeat(64);
}

const STATE_FILE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'DiskCleanAgent', 'license.dat');

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { entries: {} }; } }
function saveState(s) { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) {} }

async function relaunchAsAdmin() {
  const exe = process.execPath;
  const extra = isSea ? '' : (" -ArgumentList '" + path.resolve(process.argv[1]).replace(/'/g, "''") + "'");
  const script = `Start-Process -FilePath '${exe.replace(/'/g, "''")}'${extra} -Verb RunAs`;
  await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, (err) => {
    if (err) { console.error('UAC relaunch failed: ' + err.message); process.exit(1); }
    resolve();
  }));
  process.exit(0);
}

function openBrowser(url) {
  execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
}

async function startWithPort(port, token, deps, webui) {
  return new Promise((resolve, reject) => {
    const srv = createServer({ port, token, webui, ...deps });
    srv.once('error', reject);
    srv.once('listening', () => {
      srv.removeListener('error', reject);
      resolve(srv);
    });
  });
}

async function main() {
  if (process.platform !== 'win32') { console.error('Windows only'); process.exit(1); }
  const info = await psutil.getSysInfo();
  if (!info.isAdmin) return relaunchAsAdmin();

  const token = crypto.randomBytes(12).toString('hex');
  const masterKey = resolveMasterKey();
  const license = createLicense({ masterKey });
  const diagnose = createDiagnose({ listProcs: async () => { try { return (await psutil.getSysInfo()).procs.split(','); } catch (e) { return []; } } });
  const scanner = createScanner({ psutil });
  const cleaner = createCleaner({ psutil, diagnose });
  const deps = {
    license, scanner, cleaner, psutil,
    machineGuid: info.machineGuid, loadState, saveState,
    masterKey,
    version: require('../package.json').version,
    removeState: () => { try { fs.unlinkSync(STATE_FILE); } catch (e) {} },
  };

  let webui;
  try { webui = require('./webui-inline'); } catch (e) { webui = { html: '', css: '', js: '' }; }
  try {
    if (fs.existsSync(path.join(__dirname, 'webui', 'index.html'))) {
      webui = { html: fs.readFileSync(path.join(__dirname, 'webui/index.html'), 'utf8'), css: fs.readFileSync(path.join(__dirname, 'webui/style.css'), 'utf8'), js: fs.readFileSync(path.join(__dirname, 'webui/app.js'), 'utf8') };
    }
  } catch (e) {}

  let srv = null;
  const base = 20000 + Math.floor(Math.random() * 20000);
  for (let attempt = 0; attempt < 5 && !srv; attempt++) {
    const port = base + attempt * 7;
    try { srv = await startWithPort(port, token, deps, webui); }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  if (!srv) throw new Error('no free port found');

  let lastActivity = Date.now();
  let inFlight = 0;
  srv.on('request', () => { lastActivity = Date.now(); });
  srv.on('request', (req, res) => {
    inFlight++;
    let done = false; // 'close' 与 'finish' 可能都触发，once 守卫防止重复递减
    res.on('close', () => { if (!done) { done = true; inFlight--; } });
  });
  // 清理任务（DISM 最长 30 分钟）期间无新请求但仍有在途响应，不得退出
  setInterval(() => { if (inFlight === 0 && Date.now() - lastActivity > 10 * 60 * 1000) process.exit(0); }, 60 * 1000);

  openBrowser(`http://127.0.0.1:${srv.address().port}/?token=${token}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
