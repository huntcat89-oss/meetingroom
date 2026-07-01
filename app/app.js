'use strict';

/* ============================================================
 * 설정 (브라우저 localStorage 에만 저장)
 * ============================================================ */
const LS = {
  get key() { return localStorage.getItem('mr_apiKey') || ''; },
  set key(v) { v ? localStorage.setItem('mr_apiKey', v) : localStorage.removeItem('mr_apiKey'); },
  get base() { return localStorage.getItem('mr_apiBase') || 'https://api.flow.team/user'; },
  set base(v) { localStorage.setItem('mr_apiBase', v || 'https://api.flow.team/user'); },
  get cal() { return localStorage.getItem('mr_calendarSrno') || ''; },
  set cal(v) { v ? localStorage.setItem('mr_calendarSrno', v) : localStorage.removeItem('mr_calendarSrno'); },
};
function mode() { return LS.key ? 'direct' : 'sample'; }

/* ============================================================
 * 층(회의실 프로젝트 캘린더) 정의
 *   project = 플로우 프로젝트 번호(=일정 colaboSrno). 층 필터·calendarSrno 역매핑에 사용.
 * ============================================================ */
const FLOORS = [
  {
    label: '14F', project: '1635267', // [공유] 회의실 예약 - 14F
    rooms: [
      { id: '서울', loc: '대회의실' },
      { id: '런던', loc: 'SaaS 사업부 옆' },
      { id: '도쿄', loc: '부대표실 옆' },
      { id: '샌프란', loc: '입구(우)' },
      { id: '멕시코시티', loc: '입구(좌)' },
      { id: '독도', loc: '화상회의실' },
      { id: '울릉도', loc: '화상회의실' },
      { id: '스튜디오', loc: '진실의방' },
    ],
  },
  {
    label: '5F', project: '1555837', // [공유] 회의실 예약 - 5F
    rooms: [
      { id: 'N', loc: '뉴욕 · 입구(좌)' },
      { id: 'F', loc: '프랑크푸르트 · 입구(우)' },
      { id: 'FG', loc: '플레이 그라운드' },
      { id: '510 스튜디오', loc: '' },
    ],
  },
];

/* 샘플 이벤트 (키 없을 때 데모) — 층별 */
const SAMPLE_EVENTS = {
  '14F': [
    { room: '서울', title: '현대차 모바일 리뷰', s: 630, e: 750 },
    { room: '서울', title: '업데이트 관리회의', s: 840, e: 900 },
    { room: '샌프란', title: '에스오일 PM', s: 840, e: 900 },
    { room: '런던', title: 'AI X PM3', s: 660, e: 720 },
    { room: '도쿄', title: '회의실 이용', s: 780, e: 840 },
    { room: '독도', title: '화상 스탠드업', s: 600, e: 630 },
  ],
  '5F': [
    { room: 'N', title: '브랜드 기획 미팅', s: 840, e: 960 },
    { room: 'F', title: '채용 인터뷰', s: 600, e: 660 },
    { room: 'FG', title: '외부 파트너 미팅', s: 780, e: 900 },
  ],
};
function sampleByFloor() {
  const out = {};
  FLOORS.forEach((f) => { out[f.label] = (SAMPLE_EVENTS[f.label] || []).slice(); });
  return out;
}

/* ============================================================
 * 플로우 REST 직접 호출 (브라우저)
 * ============================================================ */
const AUTH_CANDS = [
  { h: 'Authorization', v: (k) => 'Bearer ' + k },
  { h: 'Authorization', v: (k) => k },
  { h: 'api-key', v: (k) => k },
  { h: 'x-api-key', v: (k) => k },
];
let authIdx = parseInt(localStorage.getItem('mr_authIdx') || '-1', 10);

async function flowFetch(method, path, body) {
  const url = LS.base.replace(/\/$/, '') + path;
  const tryScheme = async (cand) => {
    const headers = { Accept: 'application/json' };
    headers[cand.h] = cand.v(LS.key);
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };
  if (authIdx >= 0) return tryScheme(AUTH_CANDS[authIdx]);
  let last = null;
  for (let i = 0; i < AUTH_CANDS.length; i++) {
    const r = await tryScheme(AUTH_CANDS[i]);
    last = r;
    if (r.status !== 401 && r.status !== 403) { authIdx = i; localStorage.setItem('mr_authIdx', String(i)); return r; }
  }
  return last;
}

