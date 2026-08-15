const http = require('node:http');
const crypto = require('node:crypto');

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function createServer({ port, token, webui, license, scanner, cleaner, psutil, machineGuid = 'unknown', loadState, saveState, masterKey = '', removeState, version = '0.0.0' }) {
  const tasks = new Map();

  masterKey = (masterKey || '').toLowerCase();

  function isAdminReq(req) {
    const h = String(req.headers['x-admin-key'] || '');
    if (!masterKey || h.length !== 64 || !/^[0-9a-f]{64}$/i.test(h)) return false;
    try { return crypto.timingSafeEqual(Buffer.from(h.toLowerCase(), 'hex'), Buffer.from(masterKey, 'hex')); }
    catch (e) { return false; }
  }

  function isValidDisk(disk) {
    return typeof disk === 'string' && /^[A-Za-z]:\\?$/.test(disk);
  }

  async function runClean(body) {
    const disk = (body && body.disk) || (process.env.SystemDrive || 'C:') + '\\';
    if (!isValidDisk(disk)) return { status: 400, body: { ok: false, error: 'invalid disk' } };
    const items = (body && body.items) || [];
    const known = new Set(scanner.getItems(disk).map(i => i.id));
    if (!Array.isArray(items) || !items.length || !items.every(id => known.has(id))) return { status: 400, body: { ok: false, error: 'invalid item id' } };
    try { const r = await cleaner.clean({ disk, items }, () => {}); return { status: 200, body: { ok: true, data: r } }; }
    catch (e) { return { status: 500, body: { ok: false, error: e.message } }; }
  }

  function verifyKey(key) {
    const state = loadState ? (loadState() || { entries: {} }) : { entries: {} };
    state.save = () => { if (saveState) saveState(state); };
    return license.verify(key, { now: Date.now, machineGuid, state });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') !== token) return json(res, 403, { ok: false, error: 'forbidden' });
    const p = url.pathname;
    const body = await readBody(req);
    if (body && body.overflow) return json(res, 413, { ok: false, error: 'body too large' });
    if (body && body.badJson) return json(res, 400, { ok: false, error: 'invalid json' });

    if (req.method === 'GET' && p === '/') {
      const html = webui.html
        .replace('</head>', '<style>' + webui.css + '</style></head>')
        .replace('</body>', '<script>' + webui.js + '</script></body>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && p === '/api/overview') {
      try { const info = await psutil.getSysInfo(); return json(res, 200, { ok: true, data: info }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && p === '/api/scan') {
      const disk = (body && body.disk) || (process.env.SystemDrive || 'C:') + '\\';
      if (!isValidDisk(disk)) return json(res, 400, { ok: false, error: 'invalid disk' });
      const taskId = Math.random().toString(36).slice(2, 10);
      const task = { id: taskId, status: 'running', disk, items: [], spaceDist: [], cursor: 0, progress: { phase: 'items', done: 0, total: scanner.getItems(disk).length, current: [] } };
      tasks.set(taskId, task);
      scanner.scanAll(disk, (item) => { task.items.push(item); task.progress.done = task.items.length; },
        (ph) => { task.progress.phase = ph.phase; task.progress.current = ph.labels || []; })
        .then(r => { task.spaceDist = r.spaceDist; task.status = 'done'; })
        .catch(e => { task.status = 'done'; task.error = e.message; });
      return json(res, 200, { ok: true, data: { taskId } });
    }
    if (req.method === 'GET' && p.startsWith('/api/scan/')) {
      const id = p.split('/').pop();
      const task = tasks.get(id);
      if (!task) return json(res, 404, { ok: false, error: 'not found' });
      const inc = task.items.slice(task.cursor);
      task.cursor = task.items.length;
      return json(res, 200, { ok: true, data: { status: task.status, inc, spaceDist: task.status === 'done' ? task.spaceDist : [], error: task.error, progress: task.progress } });
    }
    if (req.method === 'POST' && p === '/api/verify') {
      const v = verifyKey((body && body.key) || '');
      return json(res, 200, { ok: true, data: v });
    }
    if (req.method === 'POST' && p === '/api/clean') {
      const v = verifyKey((body && body.key) || '');
      if (!v.ok) return json(res, 403, { ok: false, error: 'license_' + v.reason, data: v });
      const r = await runClean(body);
      return json(res, r.status, r.body);
    }
    if (req.method === 'GET' && p === '/api/admin/status') {
      if (!isAdminReq(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      const state = loadState ? (loadState() || { entries: {} }) : { entries: {} };
      return json(res, 200, { ok: true, data: {
        version,
        fingerprint: masterKey.slice(0, 8),
        machineGuid,
        scanRunning: [...tasks.values()].filter(t => t.status === 'running').length,
        license: { entries: state.entries || {} },
      } });
    }
    if (req.method === 'POST' && p === '/api/admin/clean') {
      if (!isAdminReq(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      const r = await runClean(body);
      return json(res, r.status, r.body);
    }
    if (req.method === 'POST' && p === '/api/admin/license/reset') {
      if (!isAdminReq(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      try { if (removeState) removeState(); } catch (e) {}
      return json(res, 200, { ok: true, data: { reset: true } });
    }
    json(res, 404, { ok: false, error: 'not found' });
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 1e6) { resolve({ overflow: true }); req.pause(); } });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : null); } catch (e) { resolve({ badJson: true }); } });
      req.on('error', () => resolve(null));
    });
  }

  const srv = http.createServer(handle);
  srv._license = license;
  srv.listen(port, '127.0.0.1');
  return srv;
}

module.exports = { createServer };
