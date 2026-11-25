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
  if (j && j.login) { alert(j.error + (dirty ? '\n（入力中の内容は保存されていません）' : '')); dirty = false; location.reload(); throw new Error('login'); }
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
  // 行頭の空白（半角・全角・タブ・Word由来の特殊なスペース）を字下げとして数える
  const m = line.match(/^[ 　\t\u00a0\u2000-\u200b\u202f\u205f]*/)[0];
  let ind = 0;
  for (const ch of m) ind += ch === '　' ? 1 : ch === '\t' ? 2 : ch === '\u200b' ? 0 : 0.5;
  if (m.length && ind === 0) ind = 0.5;
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
  // 1行1ステップ。字下げした行・※で始まる行は補足。
  // ステップの間には下向きの矢印を自動で入れる。補足があるときは、矢印が補足の横を通って長くなる。
  // 空行で区切ると矢印は入らない。
  // 行頭に空白（半角・全角）がある行と「※」で始まる行は補足。補足の間の空行も飛び越えて、
  // 次の「行頭から始まる行」まで矢印をつなげる。空行のすぐ後が行頭から始まる行なら矢印は入らない。
  const isNote = (ind, text) => ind > 0 || /^[※＊*]/.test(String(text).replace(/\*\*|__|==|!!/g, ''));
  const rows = String(str || '').split('\n').map(splitIndent).filter(r => !/^[↓⇓]$/.test(r.text.trim()));
  const groups = [[]];
  rows.forEach((r, i) => {
    const g = groups[groups.length - 1];
    if (r.text.trim() === '') {
      const next = rows.slice(i + 1).find(x => x.text.trim() !== '');
      if (g.length && next && isNote(next.ind, next.text)) g[g.length - 1].notes.push({ blank: true });
      else if (g.length) groups.push([]);
      return;
    }
    if (!isNote(r.ind, r.text)) g.push({ step: r.text, notes: [] });
    else if (g.length) g[g.length - 1].notes.push({ ind: r.ind, text: r.text });
    else g.push({ step: null, notes: [{ ind: r.ind, text: r.text }] });
  });
  const noteHtml = (n, minInd) => n.blank ? '<div class="gap"></div>' : lineHtml(n.text, Math.max(n.ind, minInd), ctx);
  const parts = [];
  for (const g of groups) {
    if (!g.length) continue;
    let h = '';
    g.forEach((st, i) => {
      if (st.step !== null) h += `<div class="stepgrp">${lineHtml(st.step, 0, ctx)}</div>`;
      const next = g[i + 1];
      if (st.step !== null && next && next.step !== null) {
        h += `<div class="flow"><div class="flow-arrow"></div>${st.notes.map(n => noteHtml(n, 1.2)).join('')}<div class="flow-end"></div></div>`;
      } else {
        h += st.notes.map(n => noteHtml(n, 0)).join('');
      }
    });
    parts.push(h);
  }
  return parts.join('<div class="gap"></div>');
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
      case 'tubes': inner = renderTubes(b, bp, ctx); break;
      case 'gel': inner = renderGel(b, bp, ctx); break;
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
  heading: '見出し', steps: '操作手順（↓自動）', text: '文章', materials: '試薬と量（自動計算）', table: '表', pcr: 'PCR条件', image: '画像', tubes: 'チューブ配置図', gel: '泳動画像（レーン名）',
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
    case 'tubes': return { type, label: '8連チューブ', count: 8, strip: true, legend: true, tubes: Array.from({ length: 8 }, (_, k) => ({ mark: String(k + 1), name: '', kind: 's', vol: '' })) };
    case 'gel': return { type, label: '電気泳動', note: '', src: '', nw: 0, nh: 0, width: 80, crop: { t: 0, b: 0, l: 0, r: 0 }, bright: 100, contrast: 100, count: 8, unit: '(bp)', markers: [], lanes: Array.from({ length: 8 }, (_, k) => ({ mark: k === 0 ? 'M' : String(k), name: '', x: (k + 0.5) / 8 })) };
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
      body = `<div class="muted">1行に1ステップ。ステップの間には下向きの矢印が自動で入ります。行頭にスペース（半角・全角どちらでも）がある行と「※」で始まる行は補足になり、矢印は補足（間の空行も含む）を飛び越えて次の行頭から始まる行まで続きます。空行のすぐ後に行頭から始まる行を書くと、そこには矢印が入りません。</div>${ta(bp + '.text', b.text, 6)}
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
    case 'tubes': body = tubesEdHtml(b, bp); break;
    case 'gel': body = gelEdHtml(b, bp); break;
    case 'image':
      body = `<div class="imgdrop" data-imgdrop="${i}">${b.src ? `<img src="${b.src}" alt="">` : ''}<span>ここに画像をドラッグ＆ドロップ（PNG・JPEG など）</span></div>
        <div class="row"><input type="file" accept="image/*" data-act="img" data-i="${i}"> 幅 ${inp(bp + '.width', b.width, '100', '50px')} %
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
function mountEditor(el, doc, onChange, { withMeta = true, onTags = null } = {}) {
  const render = () => {
    el.innerHTML = `
      ${withMeta ? `<div class="card meta"><div class="row">一覧での名前 ${inp('name', doc.name, '例：PCR（温度Gradient）', '260px')}</div></div>` : ''}
      <div class="card meta"><div class="row" style="width:100%">印刷タイトル ${inp('title', doc.title, '●の後ろに入る題名', '360px')}</div>
        ${withMeta ? `<div class="row" style="margin-top:8px">タグ <span id="pe-tags">${tagBoxHtml(doc.tags || [])}</span></div>
        <div class="muted">同じタグの注意点が、このプロトコルで記録を書くときに自動で表示されます（例：PCR、無菌操作、DMSO）。</div>` : ''}</div>
      <div class="card">${markupBar()}
        <div class="addbar"><span class="muted">先頭に追加：</span>${Object.entries(BLOCK_TYPES).map(([k, v]) => `<button type="button" class="small" data-act="add" data-type="${k}" data-at="0">${v}</button>`).join('')}</div>
        ${doc.blocks.map((b, i) => blockEditorHtml(b, i, doc.blocks.length)).join('')}
      </div>
      <div class="card meta"><h3 style="margin-top:0">メモ（解説・注意点など）</h3>
        <div class="muted">印刷するかどうかは記録の画面で選べます。</div>
        ${ta('memo.text', (doc.memo || {}).text, 4)}
        ${withMeta ? '<button type="button" class="small" data-act="memo2notes">このメモを「注意点・考え方」に移す</button>' : ''}
        <label><input type="checkbox" data-bind="memo.print" ${(doc.memo || {}).print ? 'checked' : ''}> 最初から「メモも印刷」にしておく</label></div>`;
    bindMarkupBar(el);
    bindGelDrag(el, doc, () => { render(); onChange(); });
    bindTagBox(el.querySelector('#pe-tags .tagbox'), () => doc.tags || [], t => { doc.tags = t; }, () => { onChange(); if (onTags) onTags(doc.tags); });
  };
  if (!doc.memo) doc.memo = { text: '', print: false };
  render();
  el.oninput = el.onchange = e => {
    const t = e.target;
    if (!t.dataset.bind) return;
    applyBind(doc, t);
    if (t.dataset.live) { refreshGelPreview(el, doc, t); bindGelDrag(el, doc, () => { render(); onChange(); }); }
    if (e.type === 'change' && (t.tagName === 'SELECT' || t.dataset.resize || t.dataset.live)) render();
    onChange();
  };
  el.onclick = e => {
    const f = e.target.closest('[data-fig]');
    if (f) { if (figAction(doc, f)) { render(); onChange(); } return; }
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
    else if (a === 'memo2notes') { openMemoToNotes(doc, clear => { if (clear) { doc.memo.text = ''; render(); onChange(); } }); return; }
    else return;
    render(); onChange();
  };
  const setImage = makeImageSetter(doc, () => { render(); onChange(); });
  imageDropHandler = setImage;
  el.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.act !== 'img' || !t.files[0]) return;
    setImage(+t.dataset.i, t.files[0]);
  });
  return { render };
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
async function readImportFile(file) {
  const name = file.name || '';
  const low = name.toLowerCase();
  let items;
  try {
    if (low.endsWith('.docx')) items = (await api.send('POST', 'import', { name, data: await fileToBase64(file) })).items;
    else if (low.endsWith('.pdf')) items = await pdfToItems(file);
    else if (low.endsWith('.txt')) items = (await file.text()).split(/\r?\n/).map(t => ({ type: 'p', text: t, plain: t, ind: 0, pdf: true }));
    else if (low.endsWith('.doc')) { alert(`「${name}」は古い Word 形式（.doc）なので読めません。Word で開いて「名前を付けて保存」→「Word 文書 (*.docx)」で保存してから取り込んでください。`); return []; }
    else { alert(`「${name}」は取り込めません。取り込めるのは Word（.docx）・PDF・テキスト（.txt）です。`); return []; }
  } catch (e) { if (!/保存・読み込み/.test(String(e))) alert(`「${name}」を読み取れませんでした: ` + e.message); return []; }
  const protos = structureImport(items, name);
  if (!protos.length) alert(`「${name}」から文字を読み取れませんでした。（画像だけのPDF＝スキャンした紙などは読み取れません）`);
  return protos;
}
async function importFile(file) { return importFiles([file]); }
async function importFiles(files) {
  files = [...files];
  if (!files.length) return;
  toast(files.length > 1 ? `${files.length} 個のファイルを読み取り中…` : '読み取り中…');
  let protos = [];
  for (const f of files) protos = protos.concat(await readImportFile(f));
  if (!protos.length) return;
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
    <label class="btn primary">ファイルを選ぶ<input type="file" id="impfile" accept=".docx,.pdf,.txt,.doc" multiple hidden></label>
    <span class="muted">またはファイルを画面のどこかにドラッグ＆ドロップ（複数ファイルもまとめて取り込めます）。今までのプロトコルから大まかな形を自動で作ります（取り込んだ後に自由に直せます）。</span></div></div>`;
}
function bindImportCard() {
  const inpEl = document.getElementById('impfile'), drop = document.getElementById('drop');
  inpEl.onchange = () => { if (inpEl.files.length) importFiles(inpEl.files); inpEl.value = ''; };
}

// ---------- ドラッグ＆ドロップ（画面のどこに落としても取り込む） ----------
let imageDropHandler = null;
(() => {
  const ov = document.createElement('div');
  ov.id = 'dropov'; ov.className = 'no-print';
  document.body.appendChild(ov);
  let depth = 0;
  const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const zoneOf = e => (e.target && e.target.closest) ? e.target.closest('[data-imgdrop]') : null;
  const hide = () => { depth = 0; ov.classList.remove('on'); document.querySelectorAll('.imgdrop.over').forEach(z => z.classList.remove('over')); };
  document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; ov.classList.add('on'); });
  document.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    const z = zoneOf(e);
    document.querySelectorAll('.imgdrop.over').forEach(x => { if (x !== z) x.classList.remove('over'); });
    if (z) z.classList.add('over');
    ov.textContent = z ? 'ここで離すと、この画像ブロックに画像を入れます' : 'ここで離すと取り込みます（Word・PDF・テキスト。複数ファイルもOK）';
    ov.classList.toggle('img', !!z);
  });
  document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) hide(); });
  document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();   // ブラウザがファイルを開いてしまうのを防ぐ
    const z = zoneOf(e);
    hide();
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    if (z && imageDropHandler && document.body.contains(z)) { imageDropHandler(+z.dataset.imgdrop, files[0]); return; }
    const docs = files.filter(f => !/^image\//.test(f.type));
    if (!docs.length) { alert('画像は、プロトコル編集画面の「画像」ブロックの枠にドロップしてください。'); return; }
    importFiles(docs);
  });
})();


// ============================================================
// 図：チューブ配置図（PCRの8連チューブなど）・泳動画像（レーン名つき）
// ============================================================
const TUBE_KINDS = { s: ['サンプル', '#ffffff'], p: ['陽性対照', '#9fd3a0'], n: ['陰性対照', '#f4b6b6'], e: ['空き', ''] };
function textWidthEm(raw) {
  // 斜めに書く名前の長さの目安（全角=1、半角=0.55）
  let w = 0;
  for (const ch of stripMarks(String(raw || '').replace(TOKEN_RE, (m, inner) => parseToken(inner).value || parseToken(inner).label || '　　'))) w += /[ -~]/.test(ch) ? 0.55 : 1;
  return w;
}
function resizeFig(b) {
  if (b.type === 'tubes') {
    const n = Math.max(1, Math.min(24, parseInt(b.count) || 1));
    b.count = n;
    while (b.tubes.length < n) b.tubes.push({ mark: String(b.tubes.length + 1), name: '', kind: 's', vol: '' });
    b.tubes.length = n;
  } else if (b.type === 'gel') {
    const n = Math.max(1, Math.min(30, parseInt(b.count) || 1));
    const changed = n !== b.lanes.length;
    b.count = n;
    while (b.lanes.length < n) b.lanes.push({ mark: String(b.lanes.length), name: '', x: 0 });
    b.lanes.length = n;
    if (changed) b.lanes.forEach((l, k) => { l.x = (k + 0.5) / n; });
  }
}
function equalizeLanes(b) {
  const n = b.lanes.length;
  if (n < 2) { if (n) b.lanes[0].x = 0.5; return; }
  const a = b.lanes[0].x, z = b.lanes[n - 1].x;
  b.lanes.forEach((l, k) => { l.x = a + (z - a) * k / (n - 1); });
}
function rotatedNames(items, ctx, heightEm) {
  // items: [{left:'css位置', html}]  斜め45°の名前
  return `<div class="rot-names" style="height:${heightEm}em">${items.map(it => `<div class="rot" style="left:${it.left}"><span>${it.html}</span></div>`).join('')}</div>`;
}
function renderTubes(b, bp, ctx) {
  const n = b.tubes.length;
  const cw = Math.min(15, 164 / n);   // 1本の幅(mm)
  const maxW = Math.max(0, ...b.tubes.map(t => textWidthEm(t.name)));
  const nameH = maxW ? Math.min(14, maxW * 0.72 + 0.9) : 0;
  const uid = 'tb' + Math.random().toString(36).slice(2, 8);
  const names = maxW ? rotatedNames(b.tubes.map((t, k) => ({ left: `${cw * (k + 0.5)}mm`, html: inlineFmt(t.name, { ...ctx, mode: ctx.mode === 'fill' ? 'print' : ctx.mode }) })), ctx, nameH) : '';
  const fs = Math.min(11, cw * 0.95);   // 印の文字サイズ(pt)
  const tubes = b.tubes.map((t, k) => {
    const kind = TUBE_KINDS[t.kind] ? t.kind : 's';
    const fill = kind === 'e' ? `url(#${uid}h)` : TUBE_KINDS[kind][1];
    return `<div class="tube" style="width:${cw}mm">
      <svg viewBox="0 0 40 84" preserveAspectRatio="none" class="tube-svg">
        <defs><pattern id="${uid}h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#fff"/><line x1="0" y1="0" x2="0" y2="5" stroke="#999" stroke-width="1.6"/></pattern></defs>
        <rect x="3" y="1" width="34" height="7" fill="#fff" stroke="#000" stroke-width="1.3"/>
        <path d="M6 8 h28 v40 l-9 33 h-10 l-9 -33 z" fill="${fill}" stroke="#000" stroke-width="1.3"/>
      </svg>
      <div class="tube-mark" style="font-size:${fs}pt">${inlineFmt(t.mark, { ...ctx, mode: 'print' })}</div>
      ${t.vol ? `<div class="tube-vol" style="font-size:${Math.min(8, fs * 0.7)}pt">${inlineFmt(t.vol, { ...ctx, mode: 'print' })}</div>` : ''}
    </div>`;
  }).join('');
  const used = [...new Set(b.tubes.map(t => TUBE_KINDS[t.kind] ? t.kind : 's'))];
  const legend = b.legend && used.length > 1 ? `<div class="tube-legend">${used.map(k => `<span class="sw ${k === 'e' ? 'hatch' : ''}" style="background:${TUBE_KINDS[k][1] || ''}"></span>${TUBE_KINDS[k][0]}`).join('　')}</div>` : '';
  const head = b.label ? `<div class="blk-h">【${inlineFmt(b.label, { ...ctx, mode: 'print' })}】</div>` : '';
  const html = `<div class="tubes" style="width:${cw * n}mm">${head}${names}${b.strip ? `<div class="tube-strip"></div>` : ''}<div class="tube-row">${tubes}</div>${legend}</div>`;
  return html + (ctx.mode === 'fill' ? `<details class="fig-ed no-print" open><summary>この図を編集（サンプル名・印・本数など）</summary>${tubesEdHtml(b, bp)}</details>` : '');
}
function gelImgBox(b, extra = '') {
  const c = b.crop || { t: 0, b: 0, l: 0, r: 0 };
  const fw = Math.max(0.05, 1 - (c.l + c.r) / 100), fh = Math.max(0.05, 1 - (c.t + c.b) / 100);
  const ar = (b.nw && b.nh) ? (b.nw * fw) / (b.nh * fh) : 1.4;
  return `<div class="g-img" style="aspect-ratio:${ar}"><img src="${b.src}" alt="" style="width:${100 / fw}%;left:${-c.l / fw}%;top:${-c.t / fh}%;filter:brightness(${b.bright || 100}%) contrast(${b.contrast || 100}%)">${extra}</div>`;
}
function renderGel(b, bp, ctx) {
  const head = b.label ? `<div class="blk-h">【${inlineFmt(b.label, { ...ctx, mode: 'print' })}】${b.note ? `<span class="extra">${inlineFmt(b.note, { ...ctx, mode: 'print' })}</span>` : ''}</div>` : '';
  if (!b.src) {
    const ph = `<div class="gel-empty">（泳動画像なし）</div>`;
    return head + ph + (ctx.mode === 'fill' ? `<details class="fig-ed no-print" open><summary>この図を編集（画像・レーン名など）</summary>${gelEdHtml(b, bp)}</details>` : '');
  }
  const mks = (b.markers || []).filter(m => m.label);
  const mkW = mks.length ? Math.max(2.2, ...mks.map(m => textWidthEm(m.label) + 0.8), textWidthEm(b.unit || '') + 0.4) : 0;
  const maxW = Math.max(0, ...b.lanes.map(l => textWidthEm(l.name)));
  const nameH = maxW ? Math.min(14, maxW * 0.72 + 0.6) : 0;
  const sub = { ...ctx, mode: ctx.mode === 'fill' ? 'print' : ctx.mode };
  const names = maxW ? rotatedNames(b.lanes.map(l => ({ left: `${l.x * 100}%`, html: inlineFmt(l.name, sub) })), ctx, nameH) : '';
  const marks = `<div class="g-marks">${b.lanes.map(l => `<div style="left:${l.x * 100}%">${inlineFmt(l.mark, sub)}</div>`).join('')}</div>`;
  const mkCol = mks.length ? `<div class="g-mk" style="width:${mkW}em">${b.unit ? `<div class="g-unit">${esc(b.unit)}</div>` : ''}${mks.map(m => `<div class="g-tick" style="top:${m.y}%">${inlineFmt(m.label, sub)}</div>`).join('')}</div>` : '';
  const html = `<div class="gel" style="width:${b.width || 80}%">${head}
    <div class="g-wrap"><div class="g-left" style="width:${mkW}em"></div><div class="g-main">${names}${marks}</div></div>
    <div class="g-wrap">${mkCol}<div class="g-main">${gelImgBox(b)}</div></div></div>`;
  return html + (ctx.mode === 'fill' ? `<details class="fig-ed no-print" open><summary>この図を編集（画像・レーン名など）</summary>${gelEdHtml(b, bp)}</details>` : '');
}