function ymdRange(centerYmd, backDays, fwdDays) {
  const y = +centerYmd.slice(0, 4), m = +centerYmd.slice(4, 6), d = +centerYmd.slice(6, 8);
  const f = new Date(y, m - 1, d - backDays), t = new Date(y, m - 1, d + fwdDays);
  const fmt = (x) => `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}`;
  return [fmt(f) + '000000', fmt(t) + '235959'];
}
function parseBracket(name) {
  const mm = /^\s*\[([^\]]+)\]\s*(.*)$/.exec(name || '');
  return mm ? { room: mm[1].trim(), title: mm[2].trim() } : { room: null, title: (name || '').trim() };
}

// 하루치 이벤트를 층(label)별로 묶어 반환 { '14F':[{room,title,s,e}], '5F':[...] }
async function listEventsByFloor(ymd) {
  const out = {};
  FLOORS.forEach((f) => { out[f.label] = []; });
  if (mode() === 'sample') return sampleByFloor();
  const r = await flowFetch('GET', `/calendars/events?startDateTime=${ymd}000000&endDateTime=${ymd}235959&pageSize=200`);
  if (!r || r.status >= 400 || !r.json) throw new Error('events ' + (r ? r.status : 'network'));
  const labelOf = {};
  FLOORS.forEach((f) => { labelOf[String(f.project)] = f.label; });
  for (const ev of (r.json.events || [])) {
    const label = labelOf[String(ev.colaboSrno || '')];
    if (!label) continue;
    if ((ev.eventStartDateTime || '').slice(0, 8) !== ymd) continue;
    const { room, title } = parseBracket(ev.eventName);
    if (!room) continue;
    out[label].push({ room, title, s: hm2m(ev.eventStartDateTime.slice(8)), e: hm2m(ev.eventFinishDateTime.slice(8)) });
  }
  return out;
}

/* ============================================================
 * 구성원(임직원) 조회 — 참석자 자동완성용
 *   GET /user/employees  → { employees:[{userId, fullname, divisionName, responsibility, email}], hasNext, lastCursor }
 * ============================================================ */
let _employees = null;      // 캐시
let _employeesLoading = null;
async function loadEmployees() {
  if (_employees) return _employees;
  if (mode() === 'sample') { _employees = SAMPLE_EMPLOYEES.slice(); return _employees; }
  if (_employeesLoading) return _employeesLoading;
  _employeesLoading = (async () => {
    const out = [];
    let cursor = null;
    for (let i = 0; i < 6; i++) {
      const q = '/employees?pageSize=100' + (cursor ? `&cursor=${cursor}` : '');
      const r = await flowFetch('GET', q);
      if (!r || r.status >= 400 || !r.json) break;
      const list = r.json.employees || r.json.list || [];
      out.push(...list);
      if (!r.json.hasNext) break;
      cursor = r.json.lastCursor;
      if (cursor == null || String(cursor) === '-1') break;
    }
    _employees = out.length ? out : SAMPLE_EMPLOYEES.slice();
    return _employees;
  })();
  return _employeesLoading;
}
const SAMPLE_EMPLOYEES = [
  { userId: 'desk383', fullname: 'June Lee(이학준)', divisionName: 'HQ', responsibility: '대표이사' },
  { userId: 'kyo890823', fullname: '박병교', divisionName: 'Market Insight팀', responsibility: '팀장' },
  { userId: 'minkyu0610', fullname: '김민규', divisionName: 'PM2팀', responsibility: '책임' },
  { userId: 'purple_mkt', fullname: '장아람', divisionName: '전략마케팅실', responsibility: '실장' },
  { userId: 'greenjkw', fullname: '주광욱', divisionName: '연구개발본부', responsibility: 'CTO / 부대표' },
  { userId: 'yuri11', fullname: '김유리', divisionName: 'PM3팀', responsibility: '책임' },
  { userId: 'juchan94', fullname: '김주찬', divisionName: 'PM2팀', responsibility: '팀장' },
];

