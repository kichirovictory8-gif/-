/* 実験ノート印刷ツール 画面プログラム */
'use strict';

// ============================================================
// 共通
// ============================================================
const $app = document.getElementById('app');
const NO_SERVER = 'ツールのサーバにつながりません。保存されていません。\n\n・起動.bat の黒い画面が開いているか確認してください（閉じると止まります）。\n・ZIPファイルは「すべて展開」してから起動.bat を開いてください。\n・他のPCから開いている場合は、ツールを起動しているPCが動いているか確認してください。\n\n入力した内容は画面に残っているので、サーバを起動し直してからもう一度保存してください。';
async function req(method, u, body) {
  let r;
  try {
    r = await fetch('/api/' + u, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { alert(NO_SERVER); throw e; }
  let j;
  try { j = await r.json(); } catch (e) { alert('サーバから予期しない応答がありました（' + r.status + '）。保存されていない可能性があります。'); throw e; }
  if (j && j.error) { alert('保存・読み込みに失敗しました: ' + j.error); throw new Error(j.error); }
  return j;
}
const api = {
  get: u => req('GET', u),
  send: (method, u, body) => req(method, u, body),
};
// 同時編集の確認つき保存（他の人が先に保存していたら知らせる）
async function putWithCheck(u, data, base) {
  let r = await api.send('PUT', u, { data, base });
  if (r.conflict) {
    if (!confirm('このデータは、開いた後に別の人（または別の画面）が保存しています。\n\nOK：自分の内容で上書きする（相手の変更は消えます）\nキャンセル：保存しない（ページを開き直すと相手の内容を確認できます）')) return null;
    r = await api.send('PUT', u, { data, base, force: true });
  }
  return r.updated;
}
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clone = o => JSON.parse(JSON.stringify(o));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200); }
function jpDate(s) { if (!s) return ''; const [y, m, d] = s.split('-'); return `${y}年${+m}月${+d}日`; }
function getPath(o, path) { return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, path, v) { const ks = path.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => a[k], o); t[last] = v; }
function fmtNum(x) {
  if (x === '' || x == null || isNaN(x)) return '';
  const r = Math.round(x * 1000) / 1000;
  return String(r);
}
function num(v) { if (v === '' || v == null) return NaN; return parseFloat(String(v).replace(/[，,]/g, '').replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))); }

let dirty = false;
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
function leaveOk() { if (!dirty) return true; if (confirm('保存していない変更があります。破棄して移動しますか？')) { dirty = false; return true; } return false; }

// ============================================================
// 文字の書式（可変欄・強調・上付き/下付きの自動変換）
// ============================================================
const TOKEN_RE = /\[\[([^\]]*)\]\]/g;
function parseToken(inner) {
  const i = inner.indexOf('=');
  if (i < 0) return { label: inner.trim(), value: '' };
  return { label: inner.slice(0, i).trim(), value: inner.slice(i + 1) };
}
function setToken(str, k, value) {
  let n = -1;
  return str.replace(TOKEN_RE, (m, inner) => {
    n++;
    if (n !== k) return m;
    const t = parseToken(inner);
    return value === '' ? `[[${t.label}]]` : `[[${t.label}=${value}]]`;
  });
}
function countBlanks(doc) {
  let c = 0;
  const walk = v => {
    if (typeof v === 'string') { for (const m of v.matchAll(TOKEN_RE)) if (parseToken(m[1]).value === '') c++; }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const k in v) { if (k !== 'src') walk(v[k]); }
  };
  walk(doc.blocks); walk(doc.title);
  for (const b of doc.blocks) if (b.type === 'materials' && (b.n === '' || b.n == null)) c++;
  return c;
}

const ELEMENTS = new Set('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu'.split(' '));
const CHEM_OK = new Set(['H2O', 'H2O2', 'CO2', 'O2', 'N2', 'H2', 'H2SO4', 'H3PO4', 'HNO3', 'KH2PO4', 'K2HPO4', 'K3PO4', '(NH4)2SO4', 'NH4HCO3', 'NH4', 'SO4', 'PO4', 'K2CO3', 'KIO3', 'HIO4', 'B2O3', 'P2O5']);
function isFormula(tok) {
  if (!/\d/.test(tok)) return false;
  if (CHEM_OK.has(tok)) return true;
  const body = tok.replace(/[()]/g, '');
  const parts = body.match(/[A-Z][a-z]?\d*/g);
  if (!parts || parts.join('') !== body || parts.length < 2) return false;
  let two = false;
  for (const p of parts) { const el = p.replace(/\d+/g, ''); if (!ELEMENTS.has(el)) return false; if (el.length === 2) two = true; }
  if (/^\d/.test(tok)) return false;
  return two;
}
function autoScript(text, chem) {
  // 1) タンパク質名の直後の残基範囲 → 上付き  例: Orc2(1-236)
  text = text.replace(/([A-Z][A-Za-z0-9Δ]*[A-Za-z0-9Δ])\((\d+\s*[-–−~～]\s*\d+)\)/g, '$1<sup>$2</sup>');
  // 2) タグの個数 → 下付き  例: His12, His6, FLAG3
  text = text.replace(/(^|[^A-Za-z])(His|HIS|FLAG|Flag|Myc|myc|HA|Strep)(\d{1,2})(?![\d])/g, '$1$2<sub>$3</sub>');
  // 3) 化学式の数字 → 下付き  例: MgCl2, (NH4)2SO4
  if (chem) {
    text = text.replace(/(^|[^A-Za-z0-9])(\(?[A-Z][A-Za-z0-9()]*\d[A-Za-z0-9()]*)(?![A-Za-z0-9])/g, (m, pre, tok) => {
      if (!isFormula(tok)) return m;
      return pre + tok.replace(/([A-Za-z)])(\d+)/g, '$1<sub>$2</sub>');
    });
  }
  return text;
}
function markup(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/==(.+?)==/g, '<mark class="hl">$1</mark>')
    .replace(/!!(.+?)!!/g, '<span class="red">$1</span>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/\|\|(.+?)\|\|/g, '<span class="box">$1</span>')
    .replace(/\^\{(.+?)\}/g, '<sup>$1</sup>')
    .replace(/_\{(.+?)\}/g, '<sub>$1</sub>');
}
function inlineFmt(raw, ctx) {
  // ctx: {mode:'print'|'preview'|'fill', path, chem}
  const toks = [];
  let s = String(raw ?? '').replace(TOKEN_RE, (m, inner) => { toks.push(parseToken(inner)); return '' + (toks.length - 1) + ''; });
  s = markup(esc(s));
  s = s.split(/(<[^>]+>)/).map(part => part.startsWith('<') ? part : autoScript(part, ctx.chem)).join('');
  return s.replace(/(\d+)/g, (m, i) => tokenHtml(toks[+i], +i, ctx));
}
function tokenHtml(t, k, ctx) {
  if (ctx.mode === 'fill' && ctx.path != null) {
    const v = t.value;
    const w = Math.max(3, Math.min(30, (v || t.label || '').length * 0.75 + 1.5));
    return `<input class="vin${v ? '' : ' empty'}" data-path="${esc(ctx.path)}" data-k="${k}" data-key="${esc(ctx.path)}#${k}" value="${esc(v)}" placeholder="${esc(t.label)}" title="${esc(t.label || '可変欄')}" style="width:${w}em">`;
  }
  if (t.value !== '') return `<span class="vf">${autoScript(markup(esc(t.value)), ctx.chem)}</span>`;
  const w = Math.max(3, Math.min(20, t.label.length * 1.0 + 1));
  const lbl = ctx.mode === 'preview' && t.label ? `<span class="lbl">${esc(t.label)}</span>` : '&nbsp;';
  return `<span class="vf blank" style="min-width:${w}em">${lbl}</span>`;
}

