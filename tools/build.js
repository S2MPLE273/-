// 流水线：master.key → webui-inline.js → esbuild bundle → SEA blob → 复制 node.exe → postject → keygen.html 成品
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { inject } = require('postject');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MASTER_KEY_FILE = path.join(__dirname, 'master.key');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function ensureMasterKey() {
  if (!fs.existsSync(MASTER_KEY_FILE)) {
    fs.writeFileSync(MASTER_KEY_FILE, crypto.randomBytes(32).toString('hex'));
    console.log('generated tools/master.key (keep it safe & secret)');
    console.log('********************************************************************');
    console.log('* 已生成新的主密钥——若此前已分发过 exe 或 keygen.html，旧密钥将全部失效；');
    console.log('* 请重新构建并重新分发两个产物。');
    console.log('********************************************************************');
  }
  const key = fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('tools/master.key invalid: must be 64 hex chars');
  return key.toLowerCase();
}

/**
 * Generates the inline web UI module used by packaged builds.
 * @returns {void}
 */
function buildWebuiInline() {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'src', 'webui', f), 'utf8');
  const fx = read('progressfx.js') + '\n' + read('resultfx.js');
  const js = `module.exports = ${JSON.stringify({ html: read('index.html'), css: read('style.css'), fx, js: read('app.js') })};\n`;
  fs.writeFileSync(path.join(ROOT, 'src', 'webui-inline.js'), js);
}

function buildKeygen(masterKey) {
  const tpl = fs.readFileSync(path.join(__dirname, 'keygen.template.html'), 'utf8');
  const count = (tpl.match(/__MASTER_KEY__/g) || []).length;
  if (count !== 1) throw new Error('keygen.template.html must contain exactly one __MASTER_KEY__ placeholder, found ' + count);
  fs.writeFileSync(path.join(DIST, 'keygen.html'), tpl.replace('__MASTER_KEY__', masterKey));
}

function assertBundleSafety(bundle, masterKey) {
  // 正向断言：产物必须实际包含主密钥；同时禁止残留 sentinel 或公开 dev 密钥（否则注入失败时静默走回退）
  if (bundle.includes('__MASTER_KEY__')) throw new Error('bundle contains __MASTER_KEY__ sentinel — esbuild define failed');
  if (!bundle.includes(JSON.stringify(masterKey))) throw new Error('bundle does not contain the master key — injection failed');
  const devKey64 = 'a'.repeat(64);
  if (bundle.includes(devKey64)) throw new Error('bundle contains the public dev key — refusing to ship DRM-defeated build');
}

function verifyFuseFlipped(exePath) {
  // node.exe 内嵌 "NODE_SEA_FUSE_...:0"；postject 将末字符翻为 ":1" 表示已注入 blob（ASCII 编码，实测确认）。
  // 必须正向断言 ":1" 存在——若 fuse 未翻转，该 exe 会当作普通 node 启动（无脚本，静默退出），产出废品。
  const buf = fs.readFileSync(exePath);
  if (!buf.includes(Buffer.from(SENTINEL + ':1'))) throw new Error('SEA fuse not flipped in ' + exePath + ' — postject --sentinel-fuse failed');
}

async function main() {
  const masterKey = ensureMasterKey();
  fs.mkdirSync(DIST, { recursive: true });
  buildWebuiInline();
  buildKeygen(masterKey);

  // 用 esbuild JS API 而非 CLI：define 值经 JSON.stringify 加引号，避免 shell 层剥离引号后
  // hex 主密钥被 esbuild 当作标识符（typeof <未声明标识符> === 'undefined' → 打包版静默走空密钥
  // → SEA 模式 FATAL 退出。实测 CLI + shell:true 在 Windows 上会触发此陷阱）
  const bundleOut = path.join(DIST, 'bundle.cjs');
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundleOut,
    define: { __MASTER_KEY__: JSON.stringify(masterKey) },
  });

  const bundle = fs.readFileSync(bundleOut, 'utf8');
  assertBundleSafety(bundle, masterKey);

  const seaConfig = {
    main: path.join(DIST, 'bundle.cjs'),
    output: path.join(DIST, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
  };
  fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(seaConfig));
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')], { cwd: ROOT, stdio: 'inherit' });

  const exeOut = path.join(DIST, 'DiskCleanAgent.exe');
  fs.copyFileSync(process.execPath, exeOut);
  // 直接调用 postject API 注入资源，避免 CLI 参数和 shell 路径差异。
  const blob = fs.readFileSync(path.join(DIST, 'sea-prep.blob'));
  await inject(exeOut, 'NODE_SEA_BLOB', blob, { sentinelFuse: SENTINEL });
  verifyFuseFlipped(exeOut);
  console.log('built: ' + exeOut);
  console.log('keygen: ' + path.join(DIST, 'keygen.html'));
  console.log('master key fingerprint (exe/keygen): ' + masterKey.slice(0, 8));
}

main().catch((e) => { console.error(e); process.exit(1); });
