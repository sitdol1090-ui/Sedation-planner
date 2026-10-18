'use strict';
/*
  진정 설계판 — 계산 엔진과 화면
  의학 데이터는 전부 data/*.json 에 있습니다. 이 파일은 보통 수정할 필요가 없습니다.
  가중치(WEIGHTS)와 요구도 환산(NEED)은 추천 점수의 민감도를 바꿀 때만 조정하세요.
*/

const DATA_FILES = {
  drugs: 'data/drugs.json',
  procedures: 'data/procedures.json',
  flags: 'data/flags.json',
  scoring: 'data/scoring.json',
  interactions: 'data/interactions.json',
  pearls: 'data/pearls.json',
  evidence: 'data/evidence.json'
};

const WEIGHTS = {
  depth: 18,            // 진정 깊이 1단위 부족당 감점
  analg: 18,            // 진통 1단위 부족당 감점
  airway: 12,           // 기도 보존 1단위 부족당 감점
  durBase: 10, durPerMin: 0.15, durMax: 25,  // 지속시간 부족
  extraDrug: 4,         // 약물 하나 추가될 때마다 감점
  slowRecov: 8,         // 짧은 시술(≤20분)인데 회복이 매우 김
  slowOnset: 8,         // 짧은 시술(≤15분)인데 onset ≥20분
  comboDepthBonus: 0.3, // 진정제 2개 병용 시 깊이 가산
  respSynergy: 0.6      // 호흡억제 약 추가 1개당 기도 보존 차감
};
const NEED = { depth: [0.5, 1.5, 2.5, 3.2], analg: [0, 1, 2.5, 3.5] };
const M_LBL = ['없음', '약간', '대부분', '꼭 멈춤'];
const P_LBL = ['없음', '경미', '중등도', '심함'];
const UNITS = ['mg/kg', 'mcg/kg', 'mcg/kg/min', 'mcg/kg/h'];
const COND_KEYS = ['mode', 'drugsAll', 'drugsAny', 'lacksDrugs', 'flags', 'procAny', 'routes', 'ageBelow', 'ageAtLeast',
  'minDrugs', 'sedCountAtLeast', 'respCountAtLeast', 'minM', 'minP', 'minT', 'maxT', 'sharedAirway', 'airwayBelow',
  'otherDepthBelow', 'anyOf'];

let DB = null, D = {};
const S = { mode: 'ped', age: 4, wt: 16, wtAuto: true, proc: 'mri', m: 3, p: 0, T: 40, a: 0, flags: new Set(), sel: {}, evAll: false };
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => n >= 100 ? String(Math.round(n)) : n >= 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n * 100) / 100);