// ---------- 図の編集パネル（プロトコル編集・記録の入力の両方で使う） ----------
function tubesEdHtml(b, bp) {
  return `<div class="row">見出し ${inp(bp + '.label', b.label, '8連チューブ', '160px')}
    本数 <input type="number" min="1" max="24" data-bind="${bp}.count" data-num="1" data-resize="1" value="${b.tubes.length}" style="width:60px">
    <label><input type="checkbox" data-bind="${bp}.strip" ${b.strip ? 'checked' : ''}> 連結（8連など）</label>
    <label><input type="checkbox" data-bind="${bp}.legend" ${b.legend ? 'checked' : ''}> 凡例を表示</label>
    <button type="button" class="small" data-fig="marks-num" data-path="${bp}">印を番号に戻す</button></div>
    <table class="ed"><tr><th>No.</th><th>チューブの印</th><th>サンプル名（上に斜めに表示）</th><th>種類</th><th>液量など</th></tr>
    ${b.tubes.map((t, k) => `<tr><td>${k + 1}</td><td>${inp(`${bp}.tubes.${k}.mark`, t.mark, '', '70px')}</td><td>${inp(`${bp}.tubes.${k}.name`, t.name, '例：His12-Orc2')}</td>
      <td><select data-bind="${bp}.tubes.${k}.kind" data-rerender="1">${Object.entries(TUBE_KINDS).map(([v, [l]]) => `<option value="${v}" ${t.kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td>${inp(`${bp}.tubes.${k}.vol`, t.vol, '例：19uL', '80px')}</td></tr>`).join('')}</table>`;
}
function gelPreviewHtml(b, bp) {
  if (!b.src) return '';
  const lanes = b.lanes.map((l, k) => `<div class="lh" data-drag="lane" data-path="${bp}" data-k="${k}" style="left:${l.x * 100}%"><span>${esc(stripMarks(l.mark) || k + 1)}</span></div>`).join('');
  const mks = (b.markers || []).map((m, k) => `<div class="mh" data-drag="marker" data-path="${bp}" data-k="${k}" style="top:${m.y}%"><span>${esc(m.label || '目盛り')}</span></div>`).join('');
  return `<div class="gel-prev" data-path="${bp}">${gelImgBox(b, lanes + mks)}</div>
    <div class="muted">青い縦線＝レーンの位置、オレンジの横線＝マーカーの目盛り。線をドラッグして合わせてください。</div>`;
}
function gelEdHtml(b, bp) {
  const c = b.crop || { t: 0, b: 0, l: 0, r: 0 };
  const sl = (key, label, val, min, max) => `<label class="sl">${label}<input type="range" min="${min}" max="${max}" step="1" data-bind="${bp}.${key}" data-num="1" data-live="1" value="${val}"><span>${val}</span></label>`;
  const idx = bp.split('.')[1];
  return `<div class="row">見出し ${inp(bp + '.label', b.label, '電気泳動', '120px')} 続けて ${inp(bp + '.note', b.note, '例：1% アガロースゲル', '200px')}
      表示の幅 ${inp(bp + '.width', b.width, '80', '44px')} %</div>
    <div class="imgdrop" data-imgdrop="${idx}">${b.src ? '<span>別の画像に替えるときは、ここにドラッグ＆ドロップ</span>' : '<span>ここに泳動画像をドラッグ＆ドロップ（PNG・JPEG など）</span>'}</div>
    <div class="row"><input type="file" accept="image/*" data-act="img" data-i="${idx}"></div>
    ${b.src ? `<div class="sliders">
      <b>切り抜き</b>${sl('crop.t', '上', c.t, 0, 45)}${sl('crop.b', '下', c.b, 0, 45)}${sl('crop.l', '左', c.l, 0, 45)}${sl('crop.r', '右', c.r, 0, 45)}
      <br><b>明るさ</b>${sl('bright', '明るさ', b.bright || 100, 30, 300)}${sl('contrast', 'コントラスト', b.contrast || 100, 30, 300)}
      <button type="button" class="small" data-fig="reset-img" data-path="${bp}">切り抜き・明るさを元に戻す</button></div>
      ${gelPreviewHtml(b, bp)}` : ''}
    <div class="row" style="margin-top:6px">レーン数 <input type="number" min="1" max="30" data-bind="${bp}.count" data-num="1" data-resize="1" value="${b.lanes.length}" style="width:60px">
      <button type="button" class="small" data-fig="equalize" data-path="${bp}">最初と最後の間を等間隔にそろえる</button>
      <button type="button" class="small primary" data-fig="from-tubes" data-path="${bp}">チューブ図から名前を引き継ぐ</button></div>
    <table class="ed"><tr><th>レーン</th><th>上の記号（M, 1, 2…）</th><th>サンプル名（斜めに表示）</th></tr>
    ${b.lanes.map((l, k) => `<tr><td>${k + 1}</td><td>${inp(`${bp}.lanes.${k}.mark`, l.mark, '', '70px')}</td><td>${inp(`${bp}.lanes.${k}.name`, l.name, '例：1kb ladder')}</td></tr>`).join('')}</table>
    <div class="row" style="margin-top:6px"><b>マーカーの目盛り（左側）</b> 単位 ${inp(bp + '.unit', b.unit, '(bp)', '60px')}
      <button type="button" class="small" data-fig="mk-add" data-path="${bp}">＋ 目盛りを追加</button></div>
    <table class="ed">${(b.markers || []).map((m, k) => `<tr><td>${inp(`${bp}.markers.${k}.label`, m.label, '例：1k', '80px')}</td><td>上から ${inp(`${bp}.markers.${k}.y`, m.y, '', '50px')} %</td>
      <td><button type="button" class="small" data-fig="mk-del" data-path="${bp}" data-k="${k}">×</button></td></tr>`).join('')}</table>`;
}
// 図のボタン操作。true を返したら描き直す
function figAction(doc, t) {
  const b = getPath(doc, t.dataset.path);
  if (!b) return false;
  switch (t.dataset.fig) {
    case 'marks-num': b.tubes.forEach((x, k) => { x.mark = String(k + 1); }); return true;
    case 'equalize': equalizeLanes(b); return true;
    case 'reset-img': b.crop = { t: 0, b: 0, l: 0, r: 0 }; b.bright = 100; b.contrast = 100; return true;
    case 'mk-add': (b.markers = b.markers || []).push({ label: '', y: 50 }); return true;
    case 'mk-del': b.markers.splice(+t.dataset.k, 1); return true;
    case 'from-tubes': {
      const gi = doc.blocks.indexOf(b);
      const before = doc.blocks.slice(0, gi).filter(x => x.type === 'tubes');
      const tb = before.length ? before[before.length - 1] : doc.blocks.find(x => x.type === 'tubes');
      if (!tb) { alert('この書面にチューブ配置図がありません。先にチューブ配置図ブロックを作ってください。'); return false; }
      const src = tb.tubes.filter(x => x.kind !== 'e').map(x => x.name || x.mark);
      const isM = l => /^(M|マーカー|marker|ladder)$/i.test(stripMarks(l.mark).trim());
      let targets = b.lanes.filter(l => !isM(l));
      if (targets.length < src.length) {
        const need = b.lanes.length + (src.length - targets.length);
        if (!confirm(`チューブ ${src.length} 本分の名前を入れるには、レーンが ${need} 本必要です。レーン数を ${need} にしますか？`)) return false;
        b.count = need; resizeFig(b); targets = b.lanes.filter(l => !isM(l));
      }
      src.forEach((nm, k) => { targets[k].name = nm; });
      toast(`チューブ図から ${src.length} 本分の名前を引き継ぎました`);
      return true;
    }
  }
  return false;
}
// 泳動画像のレーン線・目盛り線のドラッグ
function bindGelDrag(root, doc, onDone) {
  root.querySelectorAll('[data-drag]').forEach(h => {
    h.onpointerdown = e => {
      e.preventDefault();
      const box = h.closest('.g-img').getBoundingClientRect();
      const b = getPath(doc, h.dataset.path), k = +h.dataset.k;
      h.setPointerCapture(e.pointerId);
      h.onpointermove = ev => {
        if (h.dataset.drag === 'lane') { const x = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width)); b.lanes[k].x = Math.round(x * 1000) / 1000; h.style.left = x * 100 + '%'; }
        else { const y = Math.min(100, Math.max(0, (ev.clientY - box.top) / box.height * 100)); b.markers[k].y = Math.round(y * 10) / 10; h.style.top = y + '%'; }
      };
      h.onpointerup = () => { h.onpointermove = null; h.onpointerup = null; onDone(); };
    };
  });
}
// 画像を入れる（画像ブロック・泳動画像ブロック共通）
function makeImageSetter(doc, after) {
  return (i, file) => {
    if (!/^image\//.test(file.type)) { alert('画像ファイル（PNG・JPEG など）を選んでください。'); return; }
    const fr = new FileReader();
    fr.onload = () => {
      const b = doc.blocks[i];
      if (!b) return;
      b.src = fr.result;
      if (b.type === 'gel') {
        const im = new Image();
        im.onload = () => { b.nw = im.naturalWidth; b.nh = im.naturalHeight; b.crop = { t: 0, b: 0, l: 0, r: 0 }; after(); };
        im.src = fr.result;
      } else after();
    };
    fr.readAsDataURL(file);
  };
}
// data-bind の入力を反映（図の編集パネル用。プロトコル編集・記録の入力で共通）
function applyBind(doc, t) {
  let v = t.type === 'checkbox' ? t.checked : t.value;
  if (t.dataset.num && v !== '') v = +v;
  setPath(doc, t.dataset.bind, v);
  if (t.dataset.live) { const s = t.parentNode.querySelector('span'); if (s) s.textContent = t.value; }
  if (t.dataset.resize) { const bp = t.dataset.bind.split('.').slice(0, 2).join('.'); resizeFig(getPath(doc, bp)); }
}
function refreshGelPreview(root, doc, t) {
  const bp = t.dataset.bind.split('.').slice(0, 2).join('.');
  const pv = root.querySelector(`.gel-prev[data-path="${bp}"]`);
  if (!pv) return;
  const b = getPath(doc, bp);
  pv.outerHTML = gelPreviewHtml(b, bp).replace(/<div class="muted">[\s\S]*$/, '');
  return true;
}


// ============================================================
// 注意点・考え方（タグで分類・検索。プロトコルのタグと連動して自動表示）
// ============================================================
const normSearch = s => String(s || '').normalize('NFKC').toLowerCase();
const normTag = t => String(t || '').normalize('NFKC').trim().replace(/^[#＃]+/, '').trim();
async function refreshTagList() {
  let dl = document.getElementById('taglist-dl');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'taglist-dl'; document.body.appendChild(dl); }
  try { const tags = await quietGet('tags'); dl.innerHTML = tags.map(t => `<option value="${esc(t.tag)}">`).join(''); } catch (e) { /* 無視 */ }
}
function tagChip(t, extra = '') { return `<span class="tagchip" ${extra}>#${esc(t)}</span>`; }
function tagBoxHtml(tags) {
  return `<span class="tagbox">${(tags || []).map((t, k) => `<span class="tagchip">#${esc(t)}<button type="button" class="tx" data-tagdel="${k}" title="このタグを外す">×</button></span>`).join('')}<input type="text" class="taginp" list="taglist-dl" placeholder="タグを入力して Enter"></span>`;
}
// タグ入力欄の動き。getTags()/setTags(arr) でデータとつなぐ
function bindTagBox(box, getTags, setTags, onChange) {
  if (!box) return;
  const redraw = () => {
    if (!box.isConnected) return;
    const nb = document.createElement('span'); nb.innerHTML = tagBoxHtml(getTags());
    const fresh = nb.firstChild; box.replaceWith(fresh); bindTagBox(fresh, getTags, setTags, onChange); fresh.querySelector('.taginp').focus();
  };
  const inpEl = box.querySelector('.taginp');
  const add = () => {
    if (!box.isConnected) return false;
    const parts = inpEl.value.split(/[,、，\s]+/).map(normTag).filter(Boolean);
    inpEl.value = '';
    if (!parts.length) return false;
    const tags = getTags().slice();
    for (const t of parts) if (!tags.includes(t)) tags.push(t);
    setTags(tags); onChange(); redraw();
    return true;
  };
  inpEl.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter' || e.key === ',' || e.key === '、') { e.preventDefault(); add(); }
    else if (e.key === 'Backspace' && !inpEl.value && getTags().length) { setTags(getTags().slice(0, -1)); onChange(); redraw(); }
  });
  inpEl.addEventListener('change', () => { if (inpEl.value.trim()) add(); });
  box.querySelectorAll('[data-tagdel]').forEach(b => b.onclick = () => { const t = getTags().slice(); t.splice(+b.dataset.tagdel, 1); setTags(t); onChange(); redraw(); });
}
function noteBodyHtml(n) { return `<div class="sheet notebody">${renderText(n.data.body || '', { mode: 'print', chem: true })}</div>`; }
function noteCardHtml(n, { actions = true, pick = false, open = true } = {}) {
  const d = n.data;
  return `<div class="notecard${d.important ? ' imp' : ''}" data-note="${n.id}">
    <div class="nc-head">${pick ? `<input type="checkbox" class="nc-pick" data-pick="${n.id}" title="書面に追加するものを選ぶ">` : ''}
      ${d.important ? '<span class="nc-star">★重要</span>' : ''}<span class="nc-title">${inlineFmt(d.title || '（題名なし）', { mode: 'print', chem: true })}</span>
      <span class="nc-tags">${(d.tags || []).map(t => tagChip(t, `data-tagfilter="${esc(t)}"`)).join('')}</span>
      ${actions ? `<span class="spacer"></span><button class="small" data-nedit="${n.id}">編集</button><button class="small danger" data-ndel="${n.id}">削除</button>` : ''}</div>
    ${open ? noteBodyHtml(n) : ''}</div>`;
}
function openNoteEditor(note, onSaved) {
  const isNew = !note;
  const d = note ? clone(note.data) : { title: '', body: '', tags: [], important: false };
  let base = note ? note.updated : null;
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal meta" style="width:min(1000px,96vw)"><h3 style="margin-top:0">${isNew ? '新しい注意点' : '注意点の編集'}</h3>
    <div class="row">題名 <input type="text" data-f="title" value="${esc(d.title)}" placeholder="例：DMSOは一気に入れない" style="flex:1;min-width:260px">
      <label><input type="checkbox" data-f="important" ${d.important ? 'checked' : ''}> ★重要</label></div>
    <div class="row" style="margin-top:8px">タグ <span id="ne-tags">${tagBoxHtml(d.tags)}</span></div>
    <div class="ne-grid"><div>${markupBar()}<textarea data-f="body" rows="12" placeholder="注意点や考え方の本文。書式（太字・赤字・可変欄など）も使えます。">${esc(d.body)}</textarea></div>
      <div><div class="muted">表示イメージ</div><div id="ne-pv"></div></div></div>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button data-x>閉じる</button><button class="primary" data-ok>保存</button></div></div>`;
  document.body.appendChild(bg);
  bindMarkupBar(bg);
  const pv = bg.querySelector('#ne-pv');
  const draw = () => { pv.innerHTML = noteBodyHtml({ data: d }); };
  draw();
  let changed = false;
  bg.addEventListener('input', e => {
    const f = e.target.dataset.f;
    if (!f) return;
    d[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    changed = true; if (f === 'body') draw();
  });
  bg.addEventListener('change', e => { if (e.target.dataset.f === 'important') { d.important = e.target.checked; changed = true; } });
  bindTagBox(bg.querySelector('#ne-tags .tagbox'), () => d.tags, t => { d.tags = t; }, () => { changed = true; });
  bg.querySelector('[data-x]').onclick = () => { if (!changed || confirm('保存していない変更があります。閉じますか？')) bg.remove(); };
  bg.querySelector('[data-ok]').onclick = async () => {
    const pending = bg.querySelector('.taginp');
    if (pending && pending.value.trim()) { for (const t of pending.value.split(/[,、，\s]+/).map(normTag).filter(Boolean)) if (!d.tags.includes(t)) d.tags.push(t); }
    if (!d.title.trim()) { alert('題名を入力してください。'); return; }
    if (isNew) await api.send('POST', 'notes', { data: d });
    else { const u = await putWithCheck('notes/' + note.id, d, base); if (!u) return; base = u; }
    bg.remove(); toast('注意点を保存しました'); refreshTagList(); onSaved && onSaved();
  };
}
function openTagManager(onDone) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  const draw = async () => {
    const tags = await api.get('tags');
    bg.innerHTML = `<div class="modal"><h3 style="margin-top:0">タグの整理</h3>
      <p class="muted">タグの名前を変えると、そのタグが付いた注意点・プロトコル・記録のすべてが一緒に変わります。同じ名前のタグに変えると1つにまとまります。削除すると、すべてからそのタグが外れます（注意点やプロトコル自体は消えません）。<br>新しいタグは、注意点やプロトコルの「タグ」欄に入力すると作られます。</p>
      ${tags.length ? `<table class="list"><tr><th>タグ</th><th>注意点</th><th>プロトコル</th><th>新しい名前</th><th></th></tr>
      ${tags.map((t, k) => `<tr><td>${tagChip(t.tag)}</td><td>${t.notes}件</td><td>${t.protocols}件</td>
        <td><input type="text" data-rn="${k}" value="${esc(t.tag)}" style="width:160px"></td>
        <td style="white-space:nowrap"><button class="small" data-rename="${k}">名前を変える</button> <button class="small danger" data-del="${k}">削除</button></td></tr>`).join('')}</table>` : '<p>まだタグはありません。</p>'}
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button data-x>閉じる</button></div></div>`;
    bg.onclick = async e => {
      const t = e.target;
      if (t.dataset.x !== undefined) { bg.remove(); onDone && onDone(); return; }
      const k = t.dataset.rename ?? t.dataset.del;
      if (k === undefined) return;
      const from = tags[+k].tag;
      let to = '';
      if (t.dataset.rename !== undefined) {
        to = normTag(bg.querySelector(`[data-rn="${k}"]`).value);
        if (!to || to === from) return;
      } else if (!confirm(`タグ「#${from}」を、すべての注意点・プロトコル・記録から外しますか？`)) return;
      const r = await api.send('POST', 'tags/rename', { from, to });
      toast(to ? `「#${from}」→「#${to}」（${r.changed}件）` : `「#${from}」を外しました（${r.changed}件）`);
      refreshTagList(); draw();
    };
  };
  document.body.appendChild(bg);
  draw();
}
function matchNotes(notes, tags) {
  const set = new Set((tags || []).map(normSearch));
  return notes.filter(n => (n.data.tags || []).some(t => set.has(normSearch(t))))
    .sort((a, b) => (b.data.important ? 1 : 0) - (a.data.important ? 1 : 0));
}
// 選んだ注意点を書面の末尾に「【注意点】」として追加
function insertNotesIntoDoc(doc, notes) {
  if (!notes.length) return;
  const has = doc.blocks.some(b => b.type === 'heading' && stripMarks(b.text) === '注意点');
  if (!has) doc.blocks.push({ type: 'heading', style: '【】', text: '注意点', extra: '' });
  const lines = [];
  notes.forEach((n, i) => {
    if (i) lines.push('');
    lines.push(`${n.data.important ? '!!★!!' : '・'}**${n.data.title}**`);
    for (const l of String(n.data.body || '').split('\n')) lines.push(l.trim() ? '　' + l : '');
  });
  doc.blocks.push({ type: 'text', text: lines.join('\n') });
}
// 記録・プロトコル編集の上に出す「この実験の注意点」
async function notesPanel(el, tags, onInsert, { label = 'この実験の注意点', target = '書面' } = {}) {
  if (!el) return;
  let notes;
  try { notes = await quietGet('notes'); } catch (e) { el.innerHTML = ''; return; }
  const hit = matchNotes(notes, tags);
  const tagTxt = (tags || []).length ? tags.map(t => tagChip(t)).join(' ') : '';
  if (!(tags || []).length) {
    el.innerHTML = `<div class="notes-panel empty no-print">プロトコルにタグ（例：PCR、無菌操作）を付けると、同じタグの注意点がここに自動で出ます。<a href="#/notes">注意点・考え方を見る</a></div>`;
    return;
  }
  if (!hit.length) {
    el.innerHTML = `<div class="notes-panel empty no-print">${tagTxt} のタグが付いた注意点はまだありません。<a href="#/notes">注意点を書く</a></div>`;
    return;
  }
  const imp = hit.filter(n => n.data.important).length;
  el.innerHTML = `<details class="notes-panel no-print" open><summary>${esc(label)}（${hit.length}件${imp ? `・★重要 ${imp}件` : ''}）　${tagTxt}</summary>
    <div class="np-list">${hit.map(n => noteCardHtml(n, { actions: false, pick: true })).join('')}</div>
    <div class="row"><button class="small primary" data-np-insert>選んだ注意点を${esc(target)}の末尾に追加</button>
      <span class="muted">チェックを入れたものが「【注意点】」として${esc(target)}に追加されます。追加した後は自由に直せます。</span></div></details>`;
  el.querySelector('[data-np-insert]').onclick = () => {
    const ids = [...el.querySelectorAll('[data-pick]:checked')].map(c => +c.dataset.pick);
    if (!ids.length) { alert('追加する注意点にチェックを入れてください。'); return; }
    onInsert(hit.filter(n => ids.includes(n.id)));
    el.querySelectorAll('[data-pick]:checked').forEach(c => { c.checked = false; });
    toast(`${ids.length} 件を${target}に追加しました`);
  };
}
// プロトコルのメモ欄 → 注意点
function splitMemo(text) {
  const segs = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const pl = stripMarks(raw).trim();
    const m = pl.length <= 60 && pl.match(/^(?:〈([^〉]+)〉|【([^】]+)】|<([^>]+)>|●\s*(.+))(.*)$/);
    if (m) {
      cur = { title: (m[1] || m[2] || m[3] || m[4] || '').replace(/__|\*\*/g, '').trim(), lines: [] };
      const rest = (m[5] || '').trim();
      if (rest) cur.lines.push(rest);
      segs.push(cur);
    } else {
      if (!cur) { cur = { title: '', lines: [] }; segs.push(cur); }
      cur.lines.push(raw);
    }
  }
  return segs.map(s => ({ title: s.title, body: s.lines.join('\n').replace(/^\n+|\n+$/g, '') })).filter(s => s.title || s.body.trim());
}
function openMemoToNotes(doc, onDone) {
  const memo = (doc.memo || {}).text || '';
  if (!memo.trim()) { alert('メモ欄が空です。'); return; }
  const tags0 = (doc.tags && doc.tags.length) ? doc.tags.slice() : (doc.name ? [normTag(doc.name)] : []);
  const segs = splitMemo(memo);
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal meta"><h3 style="margin-top:0">メモを注意点に移す</h3>
    <div class="row"><label><input type="radio" name="mm" value="split" ${segs.length > 1 ? 'checked' : ''}> 見出しごとに分ける（${segs.length}件）</label>
      <label><input type="radio" name="mm" value="one" ${segs.length > 1 ? '' : 'checked'}> 1件にまとめる</label></div>
    <div class="row" style="margin-top:8px">付けるタグ <span id="mm-tags">${tagBoxHtml(tags0)}</span></div>
    <p class="muted">見出しは〈 〉【 】● で始まる行を使います。登録した後に、注意点のページでいつでも直せます。</p>
    <div class="np-list" id="mm-pv"></div>
    <div class="row" style="margin-top:12px"><label><input type="checkbox" id="mm-clear"> 登録したらメモ欄を空にする</label><span class="spacer"></span><button data-x>やめる</button><button class="primary" data-ok>注意点として登録</button></div></div>`;
  document.body.appendChild(bg);
  let tags = tags0;
  const list = () => {
    const mode = bg.querySelector('input[name=mm]:checked').value;
    const base = doc.name || doc.title || 'メモ';
    return mode === 'one' ? [{ title: `${base}のメモ`, body: memo }] : segs.map((s, i) => ({ title: s.title || `${base}のメモ${i ? i + 1 : ''}`, body: s.body }));
  };
  const draw = () => { bg.querySelector('#mm-pv').innerHTML = list().map((x, i) => noteCardHtml({ id: i, data: { ...x, tags } }, { actions: false, open: false })).join(''); };
  draw();
  bg.querySelectorAll('input[name=mm]').forEach(r => r.onchange = draw);
  bindTagBox(bg.querySelector('#mm-tags .tagbox'), () => tags, t => { tags = t; }, draw);
  bg.querySelector('[data-x]').onclick = () => bg.remove();
  bg.querySelector('[data-ok]').onclick = async () => {
    const items = list();
    for (const x of items) await api.send('POST', 'notes', { data: { title: x.title, body: x.body, tags, important: false } });
    const clear = bg.querySelector('#mm-clear').checked;
    bg.remove();
    toast(`${items.length} 件を注意点に登録しました`);
    refreshTagList();
    onDone(clear);
  };
}
// 注意点のページ
let notesState = { q: '', tags: [], imp: false };
async function viewNotes() {
  $app.onclick = null;
  const notes = await api.get('notes');
  refreshTagList();
  const counts = {};
  notes.forEach(n => (n.data.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  const tagNames = Object.keys(counts).sort((a, b) => a.localeCompare(b, 'ja'));
  notesState.tags = notesState.tags.filter(t => counts[t]);
  const q = normSearch(notesState.q).split(/\s+/).filter(Boolean);
  const shown = notes.filter(n => {
    const d = n.data;
    if (notesState.imp && !d.important) return false;
    if (notesState.tags.some(t => !(d.tags || []).includes(t))) return false;
    const hay = normSearch([d.title, stripMarks(d.body || ''), (d.tags || []).join(' ')].join(' '));
    return q.every(w => hay.includes(w));
  }).sort((a, b) => (b.data.important ? 1 : 0) - (a.data.important ? 1 : 0));
  $app.innerHTML = `<div class="row"><h2>注意点・考え方</h2><span class="spacer"></span>
      <button id="tagman">タグの整理</button> <button class="primary" id="newnote">＋ 新しい注意点</button></div>
    <div class="card"><div class="row"><input type="text" id="nq" value="${esc(notesState.q)}" placeholder="検索（題名・本文・タグ。スペースで区切ると全部を含むものだけ）" style="flex:1;min-width:280px;font-size:15px;padding:8px">
      <label><input type="checkbox" id="nimp" ${notesState.imp ? 'checked' : ''}> ★重要だけ</label></div>
      <div class="tagrow">${tagNames.length ? tagNames.map(t => `<span class="tagchip big${notesState.tags.includes(t) ? ' on' : ''}" data-tagfilter="${esc(t)}">#${esc(t)} <small>${counts[t]}</small></span>`).join('') : '<span class="muted">タグはまだありません。注意点にタグを付けるとここに並び、クリックで絞り込めます。</span>'}
      ${notesState.tags.length ? '<button class="small" id="tagclear">絞り込みを解除</button>' : ''}</div></div>
    <div class="muted" style="margin:0 0 8px">${shown.length} 件${notes.length !== shown.length ? `（全 ${notes.length} 件中）` : ''}</div>
    <div id="nlist">${shown.length ? shown.map(n => noteCardHtml(n)).join('') : `<div class="card muted">${notes.length ? '条件に合う注意点はありません。' : 'まだ注意点はありません。「＋ 新しい注意点」から書くか、プロトコル編集画面のメモ欄から移せます。'}</div>`}</div>`;
  const nq = document.getElementById('nq');
  let t;
  nq.oninput = () => { clearTimeout(t); t = setTimeout(() => { notesState.q = nq.value; const pos = nq.selectionStart; viewNotes().then(() => { const n2 = document.getElementById('nq'); n2.focus(); n2.setSelectionRange(pos, pos); }); }, 300); };
  document.getElementById('nimp').onchange = e => { notesState.imp = e.target.checked; viewNotes(); };
  document.getElementById('newnote').onclick = () => openNoteEditor(null, viewNotes);
  document.getElementById('tagman').onclick = () => openTagManager(viewNotes);
  const tc = document.getElementById('tagclear'); if (tc) tc.onclick = () => { notesState.tags = []; viewNotes(); };
  $app.onclick = async e => {
    const el = e.target.closest('[data-tagfilter],[data-nedit],[data-ndel]');
    if (!el) return;
    if (el.dataset.tagfilter) {
      const tg = el.dataset.tagfilter;
      notesState.tags = notesState.tags.includes(tg) ? notesState.tags.filter(x => x !== tg) : [...notesState.tags, tg];
      viewNotes();
    } else if (el.dataset.nedit) {
      const n = await api.get('notes/' + el.dataset.nedit); openNoteEditor(n, viewNotes);
    } else if (el.dataset.ndel) {
      const n = notes.find(x => x.id === +el.dataset.ndel);
      if (confirm(`注意点「${n ? n.data.title : ''}」を削除しますか？（元に戻せません）`)) { await api.send('DELETE', 'notes/' + el.dataset.ndel); viewNotes(); }
    }
  };
  const sig = JSON.stringify(notes.map(n => [n.id, n.updated]));
  pollFn = sameView(async () => {
    if (document.querySelector('.modal-bg')) return;
    const n2 = await quietGet('notes');
    if (JSON.stringify(n2.map(n => [n.id, n.updated])) !== sig) await rerenderKeepScroll(viewNotes);
  });
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
  [/^#\/notes$/, viewNotes],
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
      ${info.local ? `<p>同じ研究室のネットワークにつながったPCのブラウザで、次のどれかを開いてください（合言葉：${info.password ? 'あり。開くと「合言葉を入力してください」という画面が出るので、合言葉を入れて「開く」' : 'なし'}）。</p>
      <ul>${info.addresses.map(a => `<li><code>${esc(a)}</code></li>`).join('')}</ul>` : '<p>このPCは、ツールを起動しているPCに接続しています。</p>'}
      <p><a class="btn" href="/shortcut.url" download>このPC用のアイコン（ショートカット）をダウンロード</a>
      <span class="muted">ダウンロードした「実験ノート印刷.url」をデスクトップに移すと、ダブルクリックで開けます。</span></p></div>` : '';
  $app.innerHTML = `<div class="home">
    <h2>実験ノート印刷</h2>
    ${info.warn ? `<div class="card" style="background:#fff4ce;border-color:#e0c060"><b>置き場所の注意：</b>${esc(info.warn)}<div class="muted">移すときはツールを終了してから jikken-note フォルダごと移動し、「デスクトップにアイコンを作る.bat」をもう一度実行してください。</div></div>` : ''}
    <div class="card"><h3 style="margin-top:0">新しい記録を書く</h3>
      <div class="row"><select id="psel" class="psel">${ps.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <button class="primary big" id="start">このプロトコルで書く</button></div>
      <p class="muted">プロトコルを選ぶと内容がそのまま入ります。黄色の欄（可変欄）だけ入力すれば印刷できます。</p></div>
    <div class="card"><div class="row"><h3 style="margin:0">最近の記録</h3><span class="spacer"></span><a href="#/records">すべて見る →</a></div>
      ${rs.length ? `<div class="tablewrap"><table class="list"><tr><th>実験日</th><th>プロトコル</th><th>印刷</th><th></th></tr>${rs.slice(0, 8).map(r => `<tr><td class="nowrap">${esc(r.exp_date)}</td><td>${esc(r.protocol_name)}</td><td class="muted nowrap">${r.printed ? esc(r.printed.slice(0, 16)) : '未印刷'}</td><td class="nowrap"><a href="#/record/${r.id}">開く</a> ・ <a href="#/print/${r.id}">印刷</a></td></tr>`).join('')}</table></div>` : '<p class="muted">まだ記録はありません。</p>'}</div>
    ${shareCard}
    ${info.local ? `<div class="card"><div class="row"><h3 style="margin:0">バックアップ</h3><span class="spacer"></span><button id="bk">今すぐバックアップ</button></div>
      <p class="muted">データはすべて <code>data\\notebook.db</code> の1ファイルに入っています。このボタンを押すと <code>backup</code> フォルダに日時つきのコピーを作ります（起動時にも1日1回、自動でコピーします）。</p></div>` : ''}</div>`;
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
    <div class="split"><div><div id="np"></div><div id="ed"></div></div><div class="preview-wrap"><div class="legend">印刷イメージ（幅17cm）　<span class="sw" style="background:#d9d9d9">灰色</span>＝可変欄　赤い横線＝ページの区切り（目安）</div><div id="pv"></div></div></div>`;
  const pv = document.getElementById('pv');
  const chem = document.getElementById('chem');
  const draw = () => { pv.innerHTML = renderDoc(doc, { mode: 'preview', memo: true, chem: chem.checked }); };
  let t;
  const onCh = () => { dirty = true; clearTimeout(t); t = setTimeout(draw, 250); };
  const np = document.getElementById('np');
  let ed;
  const panel = tags => notesPanel(np, tags, ns => { insertNotesIntoDoc(doc, ns); ed.render(); onCh(); }, { label: 'このプロトコルのタグに合う注意点', target: 'このプロトコル' });
  ed = mountEditor(document.getElementById('ed'), doc, onCh, { onTags: panel });
  panel(doc.tags || []);
  refreshTagList();
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
    protocol_id: p.id, protocol_name: pd.name, exp_date: today(), tags: clone(pd.tags || []),
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
    <div id="np"></div><div id="body"></div>`;
  const body = document.getElementById('body');
  const doc = rec.doc;
  (async () => {
    let tags = rec.tags;
    if (!tags && rec.protocol_id) { try { tags = ((await quietGet('protocols/' + rec.protocol_id)).data.tags) || []; } catch (e) { tags = []; } }
    notesPanel(document.getElementById('np'), tags || [], ns => { insertNotesIntoDoc(doc, ns); dirty = true; redraw(); upd(); });
  })();
  const upd = () => { const n = countBlanks(doc); document.getElementById('blanks').textContent = n ? `未入力の可変欄：${n}個` : '可変欄はすべて入力済み'; };
  const drawFill = () => {
    body.innerHTML = `<div class="legend">黄色の欄に入力してください（Tabキーで次の欄へ）。空欄のまま印刷すると、手書き用の灰色の空欄になります。</div>${renderDoc(doc, { mode: 'fill', date: rec.opts.date ? rec.exp_date : '', memo: rec.opts.memo, chem: rec.opts.chem !== false })}`;
    imageDropHandler = makeImageSetter(doc, () => { dirty = true; drawFill(); });
    bindGelDrag(body, doc, () => { dirty = true; drawFill(); });
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
    if (tab === 'fill' && t.dataset.bind) {
      applyBind(doc, t); dirty = true; upd();
      if (t.dataset.live) { refreshGelPreview(body, doc, t); bindGelDrag(body, doc, () => { dirty = true; drawFill(); }); }
      return;
    }
    if (!t.classList.contains('vin')) return;
    dirty = true;
    if (t.dataset.num) setPath(doc, t.dataset.path, t.value);
    else setPath(doc, t.dataset.path, setToken(getPath(doc, t.dataset.path), +t.dataset.k, t.value));
    t.classList.toggle('empty', !t.value);
    t.style.width = Math.max(3, Math.min(30, (t.value || t.placeholder || '').length * 0.75 + 1.5)) + 'em';
    upd();
  });
  body.addEventListener('change', e => {
    const t = e.target;
    if (tab !== 'fill') return;
    if (t.dataset.act === 'img' && t.files && t.files[0]) { imageDropHandler(+t.dataset.i, t.files[0]); return; }
    if (t.dataset.bind) applyBind(doc, t);
    if (!t.classList.contains('vin') && !t.dataset.bind) return;
    setTimeout(() => {
      const a = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset : {};
      const key = a.key ? ['key', a.key] : a.bind ? ['bind', a.bind] : null;
      const y = window.scrollY;
      drawFill();
      window.scrollTo(0, y);
      if (key) { const el = body.querySelector(`[data-${key[0]}="${CSS.escape(key[1])}"]`); if (el) el.focus(); }
    }, 0);
  });
  body.addEventListener('click', e => {
    const f = e.target.closest('[data-fig]');
    if (!f || tab !== 'fill') return;
    if (figAction(doc, f)) { dirty = true; const y = window.scrollY; drawFill(); window.scrollTo(0, y); }
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