// ============================================================
// 書面の描画（印刷・プレビュー・入力モード共通）
// ============================================================
const HANG = /^[・※★→⇒〇●◎①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/;
function splitIndent(line) {
  const m = line.match(/^[ 　\t]*/)[0];
  let ind = 0;
  for (const ch of m) ind += ch === '　' ? 1 : ch === '\t' ? 2 : 0.5;
  return { ind, text: line.slice(m.length) };
}
function lineHtml(text, ind, ctx, extraCls = '') {
  if (text === '') return '<div class="gap"></div>';
  if (/^[↓⇓]$/.test(text.trim())) return `<div class="arrow" style="padding-left:${ind}em">↓</div>`;
  const hang = HANG.test(text);
  return `<div class="ln${hang ? ' hang' : ''} ${extraCls}" style="padding-left:${ind + (hang ? 1 : 0)}em">${inlineFmt(text, ctx)}</div>`;
}
function renderText(str, ctx) {
  return String(str || '').split('\n').map(l => { const { ind, text } = splitIndent(l); return lineHtml(text, ind, ctx); }).join('');
}
function renderSteps(str, ctx) {
  // 1行1ステップ。字下げした行・※で始まる行は補足。ステップの間に「↓」を自動で入れる。空行で区切ると矢印なし。
  const lines = String(str || '').split('\n');
  let out = '', grp = '', prevStep = false, stepInd = 0;
  const flush = () => { if (grp) out += `<div class="stepgrp">${grp}</div>`; grp = ''; };
  for (const raw of lines) {
    const { ind, text } = splitIndent(raw);
    if (text === '') { flush(); out += '<div class="gap"></div>'; prevStep = false; continue; }
    if (/^[↓⇓]$/.test(text.trim())) continue;
    const isStep = ind === 0 && !/^[※＊*]/.test(text);
    if (isStep) {
      flush();
      if (prevStep) out += `<div class="arrow" style="padding-left:${stepInd}em">↓</div>`;
      prevStep = true; stepInd = 0;
    }
    grp += lineHtml(text, ind, ctx);
  }
  flush();
  return out;
}
function matCompute(b) {
  const n = num(b.n);
  const vol = b.mode === 'volume';
  const factor = isNaN(n) ? NaN : (vol ? n / 1000 : n);
  const total = num(b.total);
  let sumCalc = 0;
  for (const r of b.rows) if ((r.kind || 'calc') === 'calc' && !isNaN(num(r.per1))) sumCalc += num(r.per1);
  const restPer1 = isNaN(total) ? NaN : Math.round((total - sumCalc) * 1000) / 1000;
  return { n, factor, total, restPer1, vol };
}
function renderMaterials(b, bp, ctx) {
  const c = matCompute(b);
  const nHtml = ctx.mode === 'fill'
    ? `<input class="vin${b.n === '' || b.n == null ? ' empty' : ''}" data-num="1" data-path="${bp}.n" data-key="${bp}.n" value="${esc(b.n ?? '')}" placeholder="${c.vol ? '量' : '数'}" style="width:4em">`
    : (b.n !== '' && b.n != null ? `<span class="vf">${esc(b.n)}</span>` : `<span class="vf blank" style="min-width:3em">&nbsp;</span>`);
  const label = inlineFmt(b.label || '', { ...ctx, path: `${bp}.label` });
  const head = c.vol
    ? `${label}（作製量：${nHtml} mL）`
    : `${label}（×${nHtml}${esc(b.nunit || 'サンプル')}分）`;
  const amt = (per1, unit) => {
    if (isNaN(per1)) return `<span class="vf blank">&nbsp;</span>${esc(unit)}`;
    if (isNaN(c.factor)) return `<span class="vf blank" style="min-width:3em">&nbsp;</span>${esc(unit)}`;
    return `<span class="vf calc">${fmtNum(per1 * c.factor)}</span>${esc(unit)}`;
  };
  let rows = '';
  b.rows.forEach((r, i) => {
    const kind = r.kind || 'calc';
    const rp = `${bp}.rows.${i}`;
    let a = '', ref = '';
    const unitRef = r.unit + (c.vol ? '/L' : '');
    if (kind === 'calc') { a = amt(num(r.per1), r.unit); ref = isNaN(num(r.per1)) ? '' : fmtNum(num(r.per1)) + unitRef; }
    else if (kind === 'rest') { a = amt(c.restPer1, r.unit); ref = isNaN(c.restPer1) ? '残り' : fmtNum(c.restPer1) + unitRef; }
    else if (kind === 'vol') { a = isNaN(c.n) ? `<span class="vf blank" style="min-width:3em">&nbsp;</span>${esc(r.unit)}` : `<span class="vf calc">${fmtNum(c.n)}</span>${esc(r.unit)}`; }
    else { a = inlineFmt(r.value || '', { ...ctx, path: `${rp}.value` }) + esc(r.unit || ''); }
    const refHtml = (kind === 'text' || kind === 'vol') ? (r.ref ? inlineFmt(r.ref, { ...ctx, path: `${rp}.ref` }) : '') : (ref ? `（${esc(ref)}）` : '');
    const bullet = r.nobullet ? '' : '・';
    rows += `<tr><td class="nm" style="padding-left:${1 + (+r.indent || 0)}em">${bullet}${inlineFmt(r.name, { ...ctx, path: `${rp}.name` })}</td><td>：</td><td class="amt">${a}</td><td>${refHtml}</td><td class="note">${inlineFmt(r.note || '', { ...ctx, path: `${rp}.note` })}</td></tr>`;
  });
  if (b.total !== '' && b.total != null) {
    rows += `<tr class="total"><td class="nm">　${esc(b.total_label || 'Total')}</td><td>：</td><td class="amt">${amt(c.total, b.total_unit || '')}</td><td>（${fmtNum(c.total)}${esc(b.total_unit || '')}${c.vol ? '/L' : ''}）</td><td></td></tr>`;
  }
  const hdr = c.vol ? '' : '<tr class="mh"><td></td><td></td><td></td><td>（×１量）</td><td></td></tr>';
  return `<div class="mat"><div class="mat-h"><span>${head}</span></div><table class="mat-t">${hdr}${rows}</table></div>`;
}
function renderTable(b, bp, ctx) {
  let h = `<table class="grid${b.full ? ' full' : ''}">`;
  b.rows.forEach((row, r) => {
    const hr = b.header_row && r === 0;
    h += `<tr class="${hr ? 'hr' : ''}">`;
    row.forEach((cell, ci) => {
      const hc = b.header_col && ci === 0;
      h += `<td class="${hc ? 'hc lft' : ''}">${inlineFmt(cell, { ...ctx, path: `${bp}.rows.${r}.${ci}` })}</td>`;
    });
    h += '</tr>';
  });
  return h + '</table>';
}
function renderPcr(b, bp, ctx) {
  const st = b.steps || [];
  const from = +b.cyc_from, to = +b.cyc_to;
  const hasCyc = b.cyc_from !== '' && b.cyc_to !== '' && !isNaN(from) && !isNaN(to) && from <= to && to < st.length;
  const step = (s, i) => `<div class="ps">${inlineFmt(s.t, { ...ctx, path: `${bp}.steps.${i}.t` })}、${inlineFmt(s.d, { ...ctx, path: `${bp}.steps.${i}.d` })}</div>`;
  const arrow = '<div class="arrow">↓</div>';
  let h = `<div class="pcr">`;
  if (b.label) h += `<div class="ps"><span class="box">${inlineFmt(b.label, { ...ctx, path: `${bp}.label` })}</span></div>`;
  let i = 0, first = true;
  while (i < st.length) {
    if (!first) h += arrow;
    first = false;
    if (hasCyc && i === from) {
      let inner = '';
      for (let j = from; j <= to; j++) { if (j > from) inner += arrow; inner += step(st[j], j); }
      h += `<div class="cyc-wrap"><div class="cyc-steps">${inner}</div><div class="brk"></div><div class="cyc-lbl">${inlineFmt(b.cyc_text || '', { ...ctx, path: `${bp}.cyc_text` })}</div></div>`;
      i = to + 1;
    } else { h += step(st[i], i); i++; }
  }
  return h + '</div>';
}
function renderHeading(b, bp, ctx) {
  const t = inlineFmt(b.text || '', { ...ctx, path: `${bp}.text` });
  const ex = b.extra ? `<span class="extra">${inlineFmt(b.extra, { ...ctx, path: `${bp}.extra` })}</span>` : '';
  const ind = `padding-left:${+b.indent || 0}em`;
  switch (b.style) {
    case '●': return `<div class="h-sub" style="${ind}">●<u>${t}</u>${ex}</div>`;
    case '【】': return `<div class="blk-h" style="${ind}">【${t}】${ex}</div>`;
    case '〈〉': return `<div class="blk-h" style="${ind}">〈${t}〉${ex}</div>`;
    case '[]': return `<div class="blk-h" style="${ind}">[${t}]${ex}</div>`;
    case '〇': return `<div class="blk-h" style="${ind}">〇${t}${ex}</div>`;
    case '★': return `<div class="blk-h" style="${ind}">★${t}${ex}</div>`;
    default: return `<div class="blk-h" style="${ind}">${t}${ex}</div>`;
  }
}
function renderDoc(doc, opts = {}) {
  const mode = opts.mode || 'print';
  const ctx = { mode, chem: opts.chem !== false };
  let h = `<div class="sheet">`;
  if (opts.date) h += `<div class="date-line">${esc(jpDate(opts.date))}</div>`;
  h += `<h1 class="ptitle">●<u>${inlineFmt(doc.title || '', { ...ctx, path: 'title' })}</u></h1>`;
  (doc.blocks || []).forEach((b, i) => {
    const bp = `blocks.${i}`;
    const ind = +b.indent || 0;
    let inner = '';
    switch (b.type) {
      case 'heading': inner = renderHeading(b, bp, ctx); break;
      case 'text': inner = renderText(b.text, { ...ctx, path: `${bp}.text` }); break;
      case 'steps': inner = renderSteps(b.text, { ...ctx, path: `${bp}.text` }); break;
      case 'materials': inner = renderMaterials(b, bp, ctx); break;
      case 'table': inner = renderTable(b, bp, ctx); break;
      case 'pcr': inner = renderPcr(b, bp, ctx); break;
      case 'image': inner = b.src ? `<img class="pic" src="${b.src}" style="width:${+b.width || 100}%">` : ''; break;
    }
    h += `<div class="block" style="${b.type !== 'heading' && ind ? `padding-left:${ind}em` : ''}">${inner}</div>`;
  });
  if (opts.memo && doc.memo && doc.memo.text && doc.memo.text.trim()) {
    h += `<div class="memo"><div class="memo-h">【メモ】</div>${renderText(doc.memo.text, { ...ctx, mode: mode === 'fill' ? 'print' : mode, path: 'memo.text' })}</div>`;
  }
  return h + '</div>';
}

// ============================================================
// 体言止めの提案（任意）
// ============================================================
const TG_RULES = [
  [/をしっかり除く$/, 'をしっかり除去'], [/を除く$/, 'を除去'], [/除く$/, '除去'],
  [/を捨てる$/, 'を廃棄'], [/捨てる$/, '廃棄'],
  [/を加える$/, 'を添加'], [/加える$/, '添加'], [/を入れる$/, 'を添加'], [/入れる$/, '添加'],
  [/を混ぜる$/, 'を混合'], [/混ぜる$/, '混合'],
  [/に移す$/, 'に移し替え'], [/を移す$/, 'を移動'],
  [/溶かす$/, '溶解'], [/冷やす$/, '冷却'], [/温める$/, '加温'],
  [/置く$/, '静置'], [/洗う$/, '洗浄'], [/塗り広げる$/, '塗布'], [/まく$/, '播種'],
  [/集める$/, '回収'], [/まとめる$/, '集約'], [/取る$/, '採取'], [/出す$/, '取り出し'],
  [/行う$/, '実施'], [/保存する$/, '保存'], [/繰り返す$/, '反復'], [/待つ$/, '待機'],
  [/([^\sのをにでがはと])する$/, '$1'],
];
function taigen(line) {
  const m = line.match(/^(.*?)(。?)((?:[（(][^（）()]*[）)])*)(。?)$/);
  if (!m) return line;
  let main = m[1];
  for (const [re, rep] of TG_RULES) { if (re.test(main)) { main = main.replace(re, rep); break; } }
  return main + m[3];
}
function openTaigen(text, onApply) {
  const lines = text.split('\n');
  const cands = lines.map((l, i) => ({ i, old: l, neu: taigen(l) })).filter(c => c.neu !== c.old.replace(/。$/, '') || /。$/.test(c.old.trim()) && c.neu !== c.old);
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>体言止めの提案</h3>
    <p class="muted">文末を体言止めにそろえる案です。使いたい行にチェックを入れて「反映」を押してください（あくまで機械的な提案なので、必ず目で確認してください）。</p>
    ${cands.length ? cands.map(c => `<label class="tg-line"><input type="checkbox" data-i="${c.i}" checked><span>${esc(c.old)}</span><span class="new">${esc(c.neu)}</span></label>`).join('') : '<p>提案はありません。</p>'}
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button data-x>閉じる</button>${cands.length ? '<button class="primary" data-ok>反映</button>' : ''}</div></div>`;
  document.body.appendChild(bg);
  bg.querySelector('[data-x]').onclick = () => bg.remove();
  const ok = bg.querySelector('[data-ok]');
  if (ok) ok.onclick = () => {
    bg.querySelectorAll('input[data-i]:checked').forEach(cb => { const c = cands.find(x => x.i === +cb.dataset.i); lines[c.i] = c.neu; });
    bg.remove(); onApply(lines.join('\n'));
  };
}

// ============================================================
// ブロック編集画面（プロトコル編集・記録の「全体を編集」で共用）
// ============================================================
const BLOCK_TYPES = {
  heading: '見出し', steps: '操作手順（↓自動）', text: '文章', materials: '試薬と量（自動計算）', table: '表', pcr: 'PCR条件', image: '画像',
};
function newBlock(type) {
  switch (type) {
    case 'heading': return { type, style: '【】', text: '', extra: '' };
    case 'steps': return { type, text: '' };
    case 'text': return { type, text: '' };
    case 'materials': return { type, label: '〇', mode: 'sample', nunit: 'サンプル', n: '', total: '', total_unit: 'uL', rows: [{ name: '', kind: 'calc', per1: '', unit: 'uL', note: '' }] };
    case 'table': return { type, header_row: true, header_col: true, rows: [['', '', ''], ['', '', ''], ['', '', '']] };
    case 'pcr': return { type, label: 'PCR', steps: [{ t: '98℃', d: '30sec' }, { t: '98℃', d: '10sec' }, { t: '[[アニール温度]]℃', d: '5sec' }, { t: '72℃', d: '[[伸長時間]]' }, { t: '4℃', d: '∞' }], cyc_from: 1, cyc_to: 3, cyc_text: '×[[サイクル数=30]]サイクル' };
    case 'image': return { type, src: '', width: 100 };
  }
}
let lastField = null;
document.addEventListener('focusin', e => { if (e.target.matches('.blk textarea, .blk input[type=text], .meta input[type=text], .meta textarea')) lastField = e.target; });
const MARKS = { var: ['[[', ']]', 'ラベル'], b: ['**', '**', '文字'], hl: ['==', '==', '文字'], red: ['!!', '!!', '文字'], u: ['__', '__', '文字'], box: ['||', '||', '文字'], sup: ['^{', '}', '上'], sub: ['_{', '}', '下'] };
// Word と同じように「もう一度押すと解除」になる
function wrapSel(before, after, placeholder, el = lastField) {
  if (!el) { alert('先に、書式を付けたい欄をクリックしてください。'); return; }
  const v = el.value;
  let s = el.selectionStart ?? v.length, e = el.selectionEnd ?? v.length;
  const sel = v.slice(s, e);
  if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after)) {
    const inner = sel.slice(before.length, sel.length - after.length);
    el.value = v.slice(0, s) + inner + v.slice(e);
    el.selectionStart = s; el.selectionEnd = s + inner.length;
  } else if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after && s - before.length >= 0) {
    el.value = v.slice(0, s - before.length) + sel + v.slice(e + after.length);
    el.selectionStart = s - before.length; el.selectionEnd = e - before.length;
  } else {
    const t = sel || placeholder;
    el.value = v.slice(0, s) + before + t + after + v.slice(e);
    el.selectionStart = s + before.length; el.selectionEnd = s + before.length + t.length;
  }
  el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
// キーボードショートカット（編集欄の中で有効）
//   Ctrl+B 太字 / Ctrl+U 下線 / Ctrl+Alt+H 強調(黄) / Ctrl+Alt+R 注意(赤) / Ctrl+Alt+V 可変欄
const SHORTCUTS = { 'ctrl+KeyB': 'b', 'ctrl+KeyU': 'u', 'ctrl+alt+KeyH': 'hl', 'ctrl+alt+KeyR': 'red', 'ctrl+alt+KeyV': 'var' };
document.addEventListener('keydown', e => {
  if (e.isComposing || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
  const el = e.target;
  if (!el.matches || !el.matches('.blk textarea, .blk input[type=text], .meta input[type=text], .meta textarea')) return;
  const k = SHORTCUTS[(e.altKey ? 'ctrl+alt+' : 'ctrl+') + e.code];
  if (!k) return;
  e.preventDefault();
  lastField = el;
  wrapSel(...MARKS[k], el);
});
function markupBar() {
  return `<div class="mk"><span class="muted">選んだ文字に書式：</span>
    <button type="button" data-mk="var" title="毎回変わる欄。[[ラベル]] または [[ラベル=既定値]]（Ctrl+Alt+V）">可変欄 [[ ]] <span class="kbd">Ctrl+Alt+V</span></button>
    <button type="button" data-mk="b" title="Ctrl+B"><b>太字</b> <span class="kbd">Ctrl+B</span></button>
    <button type="button" data-mk="u" title="Ctrl+U"><u>下線</u> <span class="kbd">Ctrl+U</span></button>
    <button type="button" data-mk="hl" style="background:#fff200" title="Ctrl+Alt+H">強調(黄) <span class="kbd">Ctrl+Alt+H</span></button>
    <button type="button" data-mk="red" style="color:#e00000" title="Ctrl+Alt+R">注意(赤) <span class="kbd">Ctrl+Alt+R</span></button>
    <button type="button" data-mk="box">枠囲み</button>
    <button type="button" data-mk="sup">上付き x<sup>2</sup></button>
    <button type="button" data-mk="sub">下付き x<sub>2</sub></button></div>`;
}
function bindMarkupBar(root) {
  root.querySelectorAll('[data-mk]').forEach(btn => btn.onmousedown = e => {
    e.preventDefault();
    wrapSel(...MARKS[btn.dataset.mk]);
  });
}
function ta(bind, val, rows) {
  const n = Math.max(rows || 3, String(val || '').split('\n').length + 1);
  return `<textarea data-bind="${bind}" rows="${Math.min(n, 30)}">${esc(val || '')}</textarea>`;
}
const inp = (bind, val, ph = '', w = '') => `<input type="text" data-bind="${bind}" value="${esc(val ?? '')}" placeholder="${esc(ph)}" ${w ? `style="width:${w}"` : ''}>`;
function blockEditorHtml(b, i, n) {
  const bp = `blocks.${i}`;
  let body = '';
  switch (b.type) {
    case 'heading':
      body = `<div class="row"><select data-bind="${bp}.style">${['【】', '〈〉', '[]', '〇', '★', '●', 'なし'].map(s => `<option ${b.style === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        ${inp(bp + '.text', b.text, '見出しの文字', '220px')} 続けて：${inp(bp + '.extra', b.extra, '（任意）見出しの後ろに続く普通の文字', '300px')}
        字下げ ${inp(bp + '.indent', b.indent, '0', '40px')}</div>`;
      break;
    case 'steps':
      body = `<div class="muted">1行に1ステップ。ステップの間には「↓」が自動で入ります。行頭を全角スペースで字下げした行と「※」で始まる行は補足になります。空行で区切ると矢印は入りません。</div>${ta(bp + '.text', b.text, 6)}
        <div class="row"><button type="button" class="small" data-act="taigen" data-i="${i}">体言止めの提案</button> 字下げ ${inp(bp + '.indent', b.indent, '0', '40px')}</div>`;
      break;
    case 'text':
      body = `${ta(bp + '.text', b.text, 4)}<div class="row"><button type="button" class="small" data-act="taigen" data-i="${i}">体言止めの提案</button> 字下げ ${inp(bp + '.indent', b.indent, '0', '40px')}</div>`;
      break;
    case 'materials': {
      body = `<div class="row">見出し ${inp(bp + '.label', b.label, '〇PCR pre-mix まとめ作り', '260px')}
        計算 <select data-bind="${bp}.mode"><option value="sample" ${b.mode !== 'volume' ? 'selected' : ''}>サンプル数 × 1量</option><option value="volume" ${b.mode === 'volume' ? 'selected' : ''}>作製量(mL) × 濃度(/L)</option></select>
        ${b.mode === 'volume' ? '' : `数え方 ${inp(bp + '.nunit', b.nunit, 'サンプル', '70px')}`}
        既定の数 ${inp(bp + '.n', b.n, '空欄＝毎回入力', '90px')}
        合計(1量) ${inp(bp + '.total', b.total, '例 10', '60px')} ${inp(bp + '.total_unit', b.total_unit, 'uL', '40px')}
        字下げ ${inp(bp + '.indent', b.indent, '0', '40px')}</div>
        <table class="ed"><tr><th>試薬名</th><th>種類</th><th>${b.mode === 'volume' ? '濃度(/L)' : '1量'}</th><th>単位</th><th>固定の量・( )内の文字</th><th>備考（右側）</th><th>字下げ</th><th></th></tr>
        ${b.rows.map((r, j) => {
          const rp = `${bp}.rows.${j}`;
          return `<tr><td>${inp(rp + '.name', r.name)}</td>
          <td><select data-bind="${rp}.kind">${[['calc', '計算'], ['rest', '残り(合計−他)'], ['text', '固定・空欄'], ['vol', '作製量そのもの']].map(([v, l]) => `<option value="${v}" ${(r.kind || 'calc') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td>${inp(rp + '.per1', r.per1, '', '60px')}</td><td>${inp(rp + '.unit', r.unit, '', '44px')}</td>
          <td>${(r.kind === 'text') ? inp(rp + '.value', r.value, '[[ ]] で空欄') : ''}${(r.kind === 'text' || r.kind === 'vol') ? inp(rp + '.ref', r.ref, '（例）目安：…') : ''}</td>
          <td>${inp(rp + '.note', r.note)}</td><td>${inp(rp + '.indent', r.indent, '', '32px')}</td>
          <td style="white-space:nowrap"><button type="button" class="small" data-act="rowup" data-path="${bp}.rows" data-j="${j}">↑</button><button type="button" class="small" data-act="rowdel" data-path="${bp}.rows" data-j="${j}">×</button></td></tr>`;
        }).join('')}</table>
        <button type="button" class="small" data-act="rowadd" data-path="${bp}.rows">＋ 試薬を追加</button>`;
      break;
    }
    case 'table':
      body = `<div class="row"><label><input type="checkbox" data-bind="${bp}.header_row" ${b.header_row ? 'checked' : ''}> 1行目を見出し(太字)</label>
        <label><input type="checkbox" data-bind="${bp}.header_col" ${b.header_col ? 'checked' : ''}> 1列目を見出し(太字)</label>
        <label><input type="checkbox" data-bind="${bp}.full" ${b.full ? 'checked' : ''}> 横幅いっぱい</label>
        <button type="button" class="small" data-act="tr+" data-i="${i}">＋行</button><button type="button" class="small" data-act="tr-" data-i="${i}">−行</button>
        <button type="button" class="small" data-act="tc+" data-i="${i}">＋列</button><button type="button" class="small" data-act="tc-" data-i="${i}">−列</button>
        字下げ ${inp(bp + '.indent', b.indent, '0', '40px')}</div>
        <table class="ed grid-ed">${b.rows.map((row, r) => `<tr>${row.map((c, ci) => `<td>${inp(`${bp}.rows.${r}.${ci}`, c)}</td>`).join('')}</tr>`).join('')}</table>`;
      break;
    case 'pcr':
      body = `<div class="row">枠の文字 ${inp(bp + '.label', b.label, 'PCR', '80px')}
        くり返し：<select data-bind="${bp}.cyc_from" data-num="1"><option value="">なし</option>${b.steps.map((s, j) => `<option value="${j}" ${+b.cyc_from === j && b.cyc_from !== '' ? 'selected' : ''}>${j + 1}行目</option>`).join('')}</select>
        〜 <select data-bind="${bp}.cyc_to" data-num="1"><option value="">なし</option>${b.steps.map((s, j) => `<option value="${j}" ${+b.cyc_to === j && b.cyc_to !== '' ? 'selected' : ''}>${j + 1}行目</option>`).join('')}</select>
        表示 ${inp(bp + '.cyc_text', b.cyc_text, '×30サイクル', '200px')}</div>
        <table class="ed"><tr><th></th><th>温度</th><th>時間</th><th></th></tr>${b.steps.map((s, j) => `<tr><td>${j + 1}</td><td>${inp(`${bp}.steps.${j}.t`, s.t)}</td><td>${inp(`${bp}.steps.${j}.d`, s.d)}</td>
        <td><button type="button" class="small" data-act="rowup" data-path="${bp}.steps" data-j="${j}">↑</button><button type="button" class="small" data-act="rowdel" data-path="${bp}.steps" data-j="${j}">×</button></td></tr>`).join('')}</table>
        <button type="button" class="small" data-act="pcradd" data-path="${bp}.steps">＋ 段階を追加</button>`;
      break;
    case 'image':
      body = `<div class="row"><input type="file" accept="image/*" data-act="img" data-i="${i}"> 幅 ${inp(bp + '.width', b.width, '100', '50px')} %
        ${b.src ? '<span class="muted">画像あり</span>' : '<span class="muted">画像なし</span>'}</div>`;
      break;
  }
  return `<div class="blk"><div class="blk-head"><span class="type">${BLOCK_TYPES[b.type]}</span><span class="spacer"></span>
    <button type="button" class="small" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
    <button type="button" class="small" data-act="down" data-i="${i}" ${i === n - 1 ? 'disabled' : ''}>↓</button>
    <button type="button" class="small" data-act="dup" data-i="${i}">複製</button>
    <button type="button" class="small danger" data-act="del" data-i="${i}">削除</button></div>${body}
    <div class="addbar" style="margin:6px 0 0"><span class="muted">この下に追加：</span>${Object.entries(BLOCK_TYPES).map(([k, v]) => `<button type="button" class="small" data-act="add" data-type="${k}" data-at="${i + 1}">${v}</button>`).join('')}</div></div>`;
}
function mountEditor(el, doc, onChange, { withMeta = true } = {}) {
  const render = () => {
    el.innerHTML = `
      ${withMeta ? `<div class="card meta"><div class="row">一覧での名前 ${inp('name', doc.name, '例：PCR（温度Gradient）', '260px')}</div></div>` : ''}
      <div class="card meta"><div class="row" style="width:100%">印刷タイトル ${inp('title', doc.title, '●の後ろに入る題名', '360px')}</div></div>
      <div class="card">${markupBar()}
        <div class="addbar"><span class="muted">先頭に追加：</span>${Object.entries(BLOCK_TYPES).map(([k, v]) => `<button type="button" class="small" data-act="add" data-type="${k}" data-at="0">${v}</button>`).join('')}</div>
        ${doc.blocks.map((b, i) => blockEditorHtml(b, i, doc.blocks.length)).join('')}
      </div>
      <div class="card meta"><h3 style="margin-top:0">メモ（解説・注意点など）</h3>
        <div class="muted">印刷するかどうかは記録の画面で選べます。</div>
        ${ta('memo.text', (doc.memo || {}).text, 4)}
        <label><input type="checkbox" data-bind="memo.print" ${(doc.memo || {}).print ? 'checked' : ''}> 最初から「メモも印刷」にしておく</label></div>`;
    bindMarkupBar(el);
  };
  if (!doc.memo) doc.memo = { text: '', print: false };
  render();
  el.oninput = el.onchange = e => {
    const t = e.target;
    if (!t.dataset.bind) return;
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.num && v !== '') v = +v;
    setPath(doc, t.dataset.bind, v);
    if (e.type === 'change' && (t.tagName === 'SELECT')) render();
    onChange();
  };
  el.onclick = e => {
    const t = e.target.closest('[data-act]');
    if (!t || t.type === 'file') return;
    const a = t.dataset.act, i = +t.dataset.i;
    const B = doc.blocks;
    if (a === 'add') B.splice(+t.dataset.at, 0, newBlock(t.dataset.type));
    else if (a === 'up' && i > 0) [B[i - 1], B[i]] = [B[i], B[i - 1]];
    else if (a === 'down' && i < B.length - 1) [B[i + 1], B[i]] = [B[i], B[i + 1]];
    else if (a === 'dup') B.splice(i + 1, 0, clone(B[i]));
    else if (a === 'del') { if (!confirm('このブロックを削除しますか？')) return; B.splice(i, 1); }
    else if (a === 'rowadd') getPath(doc, t.dataset.path).push({ name: '', kind: 'calc', per1: '', unit: 'uL', note: '' });
    else if (a === 'pcradd') getPath(doc, t.dataset.path).push({ t: '', d: '' });
    else if (a === 'rowdel') getPath(doc, t.dataset.path).splice(+t.dataset.j, 1);
    else if (a === 'rowup') { const arr = getPath(doc, t.dataset.path), j = +t.dataset.j; if (j > 0) [arr[j - 1], arr[j]] = [arr[j], arr[j - 1]]; }
    else if (a === 'tr+') B[i].rows.push(B[i].rows[0].map(() => ''));
    else if (a === 'tr-') { if (B[i].rows.length > 1) B[i].rows.pop(); }
    else if (a === 'tc+') B[i].rows.forEach(r => r.push(''));
    else if (a === 'tc-') { if (B[i].rows[0].length > 1) B[i].rows.forEach(r => r.pop()); }
    else if (a === 'taigen') { openTaigen(B[i].text || '', v => { B[i].text = v; render(); onChange(); }); return; }
    else return;
    render(); onChange();
  };
  el.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.act !== 'img' || !t.files[0]) return;
    const fr = new FileReader();
    fr.onload = () => { doc.blocks[+t.dataset.i].src = fr.result; render(); onChange(); };
    fr.readAsDataURL(t.files[0]);
  });
}


// ============================================================
// Word・PDF からの取り込み（大まかな形を自動で作る → あとで編集）
// ============================================================
function loadScript(src) {
  return new Promise((ok, ng) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = () => ng(new Error('読み込み失敗: ' + src));
    document.head.appendChild(sc);
  });
}
function fileToBase64(file) {
  return new Promise((ok, ng) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = ng; fr.readAsDataURL(file); });
}
async function pdfToItems(file) {
  await loadScript('/vendor/pdfjs/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true }).promise;
  const items = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const x = it.transform[4], y = it.transform[5], fs = Math.abs(it.transform[3]) || it.height || 10;
      let row = rows.find(r => Math.abs(r.y - y) < fs * 0.4);
      if (!row) { row = { y, fs, parts: [] }; rows.push(row); }
      row.parts.push({ x, w: it.width, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    const minX = Math.min(...rows.map(r => Math.min(...r.parts.map(p => p.x))));
    let prevY = null;
    for (const r of rows) {
      r.parts.sort((a, b) => a.x - b.x);
      let text = '', end = null;
      for (const pt of r.parts) {
        if (end !== null && pt.x - end > r.fs * 1.2) text += '　';
        text += pt.s; end = pt.x + pt.w;
      }
      if (prevY !== null && prevY - r.y > r.fs * 2.4) items.push({ type: 'p', text: '', plain: '', ind: 0 });
      prevY = r.y;
      const ind = Math.max(0, Math.min(12, Math.round((r.parts[0].x - minX) / r.fs)));
      items.push({ type: 'p', text, plain: text, ind, all_bold: false, any_underline: false, level: null, pdf: true });
    }
    items.push({ type: 'p', text: '', plain: '', ind: 0 });
  }
  return items;
}
function balanceMarks(t) {
  for (const m of ['**', '__', '==', '!!']) {
    const n = t.split(m).length - 1;
    if (n % 2) { const i = t.indexOf(m); t = t.slice(0, i) + t.slice(i + m.length); }
  }
  return t.trim();
}
const stripMarks = t => String(t).replace(/\*\*|__|==|!!/g, '');
function importLines(items) {
  // 段落 → 1行ずつ（字下げは全角スペースで表す）
  const out = [];
  for (const it of items) {
    if (it.type !== 'p') { out.push(it); continue; }
    const rawLines = String(it.text).split('\n');
    const plainLines = String(it.plain).split('\n');
    rawLines.forEach((raw, k) => {
      let lead = 0;
      const m = raw.match(/^[\t 　]*/)[0];
      for (const ch of m) lead += ch === '\t' ? 2 : ch === '　' ? 1 : 0.5;
      let body = raw.slice(m.length).replace(/\t+/g, '　');
      const plain = (plainLines[k] || '').replace(/\t+/g, '　').trim();
      if (it.numbered && k === 0 && body && !/^[・●〇※★①-⑳\-]/.test(plain)) body = '・' + body;
      out.push({ type: 'line', ind: Math.round((it.ind || 0) + lead), text: body, plain, bold: it.all_bold, under: it.any_underline, level: it.level, pdf: it.pdf });
    });
  }
  return out;
}
function isImportTitle(l) {
  if (l.type !== 'line') return false;
  if (l.level === 1) return true;
  return l.ind === 0 && /^●/.test(l.plain) && (l.pdf || l.bold || l.under);
}
const PCR_RE = /^(.{0,40}?℃\)?)\s*[、,，]\s*(.+?)$/;
function pcrLine(plain) {
  const m = plain.match(PCR_RE);
  if (!m || plain.length > 60) return null;
  let rest = m[2], cyc = '';
  const c = rest.match(/^(.*?)[\s　]*([×xX]\s*\d+\s*(サイクル|cycles?|回))\s*$/);
  if (c) { rest = c[1]; cyc = c[2].replace(/\s+/g, ''); }
  if (!/(sec|min|秒|分|h|hr|∞|O\/N)/i.test(rest)) return null;
  return { t: m[1].trim(), d: rest.trim(), cyc };
}
function linesToBlocks(lines) {
  const blocks = [];
  let run = [];
  const isArrow = l => l.type === 'line' && /^[↓⇓]+$/.test(l.plain);
  const flush = () => {
    while (run.length && run[0].plain === '') run.shift();
    while (run.length && run[run.length - 1].plain === '') run.pop();
    if (!run.length) return;
    const hasArrow = run.some(l => isArrow(l) || /^[↓⇓]/.test(l.plain));
    const txt = [];
    if (hasArrow) {
      let prevStep = false, arrow = false;
      for (const l of run) {
        if (l.plain === '') continue;
        if (isArrow(l)) { arrow = true; continue; }
        let text = l.text, ind = l.ind;
        if (/^[↓⇓]/.test(l.plain)) { arrow = true; text = balanceMarks(text.replace(/^(\*\*)?[↓⇓]+(\*\*)?[\s　]*/, '')); ind = Math.max(ind, 1); if (!text) continue; }
        const isStep = ind === 0 && !/^[※＊*]/.test(stripMarks(text));
        if (isStep) { if (prevStep && !arrow) txt.push(''); prevStep = true; arrow = false; }
        txt.push('　'.repeat(ind) + text);
      }
      blocks.push({ type: 'steps', text: txt.join('\n') });
    } else {
      let blank = false;
      for (const l of run) {
        if (l.plain === '') { if (!blank) txt.push(''); blank = true; continue; }
        blank = false; txt.push('　'.repeat(l.ind) + l.text);
      }
      blocks.push({ type: 'text', text: txt.join('\n') });
    }
    run = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.type === 'table') {
      flush();
      let rows = l.rows.map(r => r.map(c => c || ''));
      const wrapped = c => !c || /^\*\*[^*].*\*\*$/.test(c);
      const hr = rows.length > 1 && rows[0].every(wrapped);
      const hc = rows.length > 1 && rows.slice(hr ? 1 : 0).every(r => wrapped(r[0]));
      rows = rows.map((r, ri) => r.map((c, ci) => ((hr && ri === 0) || (hc && ci === 0)) ? c.replace(/^\*\*(.*)\*\*$/, '$1') : c));
      blocks.push({ type: 'table', header_row: hr, header_col: hc, full: rows[0].length >= 5, rows });
      continue;
    }
    if (l.type === 'image') { flush(); blocks.push({ type: 'image', src: l.src, width: 80 }); continue; }
    const pl = l.plain;
    // PCR条件（「98℃、10sec」のような行が3つ以上続く）
    if (pcrLine(pl)) {
      const steps = []; let j = i, cycAt = -1, cycText = '';
      while (j < lines.length) {
        const x = lines[j];
        if (x.type !== 'line') break;
        if (x.plain === '' || isArrow(x)) { j++; continue; }
        const pc = pcrLine(x.plain);
        if (!pc) break;
        if (pc.cyc) { cycAt = steps.length; cycText = pc.cyc; }
        steps.push({ t: pc.t, d: pc.d }); j++;
      }
      if (steps.length >= 3) {
        let label = '';
        const last = run.filter(x => x.plain !== '' && !isArrow(x)).pop();
        if (last && /^[\s　]*PCR[\s　]*$/i.test(last.plain)) { run.splice(run.lastIndexOf(last), 1); label = 'PCR'; }
        flush();
        const from = cycAt < 0 ? '' : Math.max(0, cycAt - 1), to = cycAt < 0 ? '' : Math.min(steps.length - 1, cycAt + 1);
        blocks.push({ type: 'pcr', label: label || 'PCR', steps, cyc_from: from, cyc_to: to, cyc_text: cycText });
        i = j - 1;
        continue;
      }
    }
    // 見出し
    let h = null;
    const short = pl.length <= 40;
    if (short && /^【[^】]+】/.test(pl)) h = ['【】', '【', '】'];
    else if (short && /^〈[^〉]+〉/.test(pl)) h = ['〈〉', '〈', '〉'];
    else if (short && /^<[^>]+>/.test(pl)) h = ['〈〉', '<', '>'];
    else if (short && /^［[^］]+］|^\[[^\]]+\]/.test(pl)) h = ['[]', pl[0], pl[0] === '［' ? '］' : ']'];
    else if (/^●/.test(pl) && l.ind <= 1) h = ['●', '●', null];
    else if (short && /^★/.test(pl) && l.bold) h = ['★', '★', null];
    else if (l.level && l.level >= 2 && short) h = ['なし', null, null];
    if (h) {
      flush();
      let text, extra = '';
      if (h[2]) {
        const close = pl.indexOf(h[2]);
        text = pl.slice(1, close);
        const ci = l.text.indexOf(h[2]);
        extra = ci >= 0 ? balanceMarks(l.text.slice(ci + 1)) : pl.slice(close + 1);
      } else text = h[1] ? pl.slice(1) : pl;
      blocks.push({ type: 'heading', style: h[0], text: text.trim(), extra, indent: l.ind || 0 });
      continue;
    }
    run.push(l);
  }
  flush();
  return blocks;
}
function structureImport(items, fname) {
  const lines = importLines(items);
  const stem = fname.replace(/\.[^.]+$/, '');
  const starts = [];
  lines.forEach((l, i) => { if (isImportTitle(l)) starts.push(i); });
  const make = (title, ls) => ({ name: title, title, blocks: linesToBlocks(ls), memo: { text: '', print: false } });
  if (!starts.length) return [make(stem, lines)].filter(p => p.blocks.length);
  const out = [];
  const pre = lines.slice(0, starts[0]);
  const preText = pre.filter(l => l.type !== 'line' || l.plain).map(l => l.plain || '').join('');
  if (preText.length > 30 && !/目次/.test(preText.slice(0, 10))) out.push(make(stem, pre));
  starts.forEach((st, k) => {
    const title = lines[st].plain.replace(/^●\s*/, '').trim() || stem;
    out.push(make(title, lines.slice(st + 1, k + 1 < starts.length ? starts[k + 1] : lines.length)));
  });
  return out;
}
let pendingImport = null;
async function importFile(file) {
  const name = file.name || '';
  const low = name.toLowerCase();
  let items;
  toast('読み取り中…');
  try {
    if (low.endsWith('.docx')) items = (await api.send('POST', 'import', { name, data: await fileToBase64(file) })).items;
    else if (low.endsWith('.pdf')) items = await pdfToItems(file);
    else if (low.endsWith('.txt')) items = (await file.text()).split(/\r?\n/).map(t => ({ type: 'p', text: t, plain: t, ind: 0, pdf: true }));
    else if (low.endsWith('.doc')) { alert('古い Word 形式（.doc）は読めません。Word で開いて「名前を付けて保存」→「Word 文書 (*.docx)」で保存してから取り込んでください。'); return; }
    else { alert('取り込めるのは Word（.docx）・PDF・テキスト（.txt）です。'); return; }
  } catch (e) { if (!/保存・読み込み/.test(String(e))) alert('読み取れませんでした: ' + e.message); return; }
  const protos = structureImport(items, name);
  if (!protos.length) { alert('文字を読み取れませんでした。（画像だけのPDF＝スキャンした紙などは読み取れません）'); return; }
  if (protos.length === 1) { pendingImport = protos[0]; go('#/protocol/new'); return; }
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3 style="margin-top:0">${protos.length} 件のプロトコルが見つかりました</h3>
    <p class="muted">「●」で始まる太字・下線の行を題名とみなして分けました。登録するものにチェックを入れ、名前を確認してください。登録後に「編集」でいつでも直せます。</p>
    <table class="list">${protos.map((p, i) => `<tr><td><input type="checkbox" data-i="${i}" checked></td><td><input type="text" data-n="${i}" value="${esc(p.name)}" style="width:100%"></td><td class="muted">${p.blocks.length} ブロック</td><td><button class="small" data-open="${i}">これだけ編集画面で開く</button></td></tr>`).join('')}</table>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button data-x>やめる</button><button class="primary" data-ok>チェックしたものを登録</button></div></div>`;
  document.body.appendChild(bg);
  const nameOf = i => bg.querySelector(`[data-n="${i}"]`).value.trim() || protos[i].name;
  bg.onclick = async e => {
    const t = e.target;
    if (t.dataset.x !== undefined) bg.remove();
    else if (t.dataset.open !== undefined) { const p = protos[+t.dataset.open]; p.name = nameOf(+t.dataset.open); pendingImport = p; bg.remove(); go('#/protocol/new'); }
    else if (t.dataset.ok !== undefined) {
      const sel = [...bg.querySelectorAll('input[data-i]:checked')].map(c => +c.dataset.i);
      if (!sel.length) return;
      for (const i of sel) { const p = protos[i]; p.name = nameOf(i); await api.send('POST', 'protocols', { data: p }); }
      bg.remove(); toast(`${sel.length} 件を登録しました`);
      if (location.hash === '#/protocols') viewProtocols(); else go('#/protocols');
    }
  };
}
function importCardHtml() {
  return `<div class="card drop" id="drop"><div class="row"><b>Word・PDFから取り込む</b>
    <label class="btn primary">ファイルを選ぶ<input type="file" id="impfile" accept=".docx,.pdf,.txt,.doc" hidden></label>
    <span class="muted">またはここにファイルをドラッグ＆ドロップ。今までのプロトコルから大まかな形を自動で作ります（取り込んだ後に自由に直せます）。</span></div></div>`;
}
function bindImportCard() {
  const inpEl = document.getElementById('impfile'), drop = document.getElementById('drop');
  inpEl.onchange = () => { if (inpEl.files[0]) importFile(inpEl.files[0]); inpEl.value = ''; };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]); };
}

