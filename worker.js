// =========================================================
//  청첩장 서버 코드 (공책 지킴이)
//  - 방명록 저장      : POST /api/guestbook
//  - 참석 여부 저장   : POST /api/rsvp
//  - 관리 페이지      : /admin  (신랑·신부 전용, 비밀번호 필요)
//  그 외 주소는 청첩장 파일(index.html, img, bgm)을 그대로 보여줍니다.
// =========================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/api/guestbook' && request.method === 'POST') return saveGuestbook(request, env);
      if (path === '/api/rsvp' && request.method === 'POST') return saveRsvp(request, env);

      if (path === '/admin') return new Response(ADMIN_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
      });
      if (path === '/api/admin/data' && request.method === 'GET') return adminData(request, env);
      if (path === '/api/admin/delete' && request.method === 'POST') return adminDelete(request, env);

      if (path.startsWith('/api/')) return json({ ok: false, error: '잘못된 요청입니다.' }, 404);
    } catch (err) {
      return json({ ok: false, error: '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, 500);
    }

    // 청첩장 파일
    return env.ASSETS.fetch(request);
  },
};

// ---------- 공통 ----------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const charLen = (s) => [...s].length;     // 이모지·한글도 한 글자로 셈

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 접속 주소(IP)는 그대로 저장하지 않고 알아볼 수 없게 바꿔서 저장
async function ipHash(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256('wedding-guest|' + ip);
}

// ---------- 방명록 저장 ----------
async function saveGuestbook(request, env) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: '입력 내용을 확인해 주세요.' }, 400);

  const name = clean(body.name);
  const phone4 = clean(body.phone4);
  const message = clean(body.message);

  if (!name || charLen(name) > 20) return json({ ok: false, error: '이름을 20자 이내로 입력해 주세요.' }, 400);
  if (!/^\d{4}$/.test(phone4)) return json({ ok: false, error: '연락처 뒤 4자리를 숫자로 입력해 주세요.' }, 400);
  if (!message || charLen(message) >= 30) return json({ ok: false, error: '메시지는 30글자 미만으로 입력해 주세요.' }, 400);

  // 매크로 방지: 같은 접속 환경에서 1분 안에 다시 작성 불가
  const hash = await ipHash(request);
  const recent = await env.DB.prepare(
    "SELECT 1 FROM guestbook WHERE ip_hash = ? AND created_at > datetime('now', '-60 seconds') LIMIT 1"
  ).bind(hash).first();
  if (recent) return json({ ok: false, error: '방금 작성하셨어요. 1분 뒤에 다시 남겨 주세요.' }, 429);

  await env.DB.prepare('INSERT INTO guestbook (name, phone4, message, ip_hash) VALUES (?, ?, ?, ?)')
    .bind(name, phone4, message, hash).run();

  return json({ ok: true });
}

// ---------- 참석 여부 저장 ----------
async function saveRsvp(request, env) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: '입력 내용을 확인해 주세요.' }, 400);

  const side = clean(body.side);
  const attend = clean(body.attend);
  const name = clean(body.name);
  let meal = clean(body.meal);
  let companions = clean(String(body.companions ?? '0'));

  if (!['신랑', '신부'].includes(side)) return json({ ok: false, error: '신랑측 또는 신부측을 선택해 주세요.' }, 400);
  if (!['참석', '불참석'].includes(attend)) return json({ ok: false, error: '참석 여부를 선택해 주세요.' }, 400);
  if (!name || charLen(name) > 20) return json({ ok: false, error: '이름을 20자 이내로 입력해 주세요.' }, 400);

  if (attend === '참석') {
    if (!['O', 'X', '미정'].includes(meal)) return json({ ok: false, error: '식사 여부를 선택해 주세요.' }, 400);
    if (companions === '') companions = '0';
    if (!/^\d{1,2}$/.test(companions)) return json({ ok: false, error: '동행인 인원 수는 숫자로 입력해 주세요.' }, 400);
  } else {
    meal = null;          // 불참석이면 식사 여부 비움
    companions = '0';     // 동행인 0명
  }

  const hash = await ipHash(request);
  await env.DB.prepare(
    'INSERT INTO rsvp (side, attend, meal, name, companions, ip_hash) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(side, attend, meal, name, Number(companions), hash).run();

  return json({ ok: true });
}

// ---------- 관리 페이지용 ----------
function checkAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: '관리자 비밀번호가 아직 설정되지 않았습니다.' }, 503);
  if (request.headers.get('x-admin-password') !== env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '비밀번호가 맞지 않습니다.' }, 401);
  }
  return null;
}