/* ---------------- data loading & validation ---------------- */
async function loadAll() {
  const out = {}, errs = [];
  await Promise.all(Object.entries(DATA_FILES).map(async ([k, url]) => {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error('파일을 찾을 수 없음 (HTTP ' + r.status + ')');
      const txt = await r.text();
      try { out[k] = JSON.parse(txt); }
      catch (e) { throw new Error('JSON 문법 오류 — 쉼표, 따옴표, 괄호를 확인하세요. (' + e.message + ')'); }
    } catch (e) { errs.push({ file: url, msg: e.message }); }
  }));
  return { out, errs };
}
function validate(db, errs) {
  const err = (file, msg) => errs.push({ file, msg });
  if (!Array.isArray(db.drugs)) { if (db.drugs) err('data/drugs.json', '맨 바깥이 [ ] 배열이어야 합니다.'); db.drugs = []; }
  const ids = new Set();
  db.drugs = db.drugs.filter((d, i) => {
    const where = `${i + 1}번째 약물${d && d.id ? ` (${d.id})` : ''}`;
    if (!d || !d.id || !d.ko || !d.en) { err('data/drugs.json', `${where}: id, ko, en 이 필요합니다.`); return false; }
    if (ids.has(d.id)) { err('data/drugs.json', `${where}: id가 중복됩니다.`); return false; }
    if (!d.props || ['depth', 'analg', 'airway', 'recov'].some(k => typeof d.props[k] !== 'number')) { err('data/drugs.json', `${where}: props에 depth, analg, airway, recov 숫자가 필요합니다.`); return false; }
    if (!d.routes || typeof d.routes !== 'object') { err('data/drugs.json', `${where}: routes가 없습니다.`); return false; }
    for (const [mode, rs] of Object.entries(d.routes)) {
      for (const [rk, r] of Object.entries(rs || {})) {
        const w2 = `${where} ${mode}.${rk}`;
        if (['onset', 'dur', 'rec', 'os'].some(k => typeof r[k] !== 'number')) { err('data/drugs.json', `${w2}: onset, dur, rec, os 숫자가 필요합니다.`); delete rs[rk]; continue; }
        if (!Array.isArray(r.dose) || !r.dose.length) { err('data/drugs.json', `${w2}: dose 목록이 필요합니다.`); delete rs[rk]; continue; }
        r.dose = r.dose.filter(x => {
          if (!Array.isArray(x.r) || x.r.length !== 2 || x.r.some(v => typeof v !== 'number')) { err('data/drugs.json', `${w2} "${x.t || ''}": r 은 [최소, 최대] 숫자 두 개여야 합니다.`); return false; }
          if (!UNITS.includes(x.u)) { err('data/drugs.json', `${w2} "${x.t || ''}": 단위 "${x.u}"는 지원하지 않습니다. (${UNITS.join(', ')})`); return false; }
          return true;
        });
      }
    }
    ids.add(d.id);
    return true;
  });
  if (!db.procedures || !Array.isArray(db.procedures.ped) || !Array.isArray(db.procedures.adult)) {
    if (db.procedures) err('data/procedures.json', '"ped"와 "adult" 목록이 모두 필요합니다.');
    db.procedures = { ped: [{ id: 'none', n: '시술 없음', m: 1, p: 0, T: 20, a: 0, tags: [] }], adult: [{ id: 'none', n: '시술 없음', m: 1, p: 0, T: 20, a: 0, tags: [] }] };
  }
  ['ped', 'adult'].forEach(md => db.procedures[md].forEach(p => { p.tags = p.tags || []; ['m', 'p', 'T'].forEach(k => { if (typeof p[k] !== 'number') err('data/procedures.json', `${p.n || p.id}: ${k} 값이 숫자가 아닙니다.`); }); }));
  if (!Array.isArray(db.flags)) db.flags = [];
  const checkWhen = (file, label, w) => {
    if (!w) return;
    Object.keys(w).forEach(k => { if (!COND_KEYS.includes(k)) err(file, `${label}: 알 수 없는 조건 "${k}"`); });
    ['drugsAll', 'drugsAny', 'lacksDrugs'].forEach(k => (w[k] || []).forEach(id => { if (!ids.has(id)) err(file, `${label}: 약물 id "${id}"가 drugs.json에 없습니다.`); }));
    (w.anyOf || []).forEach(x => checkWhen(file, label, x));
  };
  ['scoring', 'interactions', 'pearls'].forEach(k => {
    const file = DATA_FILES[k];
    if (!Array.isArray(db[k])) { if (db[k]) err(file, '맨 바깥이 [ ] 배열이어야 합니다.'); db[k] = []; }
    db[k].forEach((r, i) => checkWhen(file, r.id || `${i + 1}번째 항목`, r.when));
  });
  if (!db.evidence || !Array.isArray(db.evidence.items)) { if (db.evidence) err('data/evidence.json', '"items" 목록이 필요합니다.'); db.evidence = { items: [] }; }
  db.evidence.items = db.evidence.items.filter((e, i) => {
    if (!e.title || !Array.isArray(e.mode)) { err('data/evidence.json', `${i + 1}번째 논문: title과 mode 목록이 필요합니다.`); return false; }
    e.tags = e.tags || []; e.status = e.status || 'approved';
    return true;
  });
}
function showErrors(errs) {
  const b = $('banner');
  if (!errs.length) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `<b>데이터 파일에 문제가 있어 일부 항목을 건너뛰었습니다.</b> 아래 위치를 고치면 자동으로 반영됩니다.
    <ul>${errs.map(e => `<li><code>${esc(e.file)}</code> — ${esc(e.msg)}</li>`).join('')}</ul>`;
}

/* ---------------- helpers ---------------- */
const routesOf = id => Object.keys((D[id] && D[id].routes[S.mode]) || {});
const R = (id, rt) => D[id].routes[S.mode][rt];
const avail = () => DB.drugs.filter(d => routesOf(d.id).length && !(d.pedOnly && S.mode !== 'ped'));
const curProc = () => DB.procedures[S.mode].find(p => p.id === S.proc) || DB.procedures[S.mode][0] || { tags: [] };
function estWt(a) {
  if (S.mode === 'adult') return 65;
  if (a < 1) return Math.round((a * 12 + 9) / 2 * 10) / 10;
  if (a <= 10) return Math.round(a * 2 + 8);
  return Math.round(a * 3 + 7);
}