// 층(프로젝트)에 해당하는 편집 가능한 calendarSrno 역매핑
async function resolveCalendarSrno(floor) {
  if (LS.cal) return LS.cal;
  const r = await flowFetch('GET', '/calendars');
  const j = (r && r.json) || {};
  const all = [...(j.editableCalendars || []), ...(j.projectCalendars || [])];
  const byProj = all.find((c) => String(c.colaboSrno || '') === String(floor.project) && /ADMIN|EDIT/i.test(c.userPermission || 'EDIT'));
  if (byProj) return byProj.calendarSrno;
  const ed = j.editableCalendars || [];
  const pick = ed.find((c) => new RegExp(floor.label, 'i').test(c.customCalendarName || c.calendarName || '')) ||
    ed.find((c) => /회의실|room/i.test(c.customCalendarName || c.calendarName || '')) || ed[0];
  return pick ? pick.calendarSrno : '';
}

async function createBooking(p) {
  if (mode() === 'sample') { await sleep(700); return { ok: true, demo: true }; }
  const calendarSrno = await resolveCalendarSrno(p.floor);
  if (!calendarSrno) throw new Error('편집 가능한 회의실 캘린더를 찾지 못했습니다. API 키에 해당 캘린더 편집 권한이 필요합니다.');
  const ymd = p.date;
  const names = p.attendees.map((a) => a.name);
  const withId = p.attendees.filter((a) => a.userId).map((a) => ({ userId: a.userId }));
  const base = {
    calendarSrno: String(calendarSrno),
    eventName: `[${p.room}] ${p.meeting}`,
    eventBody: names.length ? `참석자: ${names.join(', ')}` : '',
    allDayYn: 'N', gmtTime: 'GMT+09:00', timezone: 'Asia/Seoul', publicYn: 'Y', publicNameYn: 'Y',
    eventStartTimestamp: ymd + m2hm(p.start) + '00',
    eventFinishTimestamp: ymd + m2hm(p.end) + '00',
  };
  // 참석자를 정식 attendances 로 첨부 시도, 실패(400)하면 본문 기록만으로 재시도
  let r = await flowFetch('POST', '/calendars/events', withId.length ? { ...base, attendances: withId } : base);
  if (r && r.status === 400 && withId.length) {
    r = await flowFetch('POST', '/calendars/events', base);
  }
  if (!r || r.status >= 400) throw new Error('예약 생성 실패 (' + (r ? r.status : 'network') + ')');
  return { ok: true };
}

/* ============================================================
 * 유틸
 * ============================================================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hm2m(hhmmss) { return +hhmmss.slice(0, 2) * 60 + +hhmmss.slice(2, 4); }
function m2hm(m) { return pad(Math.floor(m / 60)) + pad(m % 60); }
function m2label(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  const ap = h < 12 ? '오전' : '오후';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${ap} ${h12}:${pad(mm)}`;
}
function slotLabel(m) { const h = Math.floor(m / 60); let h12 = h % 12 || 12; return `${h12}:${pad(m % 60)}`; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toast(msg, kind) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (kind ? ' ' + kind : ''); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3200);
}

/* ============================================================
 * 상태
 * ============================================================ */
const today = new Date();
const S = {
  step: 1,
  viewY: today.getFullYear(), viewM: today.getMonth(), // 캘린더 표시 월
  date: null,        // 'YYYYMMDD'
  start: null,       // 분
  duration: null,    // 분
  room: null,        // 선택 회의실 id
  roomFloor: null,   // 선택 회의실이 속한 층(FLOORS 항목)
  meeting: '', attendees: [],
  booking: false,
};
function endMin() { return S.start != null && S.duration != null ? S.start + S.duration : null; }

/* ============================================================
 * STEP 1 — 캘린더 + 시간
 * ============================================================ */