async function adminData(request, env) {
  const denied = checkAdmin(request, env);
  if (denied) return denied;
  const gb = await env.DB.prepare(
    'SELECT id, name, phone4, message, created_at FROM guestbook ORDER BY id DESC'
  ).all();
  const rv = await env.DB.prepare(
    'SELECT id, side, attend, meal, name, companions, created_at FROM rsvp ORDER BY id DESC'
  ).all();
  return json({ ok: true, guestbook: gb.results, rsvp: rv.results });
}

async function adminDelete(request, env) {
  const denied = checkAdmin(request, env);
  if (denied) return denied;
  const body = await readJson(request);
  const table = body && body.table;
  const id = body && Number(body.id);
  if (!['guestbook', 'rsvp'].includes(table) || !Number.isInteger(id)) {
    return json({ ok: false, error: '잘못된 요청입니다.' }, 400);
  }
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// ---------- 관리 페이지 화면 ----------
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>청첩장 관리</title>
<style>
  :root { --accent:#a08474; --line:#e8e2dc; --text:#333; --sub:#888; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif; background:#f6f3f0; color:var(--text); }
  .wrap { max-width:760px; margin:0 auto; padding:24px 16px 60px; }
  h1 { font-size:20px; margin-bottom:16px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
  .login input { width:100%; height:46px; border:1px solid var(--line); border-radius:8px; padding:0 12px; font-size:16px; margin:10px 0; }
  button { height:40px; padding:0 14px; border:1px solid var(--line); border-radius:8px; background:#fff; font-size:14px; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:700; }
  .tabs { display:flex; gap:8px; margin-bottom:12px; }
  .tabs button.is-on { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:700; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:8px; margin-bottom:12px; }
  .stat { background:#faf8f6; border:1px solid var(--line); border-radius:10px; padding:12px; }
  .stat b { display:block; font-size:22px; margin-top:4px; }
  .stat span { font-size:12px; color:var(--sub); }
  .bar { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px; }
  .bar p { font-size:14px; color:var(--sub); }
  .tbl { width:100%; border-collapse:collapse; font-size:14px; }
  .tbl th, .tbl td { border-bottom:1px solid var(--line); padding:10px 6px; text-align:left; vertical-align:top; }
  .tbl th { font-size:12px; color:var(--sub); font-weight:600; white-space:nowrap; }
  .tbl td { white-space:nowrap; }
  .tbl td.msg { white-space:normal; min-width:140px; word-break:keep-all; }
  .tbl td.time { font-size:12px; color:var(--sub); }
  .tbl button { height:30px; padding:0 10px; font-size:12px; color:#b04a3a; white-space:nowrap; }
  .empty { padding:24px 0; text-align:center; color:var(--sub); font-size:14px; }
  .err { color:#b04a3a; font-size:14px; margin-top:6px; min-height:20px; }
  .scroll { overflow-x:auto; }
</style>
</head>
<body>
<div class="wrap">
  <h1>청첩장 관리</h1>

  <div class="card login" id="login">
    <p>관리자 비밀번호를 입력해 주세요.</p>
    <input type="password" id="pw" autocomplete="current-password">
    <button class="primary" id="loginBtn">확인</button>
    <p class="err" id="loginErr"></p>
  </div>

  <div id="main" hidden>
    <div class="tabs">
      <button id="tabRsvp" class="is-on">참석 여부</button>
      <button id="tabGb">방명록</button>
      <button id="reload" style="margin-left:auto">새로고침</button>
    </div>

    <div class="card" id="rsvpBox">
      <div class="stats" id="rsvpStats"></div>
      <div class="bar"><p id="rsvpCount"></p><button id="rsvpCsv">엑셀(CSV) 받기</button></div>
      <div class="scroll"><table class="tbl" id="rsvpTbl"></table></div>
    </div>

    <div class="card" id="gbBox" hidden>
      <div class="bar"><p id="gbCount"></p><button id="gbCsv">엑셀(CSV) 받기</button></div>
      <div class="scroll"><table class="tbl" id="gbTbl"></table></div>
    </div>
  </div>
</div>

<script>
  let PW = '';
  let DATA = { guestbook: [], rsvp: [] };
  try { PW = sessionStorage.getItem('wedding_admin_pw') || ''; } catch (e) {}

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const kst = (t) => new Date(t.replace(' ', 'T') + 'Z').toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function api(path, opt = {}) {
    const res = await fetch(path, { ...opt, headers: { 'content-type': 'application/json', 'x-admin-password': PW, ...(opt.headers || {}) } });
    const data = await res.json().catch(() => ({ ok: false, error: '응답을 읽지 못했습니다.' }));
    if (!res.ok || !data.ok) throw new Error(data.error || '오류가 발생했습니다.');
    return data;
  }

  async function load() {
    try {
      DATA = await api('/api/admin/data');
      try { sessionStorage.setItem('wedding_admin_pw', PW); } catch (e) {}
      $('login').hidden = true; $('main').hidden = false;
      render();
    } catch (e) {
      $('login').hidden = false; $('main').hidden = true;
      $('loginErr').textContent = PW ? e.message : '';
    }
  }

  function render() {
    // 참석 여부 요약
    const r = DATA.rsvp;
    const yes = r.filter((x) => x.attend === '참석');
    const people = (arr) => arr.reduce((n, x) => n + 1 + (Number(x.companions) || 0), 0);
    const stat = (label, val) => '<div class="stat"><span>' + label + '</span><b>' + val + '</b></div>';
    $('rsvpStats').innerHTML =
      stat('참석 인원 (동행 포함)', people(yes) + '명') +
      stat('신랑측 참석', people(yes.filter((x) => x.side === '신랑')) + '명') +
      stat('신부측 참석', people(yes.filter((x) => x.side === '신부')) + '명') +
      stat('식사 O (동행 포함)', people(yes.filter((x) => x.meal === 'O')) + '명') +
      stat('식사 미정', people(yes.filter((x) => x.meal === '미정')) + '명') +
      stat('불참석 응답', r.filter((x) => x.attend === '불참석').length + '건');
    $('rsvpCount').textContent = '전체 응답 ' + r.length + '건';
    $('rsvpTbl').innerHTML = r.length ? '<tr><th>시간</th><th>측</th><th>이름</th><th>참석</th><th>식사</th><th>동행</th><th></th></tr>' +
      r.map((x) => '<tr><td class="time">' + kst(x.created_at) + '</td><td>' + esc(x.side) + '</td><td>' + esc(x.name) + '</td><td>' + esc(x.attend) + '</td><td>' + esc(x.meal || '-') + '</td><td>' + esc(x.companions) + '</td><td><button data-del="rsvp" data-id="' + x.id + '">삭제</button></td></tr>').join('')
      : '<tr><td class="empty">아직 응답이 없습니다.</td></tr>';

    // 방명록
    const g = DATA.guestbook;
    $('gbCount').textContent = '전체 ' + g.length + '건';
    $('gbTbl').innerHTML = g.length ? '<tr><th>시간</th><th>이름</th><th>뒤4자리</th><th>메시지</th><th></th></tr>' +
      g.map((x) => '<tr><td class="time">' + kst(x.created_at) + '</td><td>' + esc(x.name) + '</td><td>' + esc(x.phone4) + '</td><td class="msg">' + esc(x.message) + '</td><td><button data-del="guestbook" data-id="' + x.id + '">삭제</button></td></tr>').join('')
      : '<tr><td class="empty">아직 방명록이 없습니다.</td></tr>';
  }

  function csv(name, head, rows) {
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const text = '\\uFEFF' + [head, ...rows].map((r) => r.map(q).join(',')).join('\\r\\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    a.click();
  }

  $('loginBtn').onclick = () => { PW = $('pw').value; load(); };
  $('pw').onkeydown = (e) => { if (e.key === 'Enter') $('loginBtn').click(); };
  $('reload').onclick = load;
  $('tabRsvp').onclick = () => { $('rsvpBox').hidden = false; $('gbBox').hidden = true; $('tabRsvp').classList.add('is-on'); $('tabGb').classList.remove('is-on'); };
  $('tabGb').onclick = () => { $('rsvpBox').hidden = true; $('gbBox').hidden = false; $('tabGb').classList.add('is-on'); $('tabRsvp').classList.remove('is-on'); };
  $('rsvpCsv').onclick = () => csv('참석여부.csv', ['시간', '측', '이름', '참석', '식사', '동행인'],
    DATA.rsvp.map((x) => [kst(x.created_at), x.side, x.name, x.attend, x.meal || '', x.companions]));
  $('gbCsv').onclick = () => csv('방명록.csv', ['시간', '이름', '연락처뒤4자리', '메시지'],
    DATA.guestbook.map((x) => [kst(x.created_at), x.name, x.phone4, x.message]));

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    if (!confirm('이 항목을 삭제할까요? 삭제하면 되돌릴 수 없습니다.')) return;
    try { await api('/api/admin/delete', { method: 'POST', body: JSON.stringify({ table: b.dataset.del, id: b.dataset.id }) }); load(); }
    catch (err) { alert(err.message); }
  });

  if (PW) load();
</script>
</body>
</html>`;
