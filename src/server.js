const http = require('node:http');

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function createServer({ port, token, webui, license, scanner, cleaner, psutil, machineGuid = 'unknown', loadState, saveState }) {
  const tasks = new Map();

  function verifyKey(key) {
    const state = loadState ? loadState() : { entries: {} };
    state.save = () => { if (saveState) saveState(state); };
    return license.verify(key, { now: Date.now, machineGuid, state });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') !== token) return json(res, 403, { ok: false, error: 'forbidden' });
    const p = url.pathname;
    const body = await readBody(req);

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
      const taskId = Math.random().toString(36).slice(2, 10);
      const task = { id: taskId, status: 'running', disk, items: [], spaceDist: [], cursor: 0 };
      tasks.set(taskId, task);
      scanner.scanAll(disk, (item) => task.items.push(item))
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
      return json(res, 200, { ok: true, data: { status: task.status, inc, spaceDist: task.status === 'done' ? task.spaceDist : [], error: task.error } });
    }
    if (req.method === 'POST' && p === '/api/verify') {
      const v = verifyKey((body && body.key) || '');
      return json(res, 200, { ok: true, data: v });
    }
    if (req.method === 'POST' && p === '/api/clean') {
      const v = verifyKey((body && body.key) || '');
      if (!v.ok) return json(res, 403, { ok: false, error: 'license_' + v.reason, data: v });
      const items = (body && body.items) || [];
      const known = new Set(scanner.getItems().map(i => i.id));
      if (!items.length || !items.every(id => known.has(id))) return json(res, 400, { ok: false, error: 'invalid item id' });
      const disk = (body && body.disk) || (process.env.SystemDrive || 'C:') + '\\';
      const res2 = await cleaner.clean({ disk, items }, () => {});
      return json(res, 200, { ok: true, data: res2 });
    }
    json(res, 404, { ok: false, error: 'not found' });
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : null); } catch (e) { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  const srv = http.createServer(handle);
  srv._license = license;
  srv.listen(port, '127.0.0.1');
  return srv;
}

module.exports = { createServer };