/* ---------------- condition matching ---------------- */
function ctxOf(items, cov) {
  const ids = items.map(i => i.id);
  return {
    mode: S.mode, age: S.age, ids, routes: Object.fromEntries(items.map(i => [i.id, i.rt])), flags: S.flags, proc: curProc(),
    m: S.m, p: S.p, T: S.T, a: !!S.a,
    sedN: items.filter(i => D[i.id].kind === 'sed').length,
    respN: items.filter(i => D[i.id].resp).length,
    cov
  };
}
function match(w, c) {
  if (!w) return true;
  if (w.anyOf && !w.anyOf.some(x => match(x, c))) return false;
  if (w.mode && w.mode !== c.mode) return false;
  if (w.drugsAll && !w.drugsAll.every(d => c.ids.includes(d))) return false;
  if (w.drugsAny && !w.drugsAny.some(d => c.ids.includes(d))) return false;
  if (w.lacksDrugs && w.lacksDrugs.some(d => c.ids.includes(d))) return false;
  if (w.flags && !w.flags.every(f => c.flags.has(f))) return false;
  if (w.procAny && !w.procAny.some(t => c.proc.id === t || c.proc.tags.includes(t))) return false;
  if (w.routes && !Object.entries(w.routes).every(([id, rt]) => c.routes[id] === rt)) return false;
  if (w.ageBelow != null && !(c.age < w.ageBelow)) return false;
  if (w.ageAtLeast != null && !(c.age >= w.ageAtLeast)) return false;
  if (w.minDrugs != null && !(c.ids.length >= w.minDrugs)) return false;
  if (w.sedCountAtLeast != null && !(c.sedN >= w.sedCountAtLeast)) return false;
  if (w.respCountAtLeast != null && !(c.respN >= w.respCountAtLeast)) return false;
  if (w.minM != null && !(c.m >= w.minM)) return false;
  if (w.minP != null && !(c.p >= w.minP)) return false;
  if (w.minT != null && !(c.T >= w.minT)) return false;
  if (w.maxT != null && !(c.T <= w.maxT)) return false;
  if (w.sharedAirway != null && c.a !== !!w.sharedAirway) return false;
  if (w.airwayBelow != null && !(c.cov && c.cov.airway < w.airwayBelow)) return false;
  if (w.otherDepthBelow) {
    const { drug, depth } = w.otherDepthBelow;
    if (c.ids.some(id => id !== drug && D[id].props.depth >= depth)) return false;
  }
  return true;
}

/* ---------------- scoring ---------------- */
function needs() {
  return {
    depth: NEED.depth[S.m],
    analg: NEED.analg[S.p],
    airway: Math.min(4, 1 + (S.a ? 2 : 0) + (S.flags.has('osa') ? 1 : 0) + (S.flags.has('icp') ? 0.8 : 0))
  };
}
function coverage(items) {
  const sedItems = items.filter(i => D[i.id].kind === 'sed');
  const respN = items.filter(i => D[i.id].resp).length;
  const depth = Math.min(4, Math.max(...items.map(i => D[i.id].props.depth)) + (sedItems.length >= 2 ? WEIGHTS.comboDepthBonus : 0));
  const analg = Math.max(...items.map(i => D[i.id].props.analg));
  const airway = Math.max(0, Math.min(...items.map(i => D[i.id].props.airway)) - (respN > 1 ? WEIGHTS.respSynergy * (respN - 1) : 0));
  const recov = Math.min(...items.map(i => D[i.id].props.recov));
  const inf = sedItems.some(i => R(i.id, i.rt).inf);
  const dur = inf ? Infinity : Math.max(...(sedItems.length ? sedItems : items).map(i => R(i.id, i.rt).dur));
  const onset = Math.max(...items.map(i => R(i.id, i.rt).onset));
  return { depth, analg, airway, recov, inf, dur, onset };
}
function evalCombo(items) {
  const N = needs(), cov = coverage(items), pros = [], cons = [], hard = [];
  let s = 100;
  const gD = N.depth - cov.depth, gA = N.analg - cov.analg, gW = N.airway - cov.airway;
  if (gD > 0) { s -= WEIGHTS.depth * gD; cons.push('움직임 요구에 비해 진정 깊이 부족'); } else if (S.m >= 2) pros.push('움직임 멈춤 요구 충족');
  if (gA > 0) { s -= WEIGHTS.analg * gA; cons.push('진통 부족 → 통증 자극 시 체동'); } else if (S.p >= 2) pros.push('통증 요구 충족');
  if (gW > 0) { s -= WEIGHTS.airway * gW; cons.push(S.a ? '숨길 공유 상황에서 기도 보존 약함' : '호흡억제·기도 폐쇄 위험'); } else if (N.airway >= 2.5) pros.push('자발호흡·기도 보존 유리');
  if (cov.dur < S.T) { s -= Math.min(WEIGHTS.durMax, WEIGHTS.durBase + WEIGHTS.durPerMin * (S.T - cov.dur)); cons.push('효과 지속이 시술 시간보다 짧음 → 추가 투여 필요'); }
  else if (S.T >= 40) pros.push(cov.inf ? '지속주입으로 시간 제한 없음' : '시술 시간 동안 효과 유지');
  if (S.T <= 20 && cov.recov <= 1) { s -= WEIGHTS.slowRecov; cons.push('짧은 시술 대비 회복이 김'); }
  if (S.T <= 15 && cov.onset >= 20) { s -= WEIGHTS.slowOnset; cons.push('onset이 느려 짧은 시술에 비효율'); }
  if (cov.recov >= 3.5 && S.T <= 30) pros.push('회복이 빨라 짧은 시술에 적합');
  s -= WEIGHTS.extraDrug * (items.length - 1);
  const ctx = ctxOf(items, cov);
  DB.scoring.forEach(r => {
    if (!match(r.when, ctx)) return;
    s += Number(r.delta) || 0;
    if (r.type === 'pro') pros.push(r.msg); else if (r.type === 'hard') hard.push(r.msg); else cons.push(r.msg);
  });
  return { score: Math.max(0, Math.min(100, Math.round(s))), pros, cons, hard, cov };
}
function recommend() {
  const ds = avail(), cands = [];
  ds.forEach(d => { if (d.kind === 'sed') routesOf(d.id).forEach(rt => cands.push([{ id: d.id, rt }])); });
  for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
    const a = ds[i], b = ds[j];
    if (a.kind !== 'sed' && b.kind !== 'sed') continue;
    routesOf(a.id).forEach(ra => routesOf(b.id).forEach(rb => cands.push([{ id: a.id, rt: ra }, { id: b.id, rt: rb }])));
  }
  const best = {};
  cands.forEach(c => {
    const e = evalCombo(c);
    if (e.hard.length) return;
    const k = c.map(x => x.id).sort().join('+');
    if (!best[k] || best[k].e.score < e.score) best[k] = { c, e };
  });
  return Object.values(best).sort((x, y) => y.e.score - x.e.score || x.c.length - y.c.length).slice(0, 3);
}

