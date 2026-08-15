(function () {
  const $ = (id) => document.getElementById(id);
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  let state = { disk: null, items: [], verified: false, key: null, cleaning: false, scanDone: false };
  let pollTimer = null;
  let renderSeq = 0;
  const LICENSE_MSGS = {
    invalid: '密钥无效，请核对输入',
    expired: '密钥已过期，请联系服务人员获取新密钥',
    machine_mismatch: '此密钥已在其他电脑上使用',
    clock_rollback: '系统时间异常，请校正时间',
  };

  function fmt(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
  }
  async function api(method, path, body) {
    try {
      const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN, {
        method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
      });
      return r.json();
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }
  function show(view) { ['home', 'scan', 'done'].forEach(v => { $('view-' + v).hidden = v !== view; }); }

  async function loadOverview() {
    const r = await api('GET', '/api/overview');
    if (!r.ok) return;
    const wrap = $('disk-cards'); wrap.innerHTML = '';
    (r.data.disks || []).forEach(d => {
      const used = d.total - d.free;
      const pct = d.total > 0 ? Math.round(used / d.total * 100) : 0;
      const cls = pct > 90 ? 'danger' : pct > 75 ? 'warn' : '';
      const card = document.createElement('div');
      card.className = 'disk-card ' + cls + (state.disk === d.name ? ' selected' : '');
      card.innerHTML = '<div class="dname">' + d.name + '</div><div class="dbar"><div class="dfill" style="width:' + pct + '%"></div></div><div class="dmeta">已用 ' + fmt(used) + ' / ' + fmt(d.total) + ' · 剩余 ' + fmt(d.free) + '</div>';
      card.onclick = () => { state.disk = d.name; document.querySelectorAll('.disk-card').forEach(c => c.classList.remove('selected')); card.classList.add('selected'); $('btn-scan').disabled = false; };
      wrap.appendChild(card);
    });
  }

  $('btn-scan').onclick = async () => {
    if (!state.disk) return;
    state.items = []; renderSeq = 0; state.scanDone = false; state.verified = false; state.key = null;
    $('item-list').innerHTML = ''; $('total-size').textContent = '0 B';
    $('key-status').textContent = ''; $('key-status').className = 'sub';
    $('btn-clean').disabled = true; $('btn-clean').textContent = '开始清理';
    $('space-dist').hidden = true; $('dist-bars').innerHTML = '';
    $('license-box').hidden = true;
    $('key-input').value = ''; $('clean-progress').textContent = '';
    $('scan-progress').hidden = false;
    $('prog-fill').style.width = '0%';
    $('prog-bar').classList.remove('indeterminate');
    $('prog-bar').setAttribute('aria-valuenow', '0');
    $('prog-text').textContent = '正在准备扫描…';
    $('prog-meta').textContent = '0 / 17 项';
    $('sel-line').hidden = true;
    $('view-scan').setAttribute('aria-busy', 'true');
    show('scan'); $('scan-title').textContent = '正在扫描 ' + state.disk + ' …';
    $('scan-sub').textContent = '可清理空间（实时累计）';
    const r = await api('POST', '/api/scan', { disk: state.disk });
    if (!r.ok) {
      $('scan-progress').hidden = true;
      $('view-scan').setAttribute('aria-busy', 'false');
      $('scan-sub').textContent = '启动扫描失败';
      return;
    }
    pollTimer = setInterval(() => poll(r.data.taskId), 1200);
  };

  function renderItem(it) {
    const row = document.createElement('div');
    row.className = 'item' + (it.error ? ' failed' : '');
    row.style.animationDelay = ((renderSeq++ % 4) * 40) + 'ms';
    const riskTxt = { low: '安全', medium: '可选', high: '注意' }[it.risk] || '';
    const riskCls = 'risk-' + (it.risk || 'low');
    const cb = it.error ? '' : '<input type="checkbox" class="pick" data-id="' + it.id + '" data-risk="' + it.risk + '"' + (it.risk === 'low' ? ' checked' : '') + '>';
    row.innerHTML = cb + '<div style="flex:1"><div class="iname">' + it.label + ' <span class="' + riskCls + '">[' + riskTxt + ']</span></div><div class="imeta">' + (it.error ? '扫描失败：' + it.error : fmt(it.sizeBytes)) + '</div></div><div class="isize">' + (it.error ? '—' : fmt(it.sizeBytes)) + '</div>';
    $('item-list').appendChild(row);
    const pick = row.querySelector('.pick');
    if (pick) pick.addEventListener('change', (e) => {
      if (e.target.dataset.risk === 'high' && e.target.checked && !confirm('此项目风险较高（' + row.querySelector('.iname').textContent + '），确认清理？')) e.target.checked = false;
      updateCleanButton();
    });
  }

  function renderProgress(p) {
    if (!p) return;
    const total = p.total || 17;
    const done = p.done || 0;
    const pct = Math.min(100, Math.round(done / total * 100));
    const bar = $('prog-bar');
    $('prog-fill').style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
    $('prog-meta').textContent = done + ' / ' + total + ' 项 · ' + pct + '%';
    if (p.phase === 'space') {
      bar.classList.add('indeterminate');
      $('prog-text').textContent = '正在分析磁盘空间分布（约需 1–3 分钟）';
    } else if (p.phase === 'special') {
      bar.classList.remove('indeterminate');
      $('prog-text').textContent = '正在统计回收站与特殊项…';
    } else {
      bar.classList.remove('indeterminate');
      $('prog-text').textContent = '正在扫描：' + ((p.current && p.current.length) ? p.current.join('、') : '…');
    }
  }

  function updateSummary() {
    const picks = Array.from(document.querySelectorAll('.pick:checked'));
    const sel = picks.reduce((s, cb) => {
      const it = state.items.find(i => i.id === cb.dataset.id);
      return s + ((it && !it.error) ? (it.sizeBytes || 0) : 0);
    }, 0);
    const total = state.items.reduce((s, i) => s + (i.error ? 0 : (i.sizeBytes || 0)), 0);
    const line = $('sel-line');
    if (state.scanDone && state.items.length) {
      line.hidden = false;
      $('sel-num').textContent = fmt(sel);
      $('total-num').textContent = fmt(total);
    } else {
      line.hidden = true;
    }
  }

  function renderDist(spaceDist) {
    if (!spaceDist || !Array.isArray(spaceDist) || !spaceDist.length) return;
    $('space-dist').hidden = false;
    const max = Math.max(...spaceDist.map(d => d.size), 1);
    $('dist-bars').innerHTML = spaceDist.map(d => '<div class="dist-row"><div class="dp" title="' + d.path + '">' + d.path + '</div><div class="dbar2"><div class="dfill2" style="width:' + Math.round(d.size / max * 100) + '%"></div></div><div class="dsz">' + fmt(d.size) + '</div></div>').join('');
  }

  function updateCleanButton() {
    updateSummary();
    const picks = document.querySelectorAll('.pick:checked');
    const any = state.items.some(i => !i.error && i.sizeBytes > 0);
    $('btn-clean').textContent = '开始清理（' + picks.length + ' 项）';
    if (state.scanDone && any && picks.length > 0) $('btn-clean').disabled = false;
    else $('btn-clean').disabled = true;
  }

  async function poll(id) {
    const r = await api('GET', '/api/scan/' + id);
    if (!r.ok) {
      clearInterval(pollTimer);
      $('scan-progress').hidden = true;
      $('view-scan').setAttribute('aria-busy', 'false');
      $('scan-title').textContent = '扫描失败';
      $('scan-sub').textContent = (r.error || '网络错误');
      return;
    }
    (r.data.inc || []).forEach(it => {
      state.items.push(it);
      renderItem(it);
      if (!it.error) $('total-size').textContent = fmt(state.items.reduce((s, x) => s + (x.sizeBytes || 0), 0));
    });
    if (r.data.progress) renderProgress(r.data.progress);
    if (r.data.status === 'done') {
      clearInterval(pollTimer);
      if (r.data.error) {
        $('scan-progress').hidden = true;
        $('view-scan').setAttribute('aria-busy', 'false');
        $('scan-title').textContent = '扫描失败';
        $('scan-sub').textContent = '扫描失败：' + r.data.error;
        return;
      }
      state.scanDone = true;
      $('scan-title').textContent = '扫描完成 · ' + state.disk;
      $('scan-sub').textContent = '勾选要清理的项目，验证密钥后开始清理';
      renderDist(r.data.spaceDist);
      $('license-box').hidden = false;
      $('scan-progress').hidden = true;
      $('view-scan').setAttribute('aria-busy', 'false');
      updateCleanButton();
    }
  }

  $('btn-verify').onclick = async () => {
    const key = $('key-input').value.trim();
    const r = await api('POST', '/api/verify', { key });
    const el = $('key-status');
    if (r.data && r.data.ok) {
      state.verified = true; state.key = key;
      el.textContent = '密钥有效 ✓ 可反复使用' + (r.data.remainingMs ? '（剩余 ' + Math.max(1, Math.ceil(r.data.remainingMs / 3600000)) + ' 小时）' : '');
      el.className = 'sub ok';
      updateCleanButton();
    } else {
      state.verified = false;
      el.textContent = LICENSE_MSGS[r.data && r.data.reason] || '密钥无效';
      el.className = 'sub bad';
    }
  };

  $('btn-clean').onclick = async () => {
    if (state.cleaning) return;
    if (!state.verified) { $('clean-progress').textContent = '请先验证密钥'; return; }
    state.cleaning = true;
    $('btn-clean').disabled = true;
    $('clean-progress').textContent = '正在清理…';
    const ids = Array.from(document.querySelectorAll('.pick:checked')).map(cb => cb.dataset.id);
    let r;
    try {
      r = await api('POST', '/api/clean', { key: state.key, disk: state.disk, items: ids });
    } catch (e) {
      state.cleaning = false;
      $('clean-progress').textContent = '清理失败：网络错误';
      updateCleanButton();
      return;
    }
    state.cleaning = false;
    if (!r.ok) {
      $('clean-progress').textContent = LICENSE_MSGS[r.error && r.error.replace('license_', '')] || '清理失败：' + (r.error || '未知错误');
      updateCleanButton();
      return;
    }
    show('done');
    let doneFreed = r.data.freedTotal;
    $('done-freed').textContent = fmt(doneFreed);
    const list = $('done-list');
    list.innerHTML = '';
    (r.data.results || []).forEach((res, idx) => {
      const div = document.createElement('div');
      div.className = 'item' + (res.ok ? '' : ' failed');
      div.innerHTML = '<div style="flex:1"><div class="iname">' + (res.ok ? '<svg class="ck" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7" fill="none" stroke="#2e9e5b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '✗ ') + res.id + '</div>' + (res.diagnosis ? '<div class="diag">' + res.diagnosis.suggestion + '</div>' : (res.error ? '<div class="imeta">' + res.error + '</div>' : '')) + '</div><div>' + (res.ok ? fmt(res.freed) : '<button class="retry-btn" data-id="' + res.id + '">重试此项目</button>') + '</div>';
      if (res.ok) { const ck = div.querySelector('.ck path'); if (ck) ck.style.animationDelay = (0.15 + idx * 0.08) + 's'; }
      list.appendChild(div);
    });
    list.querySelectorAll('.retry-btn').forEach(b => {
      b.onclick = async () => {
        const r2 = await api('POST', '/api/clean', { key: state.key, disk: state.disk, items: [b.dataset.id] });
        if (r2.ok && r2.data.results[0] && r2.data.results[0].ok) {
          doneFreed += r2.data.results[0].freed || 0;
          $('done-freed').textContent = fmt(doneFreed);
          b.closest('.item').outerHTML = '<div class="item"><div style="flex:1"><div class="iname">✓ ' + b.dataset.id + ' 重试成功</div></div><div class="isize">' + fmt(r2.data.results[0].freed) + '</div></div>';
        } else {
          b.closest('.item').querySelector('.iname').textContent = '✗ ' + b.dataset.id + ' 仍失败';
        }
      };
    });
  };

  $('btn-again').onclick = () => { show('home'); loadOverview(); };

  loadOverview();
})();