function renderCalendar() {
  const cal = $('#calendar');
  const first = new Date(S.viewY, S.viewM, 1);
  const startDow = first.getDay();
  const days = new Date(S.viewY, S.viewM + 1, 0).getDate();
  const tISO = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
  const dows = ['일', '월', '화', '수', '목', '금', '토'];
  let html = `<div class="cal-head">
    <button id="calPrev" aria-label="이전 달">‹</button>
    <div class="m">${S.viewY}년 ${S.viewM + 1}월</div>
    <div style="display:flex;gap:6px"><button class="today" id="calToday">오늘</button><button id="calNext" aria-label="다음 달">›</button></div>
  </div><div class="cal-grid">`;
  dows.forEach((d, i) => html += `<div class="cal-dow${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${d}</div>`);
  for (let i = 0; i < startDow; i++) html += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= days; d++) {
    const ymd = `${S.viewY}${pad(S.viewM + 1)}${pad(d)}`;
    const dow = (startDow + d - 1) % 7;
    const past = ymd < tISO;
    const cls = ['cal-cell'];
    if (dow === 0) cls.push('sun'); if (dow === 6) cls.push('sat');
    if (past) cls.push('past');
    if (ymd === tISO) cls.push('today-mark');
    if (ymd === S.date) cls.push('sel');
    html += `<div class="${cls.join(' ')}" data-ymd="${ymd}" ${past ? '' : 'data-pick="1"'}>${d}</div>`;
  }
  html += `</div>`;
  cal.innerHTML = html;
  $('#calPrev').onclick = () => { if (S.viewM === 0) { S.viewM = 11; S.viewY--; } else S.viewM--; renderCalendar(); };
  $('#calNext').onclick = () => { if (S.viewM === 11) { S.viewM = 0; S.viewY++; } else S.viewM++; renderCalendar(); };
  $('#calToday').onclick = () => { S.viewY = today.getFullYear(); S.viewM = today.getMonth(); renderCalendar(); };
  cal.querySelectorAll('[data-pick]').forEach((el) => el.onclick = () => {
    S.date = el.dataset.ymd; renderCalendar(); syncStep1(); updateHead();
  });
}
function renderSlots() {
  const am = $('#slotsAM'), pm = $('#slotsPM');
  am.innerHTML = ''; pm.innerHTML = '';
  for (let m = 8 * 60; m <= 21 * 60 + 30; m += 30) {
    const b = document.createElement('button');
    b.textContent = slotLabel(m);
    b.className = S.start === m ? 'on' : '';
    b.onclick = () => { S.start = m; renderSlots(); syncStep1(); updateHead(); };
    (m < 12 * 60 ? am : pm).appendChild(b);
  }
}
function renderDurChips() {
  $$('#durChips button').forEach((b) => {
    b.classList.toggle('on', S.duration === +b.dataset.min);
    b.onclick = () => { S.duration = +b.dataset.min; renderDurChips(); syncStep1(); updateHead(); };
  });
}
function syncStep1() {
  const ok = S.date && S.start != null && S.duration != null;
  $('#nextBtn').disabled = !ok;
}

/* ============================================================
 * STEP 2 — 회의실 추천
 * ============================================================ */
function roomCard(r, floor) {
  const sel = S.room === r.id && S.roomFloor && S.roomFloor.label === floor.label;
  const el = document.createElement('div');
  el.className = 'room ' + (r.available ? 'available' : 'busy') + (sel && r.available ? ' sel' : '');
  const loc = r.loc ? `<span class="r-loc">${esc(r.loc)}</span>` : '';
  if (r.available) {
    el.innerHTML = `<div class="r-top"><span class="r-name">${esc(r.id)}</span>${loc}` +
      `${sel ? '<i class="ti ti-circle-check-filled r-check"></i>' : ''}</div>` +
      `<div class="r-status">예약 가능</div>`;
    el.onclick = () => { S.room = r.id; S.roomFloor = floor; updateHead(); loadStep2(); };
  } else {
    const c = r.conflict;
    el.innerHTML = `<div class="r-top"><span class="r-name">${esc(r.id)}</span>${loc}</div>` +
      `<div class="r-status"><span class="r-conflict"><i class="ti ti-lock"></i> ${esc(c.title || '사용 중')} · ${slotLabel(c.s)}–${slotLabel(c.e)}</span></div>`;
  }
  return el;
}