/* ---------------- doses ---------------- */
function capOf(dose) {
  if (Array.isArray(dose.capByAge)) { const hit = dose.capByAge.find(x => x.below == null || S.age < x.below); return hit ? hit.cap : undefined; }
  return dose.cap;
}
function doseLine(dose) {
  const w = S.wt, [lo, hi] = dose.r, u = dose.u, cap = capOf(dose);
  let out, capped = false;
  if (u === 'mg/kg' || u === 'mcg/kg') {
    let a = lo * w, b = hi * w;
    if (cap && b > cap) { b = cap; a = Math.min(a, cap); capped = true; }
    out = (a === b ? fmt(a) : fmt(a) + '–' + fmt(b)) + ' ' + (u === 'mg/kg' ? 'mg' : 'mcg');
  } else if (u === 'mcg/kg/min') out = fmt(lo * w * 60 / 1000) + '–' + fmt(hi * w * 60 / 1000) + ' mg/h';
  else out = fmt(lo * w) + '–' + fmt(hi * w) + ' mcg/h';
  const rng = (lo === hi ? lo : lo + '–' + hi) + ' ' + u;
  const elder = S.mode === 'adult' && S.age >= 65;
  return `<span><b>${esc(dose.t)}</b> ${rng}</span><em class="num">→ ${out}</em>`
    + (capped ? `<span class="cap">1회 최대 ${fmt(cap)} ${u.startsWith('mg') ? 'mg' : 'mcg'} 적용</span>` : '')
    + (dose.note ? `<span class="cap">${esc(dose.note)}</span>` : '')
    + (elder ? '<span class="cap">65세 이상: 30–50% 감량, 천천히 적정</span>' : '');
}

/* ---------------- render: top ---------------- */
function lvl(n, max = 3) { return Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}" style="height:${8 + i * 5}px"></i>`).join(''); }
function renderTop() {
  $('m-ped').setAttribute('aria-pressed', S.mode === 'ped'); $('m-adult').setAttribute('aria-pressed', S.mode === 'adult');
  $('age-sub').textContent = S.mode === 'ped' ? (S.age < 2 ? `${Math.round(S.age * 12)}개월` : '') : (S.age >= 65 ? '고령: 감량 기준 적용' : '');
  $('wt-sub').textContent = S.wtAuto ? '나이로 추정' : '직접 입력';
  $('procs').innerHTML = '<span class="lab">시술</span>' + DB.procedures[S.mode].map(p => `<button class="chip" data-proc="${esc(p.id)}" aria-pressed="${p.id === S.proc}">${esc(p.n)}</button>`).join('');
  $('m-val').textContent = M_LBL[S.m]; $('m-lvl').innerHTML = lvl(S.m);
  $('m-steps').innerHTML = M_LBL.map((l, i) => `<button data-m="${i}" aria-pressed="${i === S.m}" aria-label="${l}">${i}</button>`).join('');
  $('p-val').textContent = P_LBL[S.p]; $('p-lvl').innerHTML = lvl(S.p);
  $('p-steps').innerHTML = P_LBL.map((l, i) => `<button data-p="${i}" aria-pressed="${i === S.p}" aria-label="${l}">${i}</button>`).join('');
  $('t-val').textContent = S.T + '분'; $('t-lvl').innerHTML = lvl(S.T <= 15 ? 1 : S.T <= 45 ? 2 : 3); $('t-range').value = S.T;
  $('a-val').textContent = S.a ? '예' : '아니오'; $('a-lvl').innerHTML = lvl(S.a ? 3 : 0);
  $('a-steps').innerHTML = `<button data-a="0" aria-pressed="${!S.a}">아니오</button><button data-a="1" aria-pressed="${!!S.a}">예</button>`;
  $('card-m').classList.toggle('hot', S.m >= 2); $('card-p').classList.toggle('hot', S.p >= 2);
  $('card-t').classList.toggle('hot', S.T >= 40); $('card-a').classList.toggle('hot', !!S.a);
  $('flags').innerHTML = '<span class="lab">위험인자</span>' + DB.flags.map(f => `<button class="chip" data-flag="${esc(f.id)}" aria-pressed="${S.flags.has(f.id)}">${esc(f.n)}</button>`).join('');
}