// ============================================================
// 各画面
// ============================================================
const routes = [
  [/^#?\/?$/, viewHome],
  [/^#\/protocols$/, viewProtocols],
  [/^#\/protocol\/(new|\d+)$/, viewProtocolEdit],
  [/^#\/new\/(\d+)$/, viewNewRecord],
  [/^#\/record\/(\d+)$/, viewRecord],
  [/^#\/records$/, viewRecords],
  [/^#\/print\/(\d+)$/, viewPrint],
  [/^#\/help$/, viewHelp],
];
let currentHash = location.hash;
// 開いている画面を8秒ごとに確認し、他の人の保存やツールの更新を反映する
let pollFn = null, appVersion = null;
async function quietGet(u) { const r = await fetch('/api/' + u, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }
const banners = {};
function showBanner(kind, msg, btnLabel, onClick) {
  if (banners[kind]) return;
  const d = document.createElement('div');
  d.className = 'banner no-print';
  d.innerHTML = `<span>${esc(msg)}</span>${btnLabel ? `<button>${esc(btnLabel)}</button>` : ''}`;
  if (btnLabel) d.querySelector('button').onclick = onClick;
  document.querySelector('.topbar').insertAdjacentElement('afterend', d);
  banners[kind] = d;
}
function hideBanner(kind) { if (banners[kind]) { banners[kind].remove(); delete banners[kind]; } }
function sameView(fn) { const h = location.hash; return async () => { if (location.hash === h) await fn(); }; }
async function rerenderKeepScroll(fn) { const y = window.scrollY; await fn(); window.scrollTo(0, y); }
setInterval(async () => {
  if (document.hidden) return;
  try {
    const info = await quietGet('info');
    if (appVersion && info.version !== appVersion) {
      showBanner('ver', 'ツールが新しくなりました。最新の画面にするには再読み込みしてください。', '再読み込み', () => { if (leaveOk()) location.reload(); });
    }
    if (!appVersion) appVersion = info.version;
    if (pollFn) await pollFn();
  } catch (e) { /* つながらない間は何もしない */ }
}, 8000);
quietGet('info').then(i => { appVersion = i.version; }).catch(() => {});
async function router() {
  if (location.hash !== currentHash && !leaveOk()) { history.replaceState(null, '', currentHash); return; }
  currentHash = location.hash;
  pollFn = null;
  hideBanner('data');
  document.body.classList.toggle('printmode', location.hash.startsWith('#/print/'));
  window.scrollTo(0, 0);
  for (const [re, fn] of routes) { const m = location.hash.match(re); if (m) return fn(...m.slice(1)); }
  viewHome();
}
window.addEventListener('hashchange', router);
function go(h) { location.hash = h; }

async function viewHome() {
  const [ps, rs, info] = await Promise.all([api.get('protocols'), api.get('records'), api.get('info')]);
  const shareCard = info.share ? `<div class="card"><h3 style="margin-top:0">他のPCから開く（共有モードで起動中）</h3>
      ${info.local ? `<p>同じ研究室のネットワークにつながったPCのブラウザで、次のどれかを開いてください（合言葉：${info.password ? 'あり。ユーザー名は空欄か何でもよく、パスワード欄に合言葉を入力' : 'なし'}）。</p>
      <ul>${info.addresses.map(a => `<li><code>${esc(a)}</code></li>`).join('')}</ul>` : '<p>このPCは、ツールを起動しているPCに接続しています。</p>'}
      <p><a class="btn" href="/shortcut.url" download>このPC用のアイコン（ショートカット）をダウンロード</a>
      <span class="muted">ダウンロードした「実験ノート印刷.url」をデスクトップに移すと、ダブルクリックで開けます。</span></p></div>` : '';
  $app.innerHTML = `
    <h2>実験ノート印刷</h2>
    ${info.warn ? `<div class="card" style="background:#fff4ce;border-color:#e0c060"><b>置き場所の注意：</b>${esc(info.warn)}<div class="muted">移すときはツールを終了してから jikken-note フォルダごと移動し、「デスクトップにアイコンを作る.bat」をもう一度実行してください。</div></div>` : ''}
    <div class="card"><h3 style="margin-top:0">新しい記録を書く</h3>
      <div class="row"><select id="psel" style="min-width:320px;font-size:16px;padding:8px">${ps.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <button class="primary big" id="start">このプロトコルで書く</button></div>
      <p class="muted">プロトコルを選ぶと内容がそのまま入ります。黄色の欄（可変欄）だけ入力すれば印刷できます。</p></div>
    <div class="card"><div class="row"><h3 style="margin:0">最近の記録</h3><span class="spacer"></span><a href="#/records">すべて見る →</a></div>
      ${rs.length ? `<table class="list"><tr><th>実験日</th><th>プロトコル</th><th>印刷</th><th></th></tr>${rs.slice(0, 8).map(r => `<tr><td>${esc(r.exp_date)}</td><td>${esc(r.protocol_name)}</td><td class="muted">${r.printed ? esc(r.printed.slice(0, 16)) : '未印刷'}</td><td><a href="#/record/${r.id}">開く</a> ・ <a href="#/print/${r.id}">印刷</a></td></tr>`).join('')}</table>` : '<p class="muted">まだ記録はありません。</p>'}</div>
    ${shareCard}
    ${info.local ? `<div class="card"><div class="row"><h3 style="margin:0">バックアップ</h3><span class="spacer"></span><button id="bk">今すぐバックアップ</button></div>
      <p class="muted">データはすべて <code>data\\notebook.db</code> の1ファイルに入っています。このボタンを押すと <code>backup</code> フォルダに日時つきのコピーを作ります（起動時にも1日1回、自動でコピーします）。</p></div>` : ''}`;
  document.getElementById('start').onclick = () => go('#/new/' + document.getElementById('psel').value);
  if (info.local) document.getElementById('bk').onclick = async () => { const r = await api.send('POST', 'backup'); toast('バックアップしました'); alert('バックアップを作成しました：\n' + r.path); };
  const sig = JSON.stringify([ps, rs]);
  pollFn = sameView(async () => {
    const [a, b] = await Promise.all([quietGet('protocols'), quietGet('records')]);
    if (JSON.stringify([a, b]) === sig) return;
    const sel = document.getElementById('psel').value;
    await rerenderKeepScroll(viewHome);
    const ps2 = document.getElementById('psel'); if (ps2 && [...ps2.options].some(o => o.value === sel)) ps2.value = sel;
  });
}

async function viewProtocols() {
  const ps = await api.get('protocols');
  $app.innerHTML = `<div class="row"><h2>プロトコルの管理</h2><span class="spacer"></span><button class="primary" id="newp">＋ 新しいプロトコル</button></div>
    ${importCardHtml()}
    <div class="card"><table class="list"><tr><th style="width:70px">順番</th><th>名前</th><th>更新</th><th></th></tr>
    ${ps.map((p, i) => `<tr><td><button class="small" data-mv="-1" data-id="${p.id}" ${i === 0 ? 'disabled' : ''}>↑</button><button class="small" data-mv="1" data-id="${p.id}" ${i === ps.length - 1 ? 'disabled' : ''}>↓</button></td>
      <td><a href="#/protocol/${p.id}">${esc(p.name)}</a></td><td class="muted">${esc(p.updated.slice(0, 16))}</td>
      <td style="white-space:nowrap"><a class="btn small" href="#/new/${p.id}">記録を書く</a> <a class="btn small" href="#/protocol/${p.id}">編集</a>
      <button class="small" data-dup="${p.id}">複製</button> <button class="small danger" data-del="${p.id}" data-name="${esc(p.name)}">削除</button></td></tr>`).join('')}</table></div>`;
  document.getElementById('newp').onclick = () => go('#/protocol/new');
  bindImportCard();
  const sig = JSON.stringify(ps);
  pollFn = sameView(async () => { if (JSON.stringify(await quietGet('protocols')) !== sig) await rerenderKeepScroll(viewProtocols); });
  $app.onclick = async e => {
    const t = e.target;
    if (t.dataset.mv) { await api.send('POST', `protocols/${t.dataset.id}/move`, { dir: +t.dataset.mv }); viewProtocols(); }
    else if (t.dataset.dup) { await api.send('POST', `protocols/${t.dataset.dup}/duplicate`); toast('複製しました'); viewProtocols(); }
    else if (t.dataset.del) { if (confirm(`「${t.dataset.name}」を削除しますか？\n（これまでの記録は消えません）`)) { await api.send('DELETE', `protocols/${t.dataset.del}`); viewProtocols(); } }
  };
}

async function viewProtocolEdit(id) {
  $app.onclick = null;
  let base = null, doc;
  const imported = id === 'new' && pendingImport;
  if (imported) { doc = pendingImport; pendingImport = null; }
  else if (id === 'new') doc = { name: '', title: '', blocks: [newBlock('heading'), newBlock('steps')], memo: { text: '', print: false } };
  else { const pr = await api.get('protocols/' + id); doc = pr.data; base = pr.updated; }
  if (id === 'new' && !imported) { doc.blocks[0].text = '材料'; }
  $app.innerHTML = `<div class="toolbar"><div class="row"><h2 style="margin:0">${id === 'new' ? '新しいプロトコル' : 'プロトコルの編集'}</h2><span class="spacer"></span>
      <label><input type="checkbox" id="chem" checked> 化学式の数字を下付き</label>
      <a class="btn" href="#/protocols">一覧へ戻る</a> <button class="primary" id="save">保存</button></div></div>
    <div class="split"><div id="ed"></div><div class="preview-wrap"><div class="legend">印刷イメージ（幅17cm）　<span class="sw" style="background:#d9d9d9">灰色</span>＝可変欄　赤い横線＝ページの区切り（目安）</div><div id="pv"></div></div></div>`;
  const pv = document.getElementById('pv');
  const chem = document.getElementById('chem');
  const draw = () => { pv.innerHTML = renderDoc(doc, { mode: 'preview', memo: true, chem: chem.checked }); };
  let t;
  mountEditor(document.getElementById('ed'), doc, () => { dirty = true; clearTimeout(t); t = setTimeout(draw, 250); });
  chem.onchange = draw;
  draw();
  if (imported) { dirty = true; showBanner('data', '取り込んだ内容です。右の印刷イメージを見ながら直して、最後に「保存」を押してください（まだ保存されていません）。'); }
  document.getElementById('save').onclick = async () => {
    if (!doc.name) doc.name = doc.title || '無題';
    if (id === 'new') { const r = await api.send('POST', 'protocols', { data: doc }); dirty = false; toast('保存しました'); go('#/protocol/' + r.id); }
    else { const u = await putWithCheck('protocols/' + id, doc, base); if (u) { base = u; dirty = false; hideBanner('data'); toast('保存しました'); } }
  };
  if (id !== 'new') pollFn = sameView(async () => {
    const pr = await quietGet('protocols/' + id);
    if (!(pr.updated > base)) return;
    if (!dirty) { await rerenderKeepScroll(() => viewProtocolEdit(id)); toast('他の人の更新を反映しました'); }
    else showBanner('data', '他の人がこのプロトコルを更新しました。このまま保存すると確認が出ます。', '相手の内容を読み込む（自分の変更は捨てる）', () => { dirty = false; hideBanner('data'); viewProtocolEdit(id); });
  });
}

async function viewNewRecord(pid) {
  const p = await api.get('protocols/' + pid);
  const pd = p.data;
  const rec = {
    protocol_id: p.id, protocol_name: pd.name, exp_date: today(),
    doc: { title: pd.title, blocks: clone(pd.blocks), memo: clone(pd.memo || { text: '', print: false }) },
    opts: { chem: true, memo: !!(pd.memo && pd.memo.print), date: true, cut: true },
  };
  recordEditor(rec, null, null);
}
async function viewRecord(id) {
  const r = await api.get('records/' + id);
  recordEditor(r.data, +id, r.updated);
}
function recordEditor(rec, id, base) {
  $app.onclick = null;
  let tab = 'fill';
  $app.innerHTML = `<div class="toolbar">
      <div class="row"><h2 style="margin:0">${esc(rec.protocol_name)}</h2><span class="muted">${id ? `記録 No.${id}` : '新しい記録（まだ保存していません）'}</span><span class="spacer"></span>
        <a class="btn" href="#/records">一覧へ</a>
        <button id="save">保存</button>
        <button class="primary" id="toPrint">保存して印刷プレビュー</button></div>
      <div class="row" style="margin-top:8px">実験日 <input type="date" id="date" value="${esc(rec.exp_date)}">
        <label><input type="checkbox" id="o-date" ${rec.opts.date ? 'checked' : ''}> 日付を印字</label>
        <label><input type="checkbox" id="o-chem" ${rec.opts.chem !== false ? 'checked' : ''}> 化学式の数字を下付き</label>
        <label><input type="checkbox" id="o-memo" ${rec.opts.memo ? 'checked' : ''}> メモも印刷</label>
        <label><input type="checkbox" id="o-cut" ${rec.opts.cut ? 'checked' : ''}> 切り取り線（17×27cm）</label>
        <span class="muted" id="blanks"></span></div>
      <div class="tabs"><button data-tab="fill" class="on">入力（黄色の欄だけ）</button><button data-tab="edit">全体を編集</button></div></div>
    <div id="body"></div>`;
  const body = document.getElementById('body');
  const doc = rec.doc;
  const upd = () => { const n = countBlanks(doc); document.getElementById('blanks').textContent = n ? `未入力の可変欄：${n}個` : '可変欄はすべて入力済み'; };
  const drawFill = () => {
    body.innerHTML = `<div class="legend">黄色の欄に入力してください（Tabキーで次の欄へ）。空欄のまま印刷すると、手書き用の灰色の空欄になります。</div>${renderDoc(doc, { mode: 'fill', date: rec.opts.date ? rec.exp_date : '', memo: rec.opts.memo, chem: rec.opts.chem !== false })}`;
    upd();
  };
  const drawEdit = () => {
    body.innerHTML = `<div class="split"><div id="ed"></div><div class="preview-wrap"><div class="legend">印刷イメージ</div><div id="pv"></div></div></div>`;
    const pv = document.getElementById('pv');
    const draw = () => { pv.innerHTML = renderDoc(doc, { mode: 'preview', date: rec.opts.date ? rec.exp_date : '', memo: rec.opts.memo, chem: rec.opts.chem !== false }); upd(); };
    let t;
    mountEditor(document.getElementById('ed'), doc, () => { dirty = true; clearTimeout(t); t = setTimeout(draw, 250); }, { withMeta: false });
    draw();
  };
  const redraw = () => (tab === 'fill' ? drawFill() : drawEdit());
  redraw();
  body.addEventListener('input', e => {
    const t = e.target;
    if (!t.classList.contains('vin')) return;
    dirty = true;
    if (t.dataset.num) setPath(doc, t.dataset.path, t.value);
    else setPath(doc, t.dataset.path, setToken(getPath(doc, t.dataset.path), +t.dataset.k, t.value));
    t.classList.toggle('empty', !t.value);
    t.style.width = Math.max(3, Math.min(30, (t.value || t.placeholder || '').length * 0.75 + 1.5)) + 'em';
    upd();
  });
  body.addEventListener('change', e => {
    if (!e.target.classList.contains('vin') || tab !== 'fill') return;
    setTimeout(() => {
      const key = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
      const y = window.scrollY;
      drawFill();
      window.scrollTo(0, y);
      if (key) { const el = body.querySelector(`[data-key="${CSS.escape(key)}"]`); if (el) el.focus(); }
    }, 0);
  });
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
    redraw();
  });
  const optBind = (elId, key) => document.getElementById(elId).onchange = e => { rec.opts[key] = e.target.checked; dirty = true; redraw(); };
  optBind('o-date', 'date'); optBind('o-chem', 'chem'); optBind('o-memo', 'memo'); optBind('o-cut', 'cut');
  document.getElementById('date').onchange = e => { rec.exp_date = e.target.value; dirty = true; redraw(); };
  const save = async () => {
    if (id) { const u = await putWithCheck('records/' + id, rec, base); if (!u) return null; base = u; }
    else { const r = await api.send('POST', 'records', { data: rec }); id = r.id; base = (await api.get('records/' + id)).updated; }
    dirty = false;
    hideBanner('data');
    return id;
  };
  document.getElementById('save').onclick = async () => {
    const wasNew = !id;
    if (!(await save())) return;
    toast('保存しました');
    if (wasNew) { currentHash = '#/record/' + id; history.replaceState(null, '', currentHash); document.querySelector('.toolbar .muted').textContent = `記録 No.${id}`; }
  };
  document.getElementById('toPrint').onclick = async () => {
    const n = countBlanks(doc);
    if (n && !confirm(`未入力の可変欄が ${n} 個あります。\n空欄のまま進むと、手書き用の灰色の空欄として印刷されます。進みますか？`)) return;
    if (!(await save())) return;
    go('#/print/' + id);
  };
  pollFn = sameView(async () => {
    if (!id) return;
    const r = await quietGet('records/' + id);
    if (!(r.updated > base)) return;
    if (!dirty) { await rerenderKeepScroll(() => viewRecord(id)); toast('他の人の更新を反映しました'); }
    else showBanner('data', '他の人がこの記録を更新しました。このまま保存すると確認が出ます。', '相手の内容を読み込む（自分の変更は捨てる）', () => { dirty = false; hideBanner('data'); viewRecord(id); });
  });
}

async function viewRecords() {
  $app.onclick = null;
  $app.innerHTML = `<div class="row"><h2>記録の一覧</h2><span class="spacer"></span><input type="text" id="q" placeholder="検索（プロトコル名・日付・中身の文字）" style="width:320px"></div><div class="card" id="list">読み込み中…</div>`;
  const list = document.getElementById('list');
  let sig = '';
  pollFn = sameView(async () => {
    const q = document.getElementById('q').value.trim();
    if (JSON.stringify(await quietGet('records' + (q ? '?q=' + encodeURIComponent(q) : ''))) !== sig) await load();
  });
  const load = async () => {
    const q = document.getElementById('q').value.trim();
    const rs = await api.get('records' + (q ? '?q=' + encodeURIComponent(q) : ''));
    sig = JSON.stringify(rs);
    list.innerHTML = rs.length ? `<table class="list"><tr><th>No.</th><th>実験日</th><th>プロトコル</th><th>保存</th><th>印刷</th><th></th></tr>
      ${rs.map(r => `<tr><td>${r.id}</td><td>${esc(r.exp_date)}</td><td><a href="#/record/${r.id}">${esc(r.protocol_name)}</a></td>
        <td class="muted">${esc(r.updated.slice(0, 16))}</td><td class="muted">${r.printed ? esc(r.printed.slice(0, 16)) : '未印刷'}</td>
        <td style="white-space:nowrap"><a class="btn small" href="#/record/${r.id}">開く</a> <a class="btn small" href="#/print/${r.id}">もう一度印刷</a>
        <button class="small" data-dup="${r.id}">複製して次の実験へ</button> <button class="small danger" data-del="${r.id}">削除</button></td></tr>`).join('')}</table>` : '<p class="muted">記録はありません。</p>';
  };
  let t;
  document.getElementById('q').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  list.onclick = async e => {
    const tg = e.target;
    if (tg.dataset.dup) { const r = await api.send('POST', `records/${tg.dataset.dup}/duplicate`); toast('複製しました（実験日は今日になっています）'); go('#/record/' + r.id); }
    else if (tg.dataset.del) { if (confirm(`記録 No.${tg.dataset.del} を削除しますか？（元に戻せません）`)) { await api.send('DELETE', `records/${tg.dataset.del}`); load(); } }
  };
  load();
}

async function viewPrint(id) {
  $app.onclick = null;
  const r = await api.get('records/' + id);
  const rec = r.data;
  $app.innerHTML = `<div class="toolbar no-print"><div class="row"><h2 style="margin:0">印刷プレビュー</h2><span class="muted">${esc(rec.protocol_name)}　記録 No.${id}</span><span class="spacer"></span>
      <a class="btn" href="#/record/${id}">← 入力に戻る</a> <button class="primary big" id="pr">印刷する</button></div>
      <div class="muted" style="margin-top:6px">印刷画面では「用紙サイズ：A4」「倍率：100%（既定）」「余白：既定」にし、「ヘッダーとフッター」のチェックを外してください。赤い横線はページの区切りの目安で、印刷はされません。</div></div>
    ${renderDoc(rec.doc, { mode: 'print', date: rec.opts.date ? rec.exp_date : '', memo: rec.opts.memo, chem: rec.opts.chem !== false })}
    <div class="cutguide ${rec.opts.cut ? 'on' : ''}"></div>`;
  document.getElementById('pr').onclick = () => window.print();
  pollFn = sameView(async () => { const r2 = await quietGet('records/' + id); if (r2.updated !== r.updated) await rerenderKeepScroll(() => viewPrint(id)); });
  window.onafterprint = async () => { if (location.hash === '#/print/' + id) { await api.send('POST', `records/${id}/printed`); toast('印刷日時を記録しました'); } };
}

function viewHelp() {
  $app.onclick = null;
  const ex = (s, chem = true) => `<span class="sheet" style="display:inline;box-shadow:none;background:none;padding:0;width:auto">${inlineFmt(s, { mode: 'preview', chem })}</span>`;
  $app.innerHTML = `<h2>書き方のヘルプ</h2>
  <div class="card"><h3 style="margin-top:0">文字の書式</h3><table class="help-table"><tr><th>書き方</th><th>印刷</th><th>意味</th></tr>
    ${[['[[サンプル数]]', '毎回変わる欄（可変欄）。入力画面で黄色の欄になる。空欄のまま印刷すると灰色の手書き欄'],
       ['[[=5.6]]', '既定値つきの可変欄（ラベルなし）'], ['[[温度=37]]℃', '既定値つきの可変欄（ラベルあり）'],
       ['**Buffer P1**', '太字'], ['==37℃==', '強調（黄色の蛍光ペン）'], ['!!無菌操作!!', '注意（赤字）'], ['__50mLファルコン__', '下線'], ['||PCR||', '枠囲み'],
       ['Orc2(1-236)', '自動：タンパク質名の直後の残基範囲は上付き'], ['His12, His6-Orc2', '自動：タグの個数は下付き'],
       ['MgCl2, (NH4)2SO4, H2O', '自動：化学式の数字は下付き（記録画面のチェックで切り替え）'],
       ['Mg^{2+}', '手動の上付き'], ['K_{d}', '手動の下付き']].map(([s, m]) => `<tr><td><code>${esc(s)}</code></td><td>${ex(s)}</td><td>${esc(m)}</td></tr>`).join('')}</table>
    <p class="muted">自動変換が困るとき（例：プライマー名 KO1 などが化学式と誤認されたとき）は、記録画面の「化学式の数字を下付き」を外すか、^{ } _{ } で手動で書いてください。</p></div>
  <div class="card"><h3 style="margin-top:0">操作手順ブロックの書き方</h3>
    <pre style="font-family:var(--mincho);background:#f7f7f7;padding:10px">・遠心（14,000rpm、1min、25℃）
・上清をピペットで除く
　・字下げした行は補足（矢印は入らない）
※「※」で始まる行も補足

・空行で区切ると、次のステップとの間に矢印が入らない</pre>
    ${renderSteps('・遠心（14,000rpm、1min、25℃）\n・上清をピペットで除く\n　・字下げした行は補足（矢印は入らない）\n※「※」で始まる行も補足\n\n・空行で区切ると、次のステップとの間に矢印が入らない', { mode: 'print', chem: true }).replace(/^/, '<div class="sheet" style="box-shadow:none">') + '</div>'}</div>`;
}

router();