async function loadStep2() {
  const box = $('#rooms');
  box.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:20px 0">불러오는 중…</div>`;
  let byFloor;
  try {
    byFloor = await listEventsByFloor(S.date);
  } catch (e) {
    toast('실데이터를 불러오지 못해 샘플로 표시합니다. 설정에서 키/CORS 확인.', 'err');
    byFloor = sampleByFloor();
  }
  const st = S.start, en = endMin();
  let total = 0;
  box.innerHTML = '';
  FLOORS.forEach((floor) => {
    const events = byFloor[floor.label] || [];
    const withStatus = floor.rooms.map((r) => {
      const conflicts = events.filter((e) => e.room === r.id && st < e.e && e.s < en).sort((a, b) => a.s - b.s);
      return { ...r, available: conflicts.length === 0, conflict: conflicts[0] || null };
    }).sort((a, b) => (a.available === b.available) ? 0 : a.available ? -1 : 1);
    const availN = withStatus.filter((r) => r.available).length;
    total += availN;

    const group = document.createElement('div');
    group.className = 'room-group';
    group.innerHTML = `<div class="room-group-head"><span class="badge-floor">${esc(floor.label)}</span>` +
      `<span class="cnt">예약 가능 ${availN} / ${floor.rooms.length}곳</span></div>`;
    const list = document.createElement('div');
    list.className = 'rooms';
    withStatus.forEach((r) => list.appendChild(roomCard(r, floor)));
    group.appendChild(list);
    box.appendChild(group);
  });
  $('#step2Sub').innerHTML = `${labelDate(S.date)} · <b>${m2label(st)} ~ ${m2label(en)}</b> · 전체 예약 가능 <b style="color:var(--accent)">${total}</b>곳`;
  $('#nextBtn').disabled = !(S.room && S.roomFloor);
}

/* ============================================================
 * STEP 3 — 상세
 * ============================================================ */
let _attHi = -1; // 자동완성 하이라이트 인덱스
function bindStep3() {
  const meet = $('#fMeeting'), att = $('#fAttendee');
  meet.value = S.meeting;
  const preview = () => {
    $('#titlePreview').innerHTML = meet.value.trim()
      ? `<span>[${esc(S.room)}] ${esc(meet.value.trim())}</span>` : '';
    syncStep3();
  };
  meet.oninput = () => { S.meeting = meet.value; preview(); };

  loadEmployees(); // 미리 불러오기
  att.oninput = () => renderSuggest(att.value.trim());
  att.onfocus = () => renderSuggest(att.value.trim());
  att.onkeydown = (e) => {
    const items = [...$('#attSuggest').querySelectorAll('button')];
    if (e.key === 'ArrowDown') { e.preventDefault(); _attHi = Math.min(_attHi + 1, items.length - 1); paintHi(items); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _attHi = Math.max(_attHi - 1, 0); paintHi(items); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[_attHi]) items[_attHi].click();
      else if (att.value.trim()) { addAttendee({ name: att.value.trim() }); }
    } else if (e.key === 'Backspace' && !att.value && S.attendees.length) {
      S.attendees.pop(); renderAttendees();
    } else if (e.key === 'Escape') { hideSuggest(); }
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('.attendee-wrap')) hideSuggest(); });
  preview(); renderAttendees();
}
function hideSuggest() { $('#attSuggest').hidden = true; _attHi = -1; }
function paintHi(items) { items.forEach((b, i) => b.classList.toggle('hi', i === _attHi)); }
async function renderSuggest(q) {
  const box = $('#attSuggest');
  const emps = await loadEmployees();
  const chosen = new Set(S.attendees.map((a) => a.userId).filter(Boolean));
  const ql = q.toLowerCase();
  const matches = emps
    .filter((e) => !chosen.has(e.userId))
    .filter((e) => !ql || (e.fullname || '').toLowerCase().includes(ql) || (e.divisionName || '').toLowerCase().includes(ql))
    .slice(0, 8);
  _attHi = -1;
  if (!q && !matches.length) { hideSuggest(); return; }
  box.hidden = false;
  if (!matches.length) { box.innerHTML = `<div class="empty-hint">일치하는 구성원이 없어요. Enter로 “${esc(q)}” 직접 추가</div>`; return; }
  box.innerHTML = '';
  matches.forEach((e) => {
    const b = document.createElement('button');
    b.type = 'button';
    const initials = (e.fullname || '?').replace(/\(.*\)/, '').trim().slice(0, 2);
    b.innerHTML = `<span class="av">${esc(initials)}</span><span><span class="nm">${esc(e.fullname)}</span>` +
      `<span class="dv"> ${esc([e.divisionName, e.responsibility].filter(Boolean).join(' · '))}</span></span>`;
    b.onclick = () => addAttendee({ userId: e.userId, name: e.fullname, email: e.email });
    box.appendChild(b);
  });
}
function addAttendee(a) {
  if (a.userId && S.attendees.some((x) => x.userId === a.userId)) return;
  S.attendees.push(a);
  $('#fAttendee').value = '';
  hideSuggest();
  renderAttendees();
}
function renderAttendees() {
  const box = $('#attendeeBox'), input = $('#fAttendee');
  box.querySelectorAll('.att-chip').forEach((c) => c.remove());
  S.attendees.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'att-chip';
    chip.innerHTML = `${esc(a.name)} <i class="ti ti-x"></i>`;
    chip.querySelector('i').onclick = () => { S.attendees.splice(i, 1); renderAttendees(); };
    box.insertBefore(chip, input);
  });
  $('#attendeeCount').textContent = `${S.attendees.length}명 선택됨`;
}
function syncStep3() {
  $('#nextBtn').disabled = !S.meeting.trim();
}