/* ---------------- render: drugs ---------------- */
const colorOf = id => `var(--c-${id}, var(--accent))`;
function drugCard(d) {
  const on = d.id in S.sel, rts = routesOf(d.id), rt = S.sel[d.id] || rts[0], r = R(d.id, rt);
  const vals = [d.props.depth, d.props.analg, d.props.airway, r.os, d.props.recov];
  return `<button class="drug" data-drug="${esc(d.id)}" aria-pressed="${on}" style="--dc:${colorOf(d.id)}">
    <span class="r1"><span class="dname"><span class="dot"></span><span><b>${esc(d.ko)}</b><small>${esc(d.en)}</small></span></span>
    ${vals.map(v => `<span class="bar"><i style="width:${Math.max(0, Math.min(4, v)) / 4 * 100}%"></i></span>`).join('')}</span>
    ${on ? `<span class="routes">${rts.map(x => `<span data-route="${esc(d.id)}:${esc(x)}" aria-pressed="${x === rt}" role="button" tabindex="0">${esc(R(d.id, x).lab || x)}</span>`).join('')}</span>` : ''}
  </button>`;
}
function renderDrugs() {
  const ds = avail(), n = Object.keys(S.sel).length;
  $('drugs').innerHTML = `<div class="ph"><h2>약물</h2><span class="lab selcount">${n ? `${n}개 선택` : '눌러서 선택'}</span></div>
  <div class="dhead"><span>막대가 길수록 좋음</span><span>깊이<br>조절</span><span>진통</span><span>숨<br>보존</span><span>빠른<br>시작</span><span>짧은<br>회복</span></div>
  ${ds.filter(d => !d.adjunct).map(drugCard).join('')}
  ${ds.some(d => d.adjunct) ? `<div class="dsec">더하는 약</div>${ds.filter(d => d.adjunct).map(drugCard).join('')}` : ''}`;
}

