'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let boot = null;
  let convId = null;
  let es = null;
  let messages = new Map();
  let status = null;
  let stickToBottom = true;

  // ── helpers ─────────────────────────────────────────────
  function toast(text, ms = 4200) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), ms);
  }

  async function api(method, url, body) {
    let r;
    try {
      r = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CCW': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return { ok: false, message: '서버에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요.' };
    }
    try {
      const data = await r.json();
      if (!r.ok && data.ok === undefined) data.ok = false;
      return data;
    } catch {
      return { ok: false, message: `서버 응답 오류 (HTTP ${r.status})` };
    }
  }

  function colorFor(name) {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 55% 42%)`;
  }

  // ── markdown (escape first, then a small safe subset) ───
  function inlineMd(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  }
  function md(src) {
    const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flush();
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push(`<details class="code-details"><summary>코드 보기</summary><pre><code>${esc(body.join('\n'))}</code></pre></details>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { flush(); out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
        flush();
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flush();
        const q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${md(q.join('\n'))}</blockquote>`);
        continue;
      }
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flush();
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (m) { items.push(m[3]); i++; continue; }
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; }
          break;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((t) => `<li>${inlineMd(t)}</li>`).join('')}</${tag}>`);
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return out.join('');
  }

  // ── composer (textarea + images) ────────────────────────
  function makeComposer(form, onSubmit) {
    const ta = $('textarea', form);
    const file = $('input[type=file]', form);
    const thumbs = $(`.thumbs[data-for="${form.id}"]`);
    let images = [];
    let busy = false;

    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
    };
    const renderThumbs = () => {
      thumbs.innerHTML = images.map((im, i) => `<div class="thumb"><img src="${im.data}" alt="${esc(im.name)}"><button type="button" data-i="${i}" title="제거">×</button></div>`).join('');
    };
    const addFiles = async (files) => {
      for (const f of files) {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast(`${f.name || '파일'}: png/jpeg/gif/webp 이미지만 첨부할 수 있습니다.`); continue; }
        if (images.length >= (boot?.maxImages ?? 4)) { toast(`이미지는 최대 ${boot?.maxImages ?? 4}장까지 첨부할 수 있습니다.`); break; }
        if (f.size > (boot?.maxImageBytes ?? 5 * 1024 * 1024)) { toast(`${f.name || '이미지'}: 파일이 너무 큽니다 (최대 ${Math.round((boot?.maxImageBytes ?? 5242880) / 1048576)}MB).`); continue; }
        const data = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.readAsDataURL(f);
        }).catch(() => null);
        if (!data) { toast(`${f.name || '이미지'}: 파일을 읽지 못했습니다.`); continue; }
        images.push({ name: f.name || 'pasted.png', data });
      }
      renderThumbs();
    };

    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
      // e.isComposing: don't submit while a Korean syllable is still being composed
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    $('.attach', form)?.addEventListener('click', () => file.click());
    file.addEventListener('change', () => { addFiles([...file.files]); file.value = ''; });
    thumbs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      images.splice(Number(b.dataset.i), 1);
      renderThumbs();
    });
    for (const ev of ['dragenter', 'dragover']) form.addEventListener(ev, (e) => { e.preventDefault(); form.classList.add('drag'); });
    for (const ev of ['dragleave', 'drop']) form.addEventListener(ev, () => form.classList.remove('drag'));
    form.addEventListener('drop', (e) => { e.preventDefault(); addFiles([...(e.dataTransfer?.files ?? [])]); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const text = ta.value.trim();
      if (!text && !images.length) { ta.focus(); return; }
      busy = true;
      const ok = await onSubmit(text, images.map((im) => ({ name: im.name, data: im.data })), $('select[name="model"]', form)?.value || undefined);
      busy = false;
      if (ok) {
        ta.value = '';
        images = [];
        renderThumbs();
        autosize();
      }
    });
    return { focus: () => ta.focus() };
  }

  // ── home ────────────────────────────────────────────────
  function renderHome() {
    const sel = $('#home-form select[name="project"]');
    const last = (() => { try { return localStorage.getItem('ccw.project'); } catch { return null; } })();
    sel.innerHTML = boot.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
    if (last && boot.projects.some((p) => p.name === last)) sel.value = last;
    $('#resume-form select').innerHTML = sel.innerHTML;
    loadModels($('#home-form'), sel.value);
    const tiles = boot.recent.map((c) => `
      <a class="tile" href="/c/${esc(c.convId)}" data-nav title="${esc(c.title)} (${esc(c.project)})">
        <span class="disc"><span class="letter" data-color="${esc(colorFor(c.project))}">${esc(c.project.slice(0, 1).toUpperCase())}</span>${c.busy ? '<span class="busy"></span>' : ''}</span>
        <span class="label">${esc(c.title)}</span>
      </a>`);
    tiles.push(`<button class="tile" type="button" id="resume-tile"><span class="disc"><span class="plus">+</span></span><span class="label">세션 이어가기</span></button>`);
    $('#tiles').innerHTML = tiles.join('');
    for (const el of $$('[data-color]', $('#tiles'))) el.style.background = el.dataset.color; // CSP: no inline style attributes
    $('#resume-tile').addEventListener('click', () => $('#resume-dialog').showModal());
  }

  async function refreshBoot() {
    const b = await api('GET', '/api/bootstrap');
    if (b && b.projects) {
      boot = b;
      $('#conn').className = 'conn on';
      return true;
    }
    $('#conn').className = 'conn off';
    if (b?.message) toast(b.message);
    return false;
  }

  // ── results: rendering ──────────────────────────────────
  const VERBS = ['노트북 수정', '파일 검색', '내용 검색', '하위 에이전트:', '읽기', '작성', '수정', '검색', '명령 실행'];
  function stepItem(line, project) {
    let rest = line.replace(/^[^\p{L}\p{N}]+\s*/u, '');
    let title = '명령 실행';
    for (const v of VERBS) {
      if (rest.startsWith(v + ' ') || rest === v) { title = v.replace(/:$/, ''); rest = rest.slice(v.length).trim(); break; }
    }
    const crumb = [project, ...rest.split(/[\\/]/).filter(Boolean)].join(' › ');
    return `<div class="result"><div><div class="crumb">${esc(crumb)}</div><div class="rtitle">${esc(title)}</div></div></div>`;
  }

  function plainSnippet(src, limit = 210) {
    const text = String(src ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/!?(\[([^\]]+)\])\([^)]*\)/g, '$2').replace(/^[#>*\-\d.\s]+/gm, '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
  }

  function answerPreview(src) {
    const heading = /^\s*#{1,4}\s+(.+)$/m.exec(src)?.[1];
    const body = heading ? src.replace(/^\s*#{1,4}\s+.+\n?/m, '') : src;
    return { title: plainSnippet(heading || src, 85) || '작업 결과', snippet: plainSnippet(body) };
  }

  function cleanUiText(src) {
    return String(src ?? '').replace(/^[\p{Extended_Pictographic}\uFE0F\u200D]+\s*/gmu, '');
  }

  function renderMessage(m) {
    const meta = m.meta || {};
    switch (m.kind) {
      case 'user':
        return `<section class="query"><div class="query-label">질문</div><details class="query-details"><summary>더보기</summary><div class="query-text">${esc(m.text || '(이미지)')}</div>${meta.imageCount ? `<div class="query-meta">이미지 ${meta.imageCount}장</div>` : ''}</details></section>`;
      case 'progress': {
        const lines = m.text ? m.text.split('\n') : [];
        const final = meta.durationMs !== undefined && meta.durationMs !== null;
        if (final && !lines.length) return '';
        if (!final && !lines.length) return '<div class="working">작업중</div>';
        return `<details class="steps" ${m._detailsOpen ? 'open' : ''}><summary class="steps-head">${final ? '작업 과정 더보기' : '<span class="working">작업중</span>'}</summary>
          <div class="steps-content">${lines.map((l) => stepItem(l, status?.project ?? '')).join('')}</div>
        </details>`;
      }
      case 'answer': {
        const preview = answerPreview(m.text);
        return `<article class="overview"><div class="search-source"><span class="source-mark">G</span><span>Google</span></div>
          <h3 class="search-title">${esc(preview.title)}</h3>
          <p class="search-snippet">${esc(preview.snippet)}</p>
          <details class="answer-details" ${m._detailsOpen ? 'open' : ''}><summary>더보기</summary><div class="md">${md(m.text)}</div></details></article>`;
      }
      case 'error':
        return `<div class="card error"><div class="md">${md(m.text)}</div></div>`;
      case 'approval': {
        const open = !!m.approval;
        return `<div class="card approval ${open ? '' : 'closed'}"><div class="card-head">승인이 필요합니다</div><div class="md">${md(m.text)}</div>
          ${open ? `<div class="card-actions"><button class="btn ok" data-approve="allow" data-token="${esc(m.approval.token)}">승인</button><button class="btn danger" data-approve="deny" data-token="${esc(m.approval.token)}">거절</button></div>` : ''}</div>`;
      }
      default:
        return `<div class="notice md">${md(cleanUiText(m.text))}</div>`;
    }
  }

  function renderFeed() {
    const feed = $('#feed');
    const list = [...messages.values()].sort((a, b) => a.id - b.id);
    if (!list.length) {
      feed.innerHTML = `<div class="empty">아직 대화가 없습니다. 위 검색창에 작업을 입력하세요.</div>`;
      return;
    }
    const turns = [];
    let cur = null;
    for (const m of list) {
      if (m.kind === 'user' || !cur) { cur = []; turns.push(cur); }
      cur.push(m);
    }
    const banner = status?.resumeBroken
      ? `<div class="banner"><strong>세션을 이어갈 수 없습니다.</strong> 저장된 세션 <code>${esc(status.sessionId ?? '')}</code> 은(는) 그대로 두었습니다.
          <div class="card-actions"><button class="btn" data-act="recheck">세션 다시 확인</button><button class="btn primary" data-act="new">새 세션으로 시작</button></div></div>`
      : '';
    feed.innerHTML = banner + turns.map((t) => `<section class="turn">${t.map((m) => `<div data-mid="${m.id}">${renderMessage(m)}</div>`).join('')}</section>`).join('');
  }

  function upsert(m) {
    const prev = messages.get(m.id);
    if (prev?._detailsOpen) m._detailsOpen = true;
    messages.set(m.id, m);
    const el = $(`[data-mid="${m.id}"]`);
    if (el && prev) {
      el.innerHTML = renderMessage(m);
    } else {
      renderFeed();
    }
    if (stickToBottom) scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
  }

  const STATE_LABEL = { idle: '대기', running: '실행 중', awaiting_approval: '승인 대기 중', queued: '대기열' };
  const JOB_LABEL = { queued: '대기 중', running: '실행 중', awaiting_approval: '승인 대기 중', succeeded: '완료', failed: '실패', cancelled: '취소됨', denied: '거절로 종료', blocked: '보안 차단', interrupted: '중단됨' };
  function renderPanel() {
    const s = status;
    if (!s) { $('#panel').innerHTML = ''; return; }
    const busy = s.state !== 'idle';
    document.title = `${s.title || '대화'} · Google`;
    $('#panel').innerHTML = `
      <h3>${esc(s.project)}</h3>
      <div class="sub">${esc(s.projectPath)}</div>
      <dl class="kv">
        <dt>상태</dt><dd><span class="pill ${s.state === 'running' ? 'live' : s.state === 'awaiting_approval' ? 'wait' : ''}">${STATE_LABEL[s.state] ?? s.state}${s.runningJobId ? ` · #${s.runningJobId}` : ''}</span>${s.queuedJobIds.length ? ` <span class="muted">+ 대기 ${s.queuedJobIds.length}</span>` : ''}</dd>
        <dt>세션</dt><dd>${s.sessionId ? `<code>${esc(s.sessionId)}</code><button class="copy" data-copy="${esc(s.sessionId)}">복사</button>` : '<span class="muted">첫 입력에서 생성</span>'}${s.resumeBroken ? '<br><span class="danger-text">재개 불가</span>' : ''}</dd>
        <dt>최근 작업</dt><dd>${s.lastJob ? `#${s.lastJob.id} ${esc(JOB_LABEL[s.lastJob.status] ?? s.lastJob.status)}${s.lastJob.costUsd ? ` · $${Number(s.lastJob.costUsd).toFixed(4)}` : ''}` : '<span class="muted">없음</span>'}</dd>
        <dt>실행 방식</dt><dd>${s.permissionMode === 'bypassPermissions' ? '자동 실행' : esc(s.permissionMode)}</dd>
      </dl>
      <div class="panel-actions">
        <button class="btn danger" data-act="stop" ${busy ? '' : 'disabled'}>중지</button>
        <button class="btn" data-act="new" ${busy ? 'disabled' : ''}>새 세션</button>
        ${s.resumeBroken ? '<button class="btn" data-act="recheck">세션 다시 확인</button>' : ''}
      </div>`;
  }

  // ── results: connection ─────────────────────────────────
  function setConn(on) {
    $('#r-conn').className = `conn ${on ? 'on' : 'off'}`;
    $('#r-conn').title = on ? '실시간 연결됨' : '연결 끊김 · 재연결 중';
  }

  function connect(id) {
    if (es) es.close();
    es = new EventSource(`/api/conversations/${id}/events`);
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse(e.data);
      status = d.status;
      const open = new Set([...messages.values()].filter((m) => m._detailsOpen).map((m) => m.id));
      messages = new Map(d.messages.map((m) => [m.id, open.has(m.id) ? { ...m, _detailsOpen: true } : m]));
      setConn(true);
      renderPanel();
      renderFeed();
      if (stickToBottom) scrollToBottom();
    });
    es.addEventListener('message', (e) => upsert(JSON.parse(e.data)));
    es.addEventListener('status', (e) => {
      const wasBroken = status?.resumeBroken;
      status = JSON.parse(e.data);
      renderPanel();
      if (wasBroken !== status.resumeBroken) renderFeed();
    });
    es.onopen = () => setConn(true);
    es.onerror = async () => {
      setConn(false);
      if (es.readyState === EventSource.CLOSED) {
        // Server refused (e.g. logged out or conversation gone): check, then retry.
        const r = await api('GET', `/api/conversations/${id}`);
        if (!r || r.ok === false) { toast(r?.message || '대화를 불러오지 못했습니다.'); return; }
        setTimeout(() => convId === id && connect(id), 3000);
      }
    };
  }

  async function openConversation(id) {
    convId = id;
    messages = new Map();
    status = null;
    document.body.className = 'view-results';
    $('#home').hidden = true;
    $('#results').hidden = false;
    $('#feed').innerHTML = '<div class="empty">불러오는 중…</div>';
    $('#panel').innerHTML = '';
    $('#panel').hidden = true;
    $('#details-toggle').setAttribute('aria-expanded', 'false');
    stickToBottom = true;
    connect(id);
    rComposer.focus();
  }

  async function showHome() {
    convId = null;
    if (es) { es.close(); es = null; }
    document.body.className = 'view-home';
    document.title = 'Google';
    $('#results').hidden = true;
    $('#home').hidden = false;
    if (await refreshBoot()) renderHome();
    homeComposer.focus();
  }

  function route() {
    const m = /^\/c\/([0-9a-f-]{36})$/i.exec(location.pathname);
    if (m && UUID.test(m[1])) openConversation(m[1]);
    else showHome();
  }
  function navigate(path) {
    if (location.pathname !== path) history.pushState(null, '', path);
    route();
  }

  // ── wiring ──────────────────────────────────────────────
  function modelLabel(model) {
    const resolved = /^claude-([a-z]+)-(\d+)-(\d+)/i.exec(model.resolvedModel || '');
    const name = resolved ? `${resolved[1][0].toUpperCase()}${resolved[1].slice(1)} ${resolved[2]}.${resolved[3]}` : model.displayName;
    if (model.value === 'default') return `기본 · ${name}`;
    return `${name}${/\[1m\]/i.test(model.value) ? ' · 1M' : ''}`;
  }

  async function loadModels(form, project) {
    const select = $('select[name="model"]', form);
    form.dataset.modelProject = project;
    select.disabled = true;
    select.innerHTML = '<option value="">모델 불러오는 중…</option>';
    const data = await api('GET', `/api/models?project=${encodeURIComponent(project)}`);
    if (form.dataset.modelProject !== project) return;
    if (!data.models?.length) {
      select.innerHTML = '<option value="">기본 모델</option>';
      select.disabled = false;
      if (data.message) toast(data.message);
      return;
    }
    select.innerHTML = data.models.map((m) => `<option value="${esc(m.value)}">${esc(modelLabel(m))}</option>`).join('');
    const saved = (() => { try { return localStorage.getItem('ccw.model'); } catch { return null; } })();
    const chosen = data.models.find((m) => m.value === saved)
      || data.models.find((m) => m.value !== 'default' && m.resolvedModel === saved)
      || data.models.find((m) => m.value === 'default') || data.models[0];
    select.value = chosen.value;
    select.disabled = false;
  }

  for (const select of $$('select[name="model"]')) {
    select.addEventListener('change', () => {
      try { localStorage.setItem('ccw.model', select.value); } catch {}
    });
  }
  $('#home-form select[name="project"]').addEventListener('change', (e) => loadModels($('#home-form'), e.target.value));
  $('#home-options-toggle').addEventListener('click', () => {
    const options = $('#home-options');
    const expanded = options.hidden;
    options.hidden = !expanded;
    $('#home-options-toggle').setAttribute('aria-expanded', String(expanded));
    $('#home-options-toggle').setAttribute('aria-label', `모델 및 작업 위치 선택 ${expanded ? '닫기' : '열기'}`);
  });
  $('#details-toggle').addEventListener('click', () => {
    const panel = $('#panel');
    panel.hidden = !panel.hidden;
    $('#details-toggle').setAttribute('aria-expanded', String(!panel.hidden));
    $('#details-toggle').setAttribute('aria-label', `대화 정보 ${panel.hidden ? '열기' : '닫기'}`);
  });

  const homeComposer = makeComposer($('#home-form'), async (text, images, model) => {
    const project = $('#home-form select[name="project"]').value;
    if (!project) { toast('projects.json 에 프로젝트가 없습니다.'); return false; }
    try { localStorage.setItem('ccw.project', project); } catch {}
    const r = await api('POST', '/api/conversations', { project, text, images, model });
    if (!r.ok) { toast(r.message || '시작하지 못했습니다.'); return false; }
    navigate(`/c/${r.convId}`);
    return true;
  });

  const rComposer = makeComposer($('#r-form'), async (text, images) => {
    if (!convId) return false;
    stickToBottom = true;
    const r = await api('POST', `/api/conversations/${convId}/messages`, { text, images });
    if (!r.ok) { toast(r.message || '보내지 못했습니다.'); return false; }
    return true;
  });

  async function act(name) {
    if (!convId) return;
    if (name === 'new' && !confirm('이 대화에서 새 Claude 세션을 시작할까요? (이전 세션 ID는 기록에 남습니다)')) return;
    const r = await api('POST', `/api/conversations/${convId}/${name}`, {});
    if (!r.ok) toast(r.message || '처리하지 못했습니다.');
    else if (name === 'stop') toast('중지를 요청했습니다. 정리되는 대로 결과를 표시합니다.');
  }

  document.addEventListener('click', async (e) => {
    const nav = e.target.closest('a[data-nav]');
    if (nav && !e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); navigate(new URL(nav.href).pathname); return; }
    const ap = e.target.closest('[data-approve]');
    if (ap) {
      const card = ap.closest('.card');
      $$('button', card).forEach((b) => (b.disabled = true));
      const r = await api('POST', `/api/conversations/${convId}/approvals/${ap.dataset.token}`, { decision: ap.dataset.approve });
      if (!r.ok) { toast(r.message || '처리하지 못했습니다.'); $$('button', card).forEach((b) => (b.disabled = false)); }
      return;
    }
    const a = e.target.closest('[data-act]');
    if (a) { act(a.dataset.act); return; }
    const cp = e.target.closest('[data-copy]');
    if (cp) { navigator.clipboard?.writeText(cp.dataset.copy).then(() => toast('복사했습니다.'), () => toast('복사하지 못했습니다.')); return; }
    const tab = e.target.closest('.tab');
    if (tab) {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('#feed').dataset.filter = tab.dataset.filter;
    }
  });
  document.addEventListener('toggle', (e) => {
    const wrap = e.target.closest?.('[data-mid]');
    if (!wrap || !e.target.matches('.steps, .answer-details')) return;
    const m = messages.get(Number(wrap.dataset.mid));
    if (m) m._detailsOpen = e.target.open;
  }, true);
  $('#resume-dialog').addEventListener('close', async () => {
    const dlg = $('#resume-dialog');
    if (dlg.returnValue !== 'ok') return;
    const f = $('#resume-form');
    const r = await api('POST', '/api/resume', { sessionId: f.sessionId.value.trim(), project: f.project.value });
    if (!r.ok) { toast(r.message || '세션을 연결하지 못했습니다.'); return; }
    f.reset();
    navigate(`/c/${r.convId}`);
  });
  window.addEventListener('scroll', () => {
    stickToBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  }, { passive: true });
  window.addEventListener('popstate', route);
  refreshBoot().then(() => {
    if (!boot) return;
    $('#resume-form select').innerHTML = boot.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
    route();
  });
})();