/* ============================================================
 * STEP 4 — 확인
 * ============================================================ */
function renderSummary() {
  const rows = [
    ['회의명', `<span class="tag">[${esc(S.room)}]</span> ${esc(S.meeting)}`],
    ['날짜', labelDate(S.date)],
    ['시간', `${m2label(S.start)} ~ ${m2label(endMin())}`],
    ['회의실', `${esc(S.room)}${S.roomFloor ? ` <span style="color:var(--muted)">· ${esc(S.roomFloor.label)} ${esc(S.roomFloor.rooms.find((r) => r.id === S.room)?.loc || '')}</span>` : ''}`],
    ['참석자', S.attendees.length ? esc(S.attendees.map((a) => a.name).join(', ')) : '-'],
  ];
  $('#summary').innerHTML = rows.map(([k, v]) => `<div class="row"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  $('#confirmNote').innerHTML = mode() === 'direct'
    ? '<i class="ti ti-cloud-check"></i> 예약을 확정하면 플로우 회의실 캘린더에 일정이 생성됩니다.'
    : '';
}

// 방문/사용 분석 이벤트 (GA4 설정 시에만 전송)
function track(name, params) {
  if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
}

/* ============================================================
 * 네비게이션
 * ============================================================ */
function labelDate(ymd) {
  if (!ymd) return '';
  const d = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
  const dow = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)} (${dow})`;
}
function updateHead() {
  const parts = [];
  if (S.date) parts.push(labelDate(S.date));
  if (S.start != null) parts.push(m2label(S.start) + (S.duration ? ` · ${S.duration >= 60 ? (S.duration / 60) + '시간' : S.duration + '분'}` : ''));
  if (S.room) parts.push(`[${S.room}]` + (S.roomFloor ? ` ${S.roomFloor.label}` : ''));
  $('#headSummary').textContent = parts.join('   ·   ');
}
function showStep(n) {
  S.step = n;
  $$('.step').forEach((el) => el.hidden = +el.dataset.step !== n);
  $$('#steps li').forEach((li) => {
    const s = +li.dataset.step;
    li.classList.toggle('active', s === n);
    li.classList.toggle('done', s < n);
  });
  $('#prevBtn').hidden = n === 1;
  $('#nextBtn').hidden = n === 4;
  $('#confirmBtn').hidden = n !== 4;
  // 각 스텝 진입 시 유효성/렌더
  if (n === 1) { syncStep1(); }
  if (n === 2) { loadStep2(); }
  if (n === 3) { bindStep3(); syncStep3(); }
  if (n === 4) { renderSummary(); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function next() {
  if (S.step === 1) return showStep(2);
  if (S.step === 2) return showStep(3);
  if (S.step === 3) return showStep(4);
}
function prev() { if (S.step > 1) showStep(S.step - 1); }

async function confirmBooking() {
  if (S.booking) return;
  S.booking = true;
  const btn = $('#confirmBtn');
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2 spin"></i> 예약 중…';
  try {
    await createBooking({
      date: S.date, start: S.start, end: endMin(), room: S.room, floor: S.roomFloor,
      meeting: S.meeting.trim(), attendees: S.attendees,
    });
    track('booking_confirmed', { floor: S.roomFloor ? S.roomFloor.label : '', room: S.room, live: mode() === 'direct' ? 1 : 0 });
    toast(`✓ [${S.room}] ${S.meeting.trim()} 예약 완료`, 'ok');
    resetWizard();
  } catch (e) {
    toast(e.message || '예약 실패', 'err');
    btn.disabled = false; btn.innerHTML = '<i class="ti ti-headphones"></i> 예약 확정';
  }
  S.booking = false;
}
function resetWizard() {
  Object.assign(S, { date: null, start: null, duration: null, room: null, roomFloor: null, meeting: '', attendees: [] });
  $('#confirmBtn').disabled = false; $('#confirmBtn').innerHTML = '<i class="ti ti-headphones"></i> 예약 확정';
  renderCalendar(); renderSlots(); renderDurChips(); updateHead();
  showStep(1);
}

/* ============================================================
 * 설정 모달
 * ============================================================ */
function openSettings() {
  $('#sApiKey').value = LS.key; $('#sApiBase').value = LS.base;
  $('#settingsStatus').textContent = ''; $('#settingsStatus').className = 'settings-status';
  renderRoomReg();
  $('#settingsModal').hidden = false;
}
function renderRoomReg() {
  const box = $('#roomReg');
  box.innerHTML = FLOORS.map((f) =>
    `<div class="rr-floor">${f.label} · 회의실 ${f.rooms.length}곳</div>` +
    f.rooms.map((r) =>
      `<div class="rr-item"><span class="rr-id"><span class="br">[</span>${esc(r.id)}<span class="br">]</span></span>` +
      `<span class="rr-loc">${esc(r.loc || '')}</span>` +
      (r.zone ? `<span class="rr-zone">${esc(r.zone)}</span>` : '') + `</div>`
    ).join('')
  ).join('');
}
async function testConn() {
  const st = $('#settingsStatus');
  const key = $('#sApiKey').value.trim();
  if (!key) { st.className = 'settings-status'; st.textContent = '키가 없으면 샘플 데모로 동작합니다.'; return; }
  st.className = 'settings-status'; st.textContent = '연결 확인 중…';
  const prevKey = LS.key, prevBase = LS.base; LS.key = key; LS.base = $('#sApiBase').value.trim() || 'https://api.flow.team/v1';
  authIdx = -1; localStorage.removeItem('mr_authIdx');
  try {
    const r = await flowFetch('GET', '/calendars');
    if (r && r.status < 400) { st.className = 'settings-status ok'; st.textContent = '✓ 연결 성공'; }
    else { st.className = 'settings-status bad'; st.textContent = `연결 실패 (HTTP ${r ? r.status : '?'}). 키를 확인하세요.`; }
  } catch (e) {
    st.className = 'settings-status bad';
    st.textContent = '요청 차단됨 — 브라우저 CORS 정책일 수 있습니다. 로컬 server.py 프록시 사용을 권장합니다.';
  }
  LS.key = prevKey; LS.base = prevBase;
}
function saveSettings() {
  LS.key = $('#sApiKey').value.trim();
  LS.base = $('#sApiBase').value.trim();
  _employees = null; _employeesLoading = null; // 키 바뀌면 구성원 캐시 무효화
  authIdx = -1; localStorage.removeItem('mr_authIdx');
  $('#settingsModal').hidden = true;
  updateModeBadge();
  toast(mode() === 'direct' ? '실데이터 모드로 저장됨' : '샘플 데모 모드', 'ok');
  if (S.step === 2) loadStep2();
}
function updateModeBadge() {
  $('#modeBadge').innerHTML = mode() === 'direct'
    ? '연결: <b>플로우 실데이터</b>' : '연결: <b>샘플 데모</b>';
}

/* ============================================================
 * 초기화
 * ============================================================ */
function init() {
  renderCalendar(); renderSlots(); renderDurChips(); updateHead(); updateModeBadge();
  $('#nextBtn').onclick = next;
  $('#prevBtn').onclick = prev;
  $('#confirmBtn').onclick = confirmBooking;
  $('#openSettings').onclick = openSettings;
  $('#closeSettings').onclick = () => ($('#settingsModal').hidden = true);
  $('#settingsModal').onclick = (e) => { if (e.target.id === 'settingsModal') $('#settingsModal').hidden = true; };
  $('#testConn').onclick = testConn;
  $('#saveSettings').onclick = saveSettings;
  $('#clearKey').onclick = () => { $('#sApiKey').value = ''; };
  showStep(1);
}
init();