/* ---------------- render: plan ---------------- */
function timeline(items) {
  const T = S.T, pre = Math.max(15, ...items.map(i => R(i.id, i.rt).onset)) + 5;
  const post = Math.max(...items.map(i => R(i.id, i.rt).rec)) + 20;
  const x0 = -pre, x1 = T + post, W = 560, L = 96, Rr = 14, rowH = 26, top = 34;
  const X = t => L + (t - x0) / (x1 - x0) * (W - L - Rr);
  const H = top + items.length * rowH + 34;
  let g = '';
  const step = x1 - x0 > 200 ? 60 : x1 - x0 > 100 ? 30 : 15;
  for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) {
    g += `<line x1="${X(t)}" y1="${top - 8}" x2="${X(t)}" y2="${H - 24}" stroke="var(--line)" stroke-width="1"/><text x="${X(t)}" y="${H - 10}" text-anchor="middle" font-size="10.5" fill="var(--faint)" font-family="var(--f-mono)">${t}</text>`;
  }
  g += `<text x="${L - 8}" y="${H - 10}" text-anchor="end" font-size="10.5" fill="var(--faint)">분</text>`;
  g += `<rect x="${X(0)}" y="8" width="${X(T) - X(0)}" height="14" rx="4" fill="var(--accent)" opacity="0.85"/><text x="${L - 8}" y="19" text-anchor="end" font-size="12" fill="var(--muted)">시술</text><text x="${Math.min(X(T) + 6, W - 40)}" y="19" font-size="11" fill="var(--fg)" font-family="var(--f-mono)">${T}분</text>`;
  [0, T].forEach(t => { g += `<line x1="${X(t)}" y1="6" x2="${X(t)}" y2="${H - 24}" stroke="var(--fg)" stroke-width="1" stroke-dasharray="3 3" opacity=".5"/>`; });
  items.forEach((it, k) => {
    const r = R(it.id, it.rt), y = top + k * rowH, yb = y + rowH - 6, yt = y + 4, col = colorOf(it.id);
    const a = -r.onset, end = r.inf ? T : a + r.onset + r.dur, off = end + r.rec;
    g += `<text x="${L - 8}" y="${y + rowH / 2 + 2}" text-anchor="end" font-size="12" fill="var(--fg)">${esc(D[it.id].ko)}</text>`;
    g += `<polygon points="${X(a)},${yb} ${X(0)},${yt} ${X(end)},${yt} ${X(off)},${yb}" fill="${col}" fill-opacity=".28" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/>`;
    g += `<path d="M${X(a)} ${yb + 3} l-4 5 h8 z" fill="${col}"/>`;
    if (!r.inf && end < T) g += `<circle cx="${X(end)}" cy="${yt}" r="4" fill="var(--bad)"/><text x="${X(end) + 7}" y="${yt + 4}" font-size="10.5" fill="var(--bad)">재투여</text>`;
    if (r.inf) g += `<text x="${(X(0) + X(end)) / 2}" y="${yt + 12}" text-anchor="middle" font-size="10.5" fill="var(--fg)">지속주입</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="약물 효과와 시술 시간"><title>효과와 시간</title>${g}</svg>`;
}
function coverBox(name, have, need, max, okTxt, gapTxt, disp) {
  const gap = need - have > 0.05;
  return `<div class="cv ${gap ? 'gap' : ''}"><div class="t"><span>${name}</span><b class="num">${disp}</b></div>
  <div class="track"><span class="fill" style="width:${Math.min(100, have / max * 100)}%"></span><span class="need" style="left:calc(${Math.min(100, need / max * 100)}% - 1px)"></span></div>
  <span class="st">${gap ? gapTxt : okTxt}</span></div>`;
}
function renderPlan() {
  const recs = recommend();
  const ids = Object.keys(S.sel), items = ids.map(id => ({ id, rt: S.sel[id] }));
  const curKey = ids.slice().sort().join('+');
  let h = `<div class="ph"><h2>추천 조합</h2><span class="lab">현재 조건 기준 점수</span></div>
  <div class="recs">${recs.map((r, i) => {
    const k = r.c.map(x => x.id).sort().join('+');
    return `<button class="rec ${k === curKey ? 'cur' : ''}" data-apply="${esc(JSON.stringify(r.c))}">
      <span class="rk"><span>${i + 1}순위</span><span class="score">${r.e.score}</span></span>
      <span class="sbar"><i style="width:${r.e.score}%"></i></span>
      <span class="nm">${r.c.map(x => `${esc(D[x.id].ko)} <small style="color:var(--muted);font-weight:400">${esc(R(x.id, x.rt).lab || x.rt)}</small>`).join(' + ')}</span>
      <span class="why">${esc(r.e.pros.slice(0, 2).join(' · '))}${r.e.cons.length ? `<br><span style="color:var(--warn)">${esc(r.e.cons[0])}</span>` : ''}</span>
    </button>`;
  }).join('') || '<div class="empty">조건에 맞는 조합이 없습니다.</div>'}</div>`;

  if (!items.length) {
    h += `<div class="empty">왼쪽에서 약물을 고르거나 추천 조합을 눌러 적용하세요.<br>용량, 효과, 부작용, onset, 지속시간과 상호작용이 여기에 나타납니다.</div>`;
    $('plan').innerHTML = h; return;
  }
  const e = evalCombo(items), N = needs(), c = e.cov;
  h += `<div class="ph" style="margin-top:4px"><h2>선택 조합</h2><span class="lab">점수 <span class="num" style="color:var(--fg)">${e.score}</span></span></div>
  <div class="cover">
   ${coverBox('움직임 멈춤', c.depth, N.depth, 4, '충족', '깊이 부족', M_LBL[S.m])}
   ${coverBox('통증', c.analg, N.analg, 4, '충족', '진통 부족', P_LBL[S.p])}
   ${coverBox('숨 보존', c.airway, N.airway, 4, '여유 있음', '호흡억제 위험', S.a ? '공유' : '비공유')}
   ${coverBox('시간', Math.min(c.dur, S.T * 1.5), S.T, S.T * 1.5, c.inf ? '지속주입' : '유지됨', '재투여 필요', S.T + '분')}
  </div>
  <div class="tl">${timeline(items)}</div>
  <div class="tbl"><table><thead><tr><th>약물</th><th>용량 (${S.wt} kg)</th><th>Onset</th><th>효과 지속</th><th>회복</th></tr></thead><tbody>
  ${items.map(it => {
    const r = R(it.id, it.rt);
    return `<tr><td><span class="dn"><span class="dot" style="--dc:${colorOf(it.id)}"></span>${esc(D[it.id].ko)}</span><small style="color:var(--muted)">${esc(r.lab || it.rt)}</small></td>
    <td><div class="dose">${r.dose.map(doseLine).join('')}</div></td>
    <td class="num">${r.onset}분</td><td class="num">${r.inf ? '주입 중' : '~' + r.dur + '분'}</td><td class="num">${r.rec}분</td></tr>`;
  }).join('')}
  </tbody></table></div>
  <div class="two">
    <div class="box"><h3>기대 효과</h3><ul>${items.flatMap(it => (D[it.id].good || []).map(g => `<li>${esc(g)} <small>${esc(D[it.id].en)}</small></li>`)).join('')}</ul></div>
    <div class="box"><h3>부작용</h3><ul>${items.flatMap(it => (D[it.id].bad || []).map(g => `<li>${esc(g)} <small>${esc(D[it.id].en)}</small></li>`)).join('')}</ul></div>
  </div>`;
  const ctx = ctxOf(items, c);
  const A = DB.interactions.filter(r => match(r.when, ctx));
  const extra = e.cons.filter(x => !A.some(a => (a.title || '').includes(x))).map(x => ({ level: 'mid', tag: '적합도', title: x }));
  const all = [...A, ...extra];
  if (all.length) h += `<div class="ph"><h2>상호작용·경고</h2><span class="lab">${all.length}건</span></div><div class="alerts">${all.map(a => `<div class="al ${esc(a.level || 'mid')}"><span class="tag">${esc(a.tag || '주의')}</span><span><b>${esc(a.title)}</b>${a.detail ? ' ' + esc(a.detail) : ''}${a.ref ? ` <span class="ref">${esc(a.ref)}</span>` : ''}</span></div>`).join('')}</div>`;
  const P = DB.pearls.filter(p => match(p.when, ctx));
  if (P.length) h += `<div class="ph"><h2>Clinical pearl</h2><span class="lab">이 상황에서</span></div><ul class="pearls">${P.map((p, i) => `<li><span class="pk">${String(i + 1).padStart(2, '0')}</span><span>${esc(p.text)}</span></li>`).join('')}</ul>`;
  $('plan').innerHTML = h;
}

/* ---------------- render: evidence ---------------- */
function evCard(e) {
  const dcls = { rct: 'd-rct', meta: 'd-rct', gl: 'd-gl', reg: 'd-reg' };
  const pend = e.status === 'pending';
  const link = e.link || (e.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(e.pmid)}/` : 'https://pubmed.ncbi.nlm.nih.gov/?term=' + encodeURIComponent(e.title));
  return `<article class="ev ${pend ? 'pending' : ''}">
    <div class="meta"><span class="num">${esc(e.yr)}</span>${pend ? '<span class="pill d-pend">검토 대기</span>' : ''}<span class="pill ${dcls[e.type] || ''}">${esc(e.design)}</span>${e.n ? `<span class="pill num">n=${esc(e.n)}</span>` : ''}</div>
    <h3>${esc(e.title)}</h3>
    <p class="key" style="margin:0">${esc(e.key)}</p>
    <span class="src">${esc(e.au)} · ${esc(e.src)}</span>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span class="tags">${e.tags.filter(t => D[t]).map(t => `<span>#${esc(D[t].en)}</span>`).join('')}</span>
      <a href="${esc(link)}" target="_blank" rel="noopener">${e.link ? '원문 보기' : 'PubMed'} ↗</a>
    </div></article>`;
}
function renderEvidence() {
  const ids = Object.keys(S.sel), pr = curProc();
  const want = new Set(['guide', ...ids, ...pr.tags, pr.id]);
  if (ids.length >= 2) want.add('multi');
  S.flags.forEach(f => want.add(f));
  if (S.mode === 'ped' && S.age < 3) want.add('neuro');
  const pool = DB.evidence.items.filter(e => e.mode.includes(S.mode));
  const rel = e => S.evAll || e.tags.some(t => want.has(t));
  const pending = pool.filter(e => e.status === 'pending' && rel(e)).sort((a, b) => b.yr - a.yr);
  const list = pool.filter(e => e.status !== 'pending' && rel(e)).sort((a, b) => b.yr - a.yr);
  $('evidence').innerHTML = `<div class="ph"><h2>근거</h2><span class="lab">${list.length + pending.length} / ${pool.length}편${DB.evidence.lastReviewed ? ` · 검토 ${esc(DB.evidence.lastReviewed)}` : ''}</span></div>
  <div class="evf seg" role="group" aria-label="근거 범위"><button data-ev="0" aria-pressed="${!S.evAll}">이 조합 관련</button><button data-ev="1" aria-pressed="${S.evAll}">전체</button></div>
  ${pending.length ? `<div class="dsec" style="color:var(--warn)">새로 들어온 논문 ${pending.length}편 — data/evidence.json 에서 status를 "approved"로 바꾸면 승인</div>${pending.map(evCard).join('')}` : ''}
  ${list.map(evCard).join('') || '<div class="empty">조건에 맞는 근거가 없습니다.</div>'}`;
}

/* ---------------- state & events ---------------- */
function renderAll() { renderTop(); renderDrugs(); renderPlan(); renderEvidence(); saveState(); }
function applyProc(id) {
  const p = DB.procedures[S.mode].find(x => x.id === id) || DB.procedures[S.mode][0];
  if (!p) return;
  S.proc = p.id; S.m = Math.max(0, Math.min(3, p.m | 0)); S.p = Math.max(0, Math.min(3, p.p | 0)); S.T = p.T || 20; S.a = p.a ? 1 : 0;
}
function applyTop() { const r = recommend()[0]; S.sel = {}; if (r) r.c.forEach(x => { S.sel[x.id] = x.rt; }); }
function cleanSel() { Object.keys(S.sel).forEach(id => { if (!D[id] || !routesOf(id).includes(S.sel[id])) { if (D[id] && routesOf(id).length) S.sel[id] = routesOf(id)[0]; else delete S.sel[id]; } }); }
function saveState() {
  try { localStorage.setItem('sp-state', JSON.stringify({ ...S, flags: [...S.flags] })); } catch (e) { /* storage unavailable */ }
}
function loadState() {
  try {
    const v = JSON.parse(localStorage.getItem('sp-state') || 'null');
    if (!v || (v.mode !== 'ped' && v.mode !== 'adult')) return false;
    Object.assign(S, v, { flags: new Set(v.flags || []) });
    return true;
  } catch (e) { return false; }
}

document.addEventListener('click', ev => {
  if (!DB) return;
  const t = ev.target.closest('button,[data-route]');
  if (!t) return;
  if (t.id === 'install') return;
  if (t.dataset.route) { ev.stopPropagation(); const [id, rt] = t.dataset.route.split(':'); S.sel[id] = rt; return renderAll(); }
  if (t.dataset.mode) {
    if (S.mode === t.dataset.mode) return;
    S.mode = t.dataset.mode; S.age = S.mode === 'ped' ? 4 : 45; S.wtAuto = true; S.wt = estWt(S.age);
    $('age').value = S.age; $('wt').value = S.wt; S.flags.clear();
    applyProc((DB.procedures[S.mode][0] || {}).id); applyTop(); return renderAll();
  }
  if (t.dataset.proc) { applyProc(t.dataset.proc); applyTop(); return renderAll(); }
  if (t.dataset.m !== undefined) { S.m = +t.dataset.m; return renderAll(); }
  if (t.dataset.p !== undefined) { S.p = +t.dataset.p; return renderAll(); }
  if (t.dataset.a !== undefined) { S.a = +t.dataset.a; return renderAll(); }
  if (t.dataset.flag) { S.flags.has(t.dataset.flag) ? S.flags.delete(t.dataset.flag) : S.flags.add(t.dataset.flag); return renderAll(); }
  if (t.dataset.drug) { const id = t.dataset.drug; if (id in S.sel) delete S.sel[id]; else S.sel[id] = routesOf(id)[0]; return renderAll(); }
  if (t.dataset.apply) { S.sel = {}; JSON.parse(t.dataset.apply).forEach(x => { S.sel[x.id] = x.rt; }); return renderAll(); }
  if (t.dataset.ev !== undefined) { S.evAll = t.dataset.ev === '1'; return renderEvidence(); }
});
document.addEventListener('keydown', ev => {
  const t = ev.target.closest && ev.target.closest('[data-route]');
  if (t && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); ev.stopPropagation(); const [id, rt] = t.dataset.route.split(':'); S.sel[id] = rt; renderAll(); }
});
$('t-range').addEventListener('input', e => { if (!DB) return; S.T = +e.target.value; renderAll(); });
$('age').addEventListener('input', e => {
  if (!DB) return;
  const v = parseFloat(e.target.value); if (isNaN(v) || v < 0) return;
  S.age = v; if (S.wtAuto) { S.wt = estWt(v); $('wt').value = S.wt; } renderAll();
});
$('wt').addEventListener('input', e => {
  if (!DB) return;
  const v = parseFloat(e.target.value); if (isNaN(v) || v <= 0) return;
  S.wt = v; S.wtAuto = false; renderAll();
});

/* ---------------- install & offline ---------------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('install').hidden = false; });
$('install').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (e) { } installEvt = null; $('install').hidden = true; });
function netStatus() { $('status').innerHTML = navigator.onLine ? '<span class="on">● 온라인</span>' : '<span class="off">● 오프라인 — 저장된 데이터 사용 중</span>'; }
window.addEventListener('online', netStatus); window.addEventListener('offline', netStatus);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { }));

/* ---------------- boot ---------------- */
(async function boot() {
  netStatus();
  const { out, errs } = await loadAll();
  validate(out, errs);
  DB = out; D = Object.fromEntries(DB.drugs.map(d => [d.id, d]));
  showErrors(errs);
  if (!DB.drugs.length) { $('drugs').innerHTML = '<div class="empty">약물 데이터를 읽지 못했습니다. 위 오류를 확인하세요.</div>'; return; }
  const restored = loadState();
  if (restored) {
    if (!DB.procedures[S.mode].some(p => p.id === S.proc)) applyProc((DB.procedures[S.mode][0] || {}).id);
    cleanSel();
  } else {
    applyProc('mri');
    S.sel = D.dex && routesOf('dex').includes('IN') ? { dex: 'IN' } : {};
    if (!Object.keys(S.sel).length) applyTop();
  }
  $('age').value = S.age; $('wt').value = S.wt;
  renderAll();
})();
