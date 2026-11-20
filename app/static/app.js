"use strict";
/* 薬剤師国試 フラッシュカード — 画面 */

const RATING = {
  good: { sym: "○", label: "○", cls: "r-good" },
  fair: { sym: "△", label: "△", cls: "r-fair" },
  again: { sym: "✖", label: "✖", cls: "r-again" },
};
const LEVELS = [
  ["", "理解度：すべて"], ["new", "未学習"], ["good", "○（最後の評価）"], ["fair", "△（最後の評価）"],
  ["again", "✖（最後の評価）"], ["mature", "定着（間隔30日以上）"],
];
const DUES = [["", "期日：すべて"], ["due", "今日までが期日"], ["next7", "明日〜7日後"], ["later", "8日後以降"]];
const SORTS = [["due", "期日が近い順"], ["new", "追加が新しい順"], ["old", "追加が古い順"], ["updated", "更新が新しい順"]];

let META = null;
let keyHandler = null;   // 画面ごとのキー操作
const $main = document.getElementById("main");

/* ---------- 共通 ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function h(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
const store = {
  get(k, d) { try { const v = localStorage.getItem("yf:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("yf:" + k, JSON.stringify(v)); } catch { /* 使えなくても動く */ } },
};

async function api(method, path, body) {
  const opt = { method, headers: { "X-Yakushi-Flash": "1" } };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch("/api/" + path, opt); }
  catch { throw new Error("アプリに接続できません。黒い画面（サーバー）が閉じていないか確認してください"); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.auth) { showLogin(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `エラー（${res.status}）`);
  return data;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, isError ? 5000 : 2200);
}
function fail(e) { console.error(e); toast(e.message || String(e), true); }

function intervalLabel(stage) {
  if (!stage) return "新規";
  return `${META.intervals[stage - 1]}日`;
}
function ratingChip(r) {
  if (!r) return `<span class="r r-new">未学習</span>`;
  return `<span class="r ${RATING[r].cls}">${RATING[r].sym}</span>`;
}
function fmtDate(iso, withWeekday = true) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const w = "日月火水木金土"[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}` + (withWeekday ? `（${w}）` : "");
}
function relDue(iso) {
  const t = new Date(META.today + "T00:00:00"), d = new Date(iso + "T00:00:00");
  const n = Math.round((d - t) / 86400000);
  if (n < 0) return `<span class="r-again">${-n}日遅れ</span>`;
  if (n === 0) return "今日";
  if (n === 1) return "明日";
  return `${n}日後`;
}
function pct(x) { return (x * 100).toFixed(1) + "%"; }
function subjectOptions(selected, allLabel) {
  return (allLabel !== undefined ? `<option value="">${esc(allLabel)}</option>` : "") +
    META.subjects.map(s => `<option ${s === selected ? "selected" : ""}>${esc(s)}</option>`).join("");
}
function options(list, selected) {
  return list.map(([v, l]) => `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(l)}</option>`).join("");
}
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [page, qs] = raw.split("?");
  return { page: page || "today", params: new URLSearchParams(qs || "") };
}
function go(page, params) {
  const qs = params ? new URLSearchParams(params).toString() : "";
  location.hash = "#/" + page + (qs ? "?" + qs : "");
}
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/* 選択範囲を {{cN::…}} で囲む（Alt+C） */
function wrapCloze(ta) {
  const nums = [...ta.value.matchAll(/\{\{c(\d+)::/g)].map(m => +m[1]);
  const n = nums.length ? Math.max(...nums) : 1;
  const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
  const ins = `{{c${n}::${sel}}}`;
  ta.setRangeText(ins, s, e, "end");
  if (!sel) ta.setSelectionRange(s + ins.length - 2, s + ins.length - 2);
  ta.dispatchEvent(new Event("input"));
}

/* ---------- 画像 ---------- */
const IMG_MAX = 1600, THUMB_MAX = 240;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした（対応していない形式かもしれません）")); };
    img.src = url;
  });
}
function drawScaled(img, max, png, quality = 0.88) {
  const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * r)), hgt = Math.max(1, Math.round(img.naturalHeight * r));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = hgt;
  const ctx = cv.getContext("2d");
  if (!png) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, hgt); }   // 透明部分を白に
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, hgt);
  return { url: cv.toDataURL(png ? "image/png" : "image/jpeg", quality), w, h: hgt };
}
/* 画像ファイルを縮小（長い辺 1600px まで）してサーバーに登録し、id を返す */
async function uploadImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("画像ファイルを選んでください");
  const { img, url } = await loadImage(file);
  try {
    const png = file.type === "image/png" || file.type === "image/gif";   // スクリーンショットや図は PNG のまま
    const main = drawScaled(img, IMG_MAX, png);
    const thumb = drawScaled(img, THUMB_MAX, false, 0.8);
    const r = await api("POST", "images", { data: main.url, thumb: thumb.url, width: main.w, height: main.h });
    return r.id;
  } finally { URL.revokeObjectURL(url); }
}
function imageFiles(list) { return [...(list || [])].filter(f => f.type && f.type.startsWith("image/")); }

/* ---------- 画像の穴埋め（四角形）の編集 ---------- */
function openMaskEditor(imgId, rects, onDone) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal wide";
  dlg.innerHTML = `<div class="mh"><b>画像の穴埋め</b>
      <span class="sub">ドラッグで四角形を描くと、その部分が隠れます。四角形はドラッグで移動、右下の角で大きさを変更</span>
      <span class="spacer"></span><button class="btn small" data-a="cancel">キャンセル</button><button class="btn small primary" data-a="done">完了</button></div>
    <div class="mb"><div class="me-wrap"><div class="me-stage"><img src="/api/images/${imgId}" alt="" draggable="false"><div class="me-layer"></div></div></div>
      <div class="row me-tools">
        <label class="field" style="flex:1;min-width:200px">選んだ四角形のヒント（任意・空なら塗りつぶすだけ）
          <input type="text" id="mh" maxlength="40" placeholder="例：官能基" disabled></label>
        <button class="btn small danger" data-a="del" disabled>この四角形を消す</button>
        <button class="btn small" data-a="clear">全部消す</button>
        <span class="sub" id="mc"></span></div></div>`;
  document.body.append(dlg);
  const layer = dlg.querySelector(".me-layer"), $hint = dlg.querySelector("#mh"), $del = dlg.querySelector("[data-a=del]");
  let rs = (rects || []).map(r => ({ ...r })), sel = -1, drag = null;
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const pct = v => (v * 100).toFixed(3) + "%";

  function render() {
    layer.innerHTML = rs.map((r, i) => `<div class="me-rect ${i === sel ? "sel" : ""}" data-i="${i}"
        style="left:${pct(r.x)};top:${pct(r.y)};width:${pct(r.w)};height:${pct(r.h)}">
        <span class="me-hint">${esc(r.hint || "")}</span><span class="me-no">${i + 1}</span><span class="me-handle" data-h="${i}"></span></div>`).join("");
    $hint.disabled = $del.disabled = sel < 0;
    if (document.activeElement !== $hint) $hint.value = sel >= 0 ? (rs[sel].hint || "") : "";
    dlg.querySelector("#mc").textContent = `四角形 ${rs.length}個`;
  }
  const pt = e => { const b = layer.getBoundingClientRect(); return { x: clamp((e.clientX - b.left) / b.width), y: clamp((e.clientY - b.top) / b.height) }; };
  layer.addEventListener("pointerdown", e => {
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    const p = pt(e), hd = e.target.closest("[data-h]"), rc = e.target.closest("[data-i]");
    if (hd) { sel = +hd.dataset.h; drag = { mode: "resize", start: p, orig: { ...rs[sel] } }; }
    else if (rc) { sel = +rc.dataset.i; drag = { mode: "move", start: p, orig: { ...rs[sel] } }; }
    else { rs.push({ x: p.x, y: p.y, w: 0, h: 0, hint: "" }); sel = rs.length - 1; drag = { mode: "new", start: p }; }
    $hint.blur();
    render();
  });
  layer.addEventListener("pointermove", e => {
    if (!drag) return;
    const p = pt(e), r = rs[sel], dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (drag.mode === "new") {
      r.x = Math.min(drag.start.x, p.x); r.y = Math.min(drag.start.y, p.y);
      r.w = Math.abs(dx); r.h = Math.abs(dy);
    } else if (drag.mode === "move") {
      r.x = clamp(drag.orig.x + dx, 0, 1 - r.w); r.y = clamp(drag.orig.y + dy, 0, 1 - r.h);
    } else {
      r.w = clamp(drag.orig.w + dx, 0.01, 1 - r.x); r.h = clamp(drag.orig.h + dy, 0.01, 1 - r.y);
    }
    render();
  });
  const end = () => {
    if (!drag) return;
    if (drag.mode === "new" && (rs[sel].w < 0.01 || rs[sel].h < 0.01)) { rs.splice(sel, 1); sel = -1; }
    drag = null;
    render();
  };
  layer.addEventListener("pointerup", end);
  layer.addEventListener("pointercancel", end);
  $hint.addEventListener("input", () => { if (sel >= 0) { rs[sel].hint = $hint.value; render(); } });
  $del.addEventListener("click", () => { if (sel >= 0) { rs.splice(sel, 1); sel = -1; render(); } });
  dlg.querySelector("[data-a=clear]").addEventListener("click", () => {
    if (rs.length && confirm("この画像の四角形をすべて消します。よろしいですか？")) { rs = []; sel = -1; render(); }
  });
  dlg.addEventListener("keydown", e => {   // Delete / Backspace で選んだ四角形を消す（ヒント入力中は除く）
    if ((e.key === "Delete" || e.key === "Backspace") && e.target !== $hint && sel >= 0) {
      e.preventDefault(); rs.splice(sel, 1); sel = -1; render();
    }
  });
  dlg.querySelector("[data-a=cancel]").addEventListener("click", () => dlg.close());
  dlg.querySelector("[data-a=done]").addEventListener("click", () => { onDone(rs.filter(r => r.w >= 0.01 && r.h >= 0.01)); dlg.close(); });
  dlg.addEventListener("close", () => dlg.remove());
  render();
  dlg.showModal();
}

/* ---------- 表面・裏面の入力欄（追加・編集で共通） ---------- */
function cardForm(el, init = {}) {
  let masks = JSON.parse(JSON.stringify(init.masks || {}));
  el.innerHTML = `
    <div class="field-head"><b>表面</b><span class="muted">穴埋め {{c1::語句}} / {{c1::語句::ヒント}}</span><span class="spacer"></span>
      <button type="button" class="btn small" data-a="cloze">選んだ語句を穴埋め <kbd>Alt</kbd>+<kbd>C</kbd></button>
      <button type="button" class="btn small" data-a="img" data-side="front">画像を追加</button></div>
    <textarea class="cf-front" rows="4" placeholder="例：β1受容体を刺激すると心拍数は{{c1::増加::増減}}する"></textarea>
    <div class="sub cf-cap">プレビュー<span class="cf-imgnote" hidden>　—　<b>画像をクリック（タップ）すると、画像の上に穴を作れます</b></span></div>
    <div class="preview cf-pv-front"></div>
    <div class="field-head" style="margin-top:14px"><b>裏面</b><span class="muted">説明・解説（穴埋めカードなら省略可）</span><span class="spacer"></span>
      <button type="button" class="btn small" data-a="img" data-side="back">画像を追加</button></div>
    <textarea class="cf-back" rows="4"></textarea>
    <div class="preview cf-pv-back" hidden></div>
    <p class="sub" style="margin:6px 0 0">画像は、スクリーンショットを <kbd>Ctrl</kbd>+<kbd>V</kbd> で貼り付けるか、ファイルを入力欄にドラッグしても入れられます。</p>
    <input type="file" class="cf-file" accept="image/*" multiple hidden>`;
  const $f = el.querySelector(".cf-front"), $b = el.querySelector(".cf-back");
  const $pf = el.querySelector(".cf-pv-front"), $pb = el.querySelector(".cf-pv-back"), $file = el.querySelector(".cf-file");
  $f.value = init.front || ""; $b.value = init.back || "";
  let timer = null, seq = 0, fileSide = "front";

  async function preview() {
    const my = ++seq;
    if (!$f.value.trim() && !$b.value.trim()) {
      $pf.innerHTML = '<span class="muted">（入力するとここに表示）</span>'; $pb.hidden = true;
      el.querySelector(".cf-imgnote").hidden = true; return;
    }
    try {
      const r = await api("POST", "render", { front: $f.value, back: $b.value, masks });
      if (my !== seq) return;
      $pf.innerHTML = r.question_html || '<span class="muted">（表面が空です）</span>';
      $pb.innerHTML = r.back_html; $pb.hidden = !$b.value.trim();
      el.querySelector(".cf-imgnote").hidden = !r.image_ids.length;
      $pf.querySelectorAll(".card-img").forEach(im => im.addEventListener("error", () => im.replaceWith(h(`<span class="r-again">［画像が見つかりません］</span>`))));
    } catch (e) { fail(e); }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(preview, 200); };
  $f.addEventListener("input", schedule);
  $b.addEventListener("input", schedule);

  // 画像の上の穴の編集
  $pf.addEventListener("click", e => {
    const t = e.target.closest("[data-img]");
    if (!t) return;
    const id = t.dataset.img;
    openMaskEditor(id, masks[id] || [], rects => {
      if (rects.length) masks[id] = rects; else delete masks[id];
      preview();
    });
  });

  // 画像の追加
  function insertToken(ta, id) {
    const v = ta.value, a = ta.selectionStart ?? v.length, b = ta.selectionEnd ?? v.length;
    const before = a > 0 && v[a - 1] !== "\n" ? "\n" : "";
    const after = b < v.length && v[b] !== "\n" ? "\n" : "";
    ta.setRangeText(`${before}[[img:${id}]]${after}`, a, b, "end");
    ta.dispatchEvent(new Event("input"));
  }
  async function addFiles(files, ta) {
    files = imageFiles(files);
    if (!files.length) return;
    toast(files.length > 1 ? `画像を${files.length}枚取り込み中…` : "画像を取り込み中…");
    for (const f of files) {
      try { insertToken(ta, await uploadImage(f)); } catch (e) { fail(e); return; }
    }
    toast(files.length > 1 ? `画像を${files.length}枚追加しました` : "画像を追加しました");
  }
  for (const ta of [$f, $b]) {
    ta.addEventListener("paste", e => {
      const files = imageFiles(e.clipboardData && e.clipboardData.files);
      if (files.length) { e.preventDefault(); addFiles(files, ta); }
    });
    ta.addEventListener("dragover", e => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); ta.classList.add("drop"); } });
    ta.addEventListener("dragleave", () => ta.classList.remove("drop"));
    ta.addEventListener("drop", e => {
      ta.classList.remove("drop");
      const files = imageFiles(e.dataTransfer && e.dataTransfer.files);
      if (files.length) { e.preventDefault(); ta.focus(); addFiles(files, ta); }
    });
  }
  el.querySelectorAll("[data-a=img]").forEach(btn => btn.addEventListener("click", () => { fileSide = btn.dataset.side; $file.click(); }));
  $file.addEventListener("change", () => { addFiles($file.files, fileSide === "back" ? $b : $f); $file.value = ""; });
  const clozeBtn = el.querySelector("[data-a=cloze]");
  clozeBtn.addEventListener("mousedown", e => e.preventDefault());   // 選択を保ったまま
  clozeBtn.addEventListener("click", () => { $f.focus(); wrapCloze($f); });
  el.addEventListener("keydown", e => {
    if (e.code === "KeyC" && e.altKey && !e.ctrlKey && e.target.tagName === "TEXTAREA") { e.preventDefault(); wrapCloze(e.target); }
  });
  preview();
  return {
    get: () => ({ front: $f.value, back: $b.value, masks }),
    reset() { $f.value = ""; $b.value = ""; masks = {}; preview(); },
    focus() { $f.focus(); },
  };
}

/* ---------- ルーター ---------- */
const PAGES = { today: pageToday, study: pageStudy, add: pageAdd, cards: pageCards, stats: pageStats, weak: pageWeak, data: pageData };

async function route() {
  if (loginShown) return;
  const { page, params } = parseHash();
  const fn = PAGES[page] || pageToday;
  document.querySelectorAll("#tabs a").forEach(a => a.classList.toggle("active", a.dataset.page === page));
  keyHandler = null;
  $main.innerHTML = "";
  try { await fn(params); } catch (e) { fail(e); }
}
window.addEventListener("hashchange", route);
document.addEventListener("keydown", e => {
  if (document.querySelector("dialog[open]")) return;   // 編集・穴の編集の画面を開いている間は無効
  if (keyHandler) keyHandler(e);
});

/* ---------- 今日 ---------- */
async function pageToday() {
  const d = await api("GET", "dashboard");
  META.today = d.today;
  const subjBtns = d.due_by_subject.filter(x => x.count > 0)
    .map(x => `<a class="btn small" href="#/study?subject=${encodeURIComponent(x.subject)}">${esc(x.subject)} <b>${x.count}</b></a>`).join("");
  $main.append(h(`<div>
    <div class="row" style="margin-bottom:16px">
      <h1 style="margin:0">今日 <span class="sub">${fmtDate(d.today)}（午前${META.day_boundary_hour}時で日付が変わります）</span></h1>
    </div>
    <div class="tiles">
      <div class="tile"><div class="label">今日の期日</div><div class="value">${d.due_today}<small>枚</small></div>
        <div class="note">${d.overdue ? `うち期限切れ ${d.overdue}枚` : "期限切れなし"}</div></div>
      <div class="tile"><div class="label">今日の復習数</div><div class="value">${d.reviewed_today}<small>回</small></div>
        <div class="note">再確認は含めません</div></div>
      <div class="tile"><div class="label">連続日数</div><div class="value">${d.streak}<small>日</small></div>
        <div class="note">${d.reviewed_today ? "今日も学習済み" : (d.streak ? "今日学習すると続きます" : "今日から始めましょう")}</div></div>
      <div class="tile"><div class="label">全カード</div><div class="value">${d.total}<small>枚</small></div>
        <div class="note">未学習 ${d.unlearned}枚</div></div>
    </div>
    <div class="panel">
      <div class="row">
        ${d.due_today ? `<a class="btn primary big" href="#/study">学習を始める（${d.due_today}枚）</a>` : `<button class="btn big" disabled>今日の期日はありません</button>`}
        ${subjBtns ? `<span class="sub">科目を絞る：</span>${subjBtns}` : `<a class="btn" href="#/add">カードを追加する</a>`}
      </div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="panel"><h2>直近14日の実績</h2><div id="recent"></div></div>
      <div class="panel"><h2>今後7日の予定</h2><div id="forecast"></div></div>
    </div>
    <div class="panel"><h2>段階ごとの枚数</h2><div id="stages"></div></div>
  </div>`));

  stackedChart(document.getElementById("recent"), d.recent, d.today);
  forecastChart(document.getElementById("forecast"), d.forecast, d.today);
  const maxStage = Math.max(1, ...d.stages.map(s => s.count));
  document.getElementById("stages").append(h(`<div class="hbars">${d.stages.map(s => `
      <div class="lab">${s.stage ? `段階${s.stage}・${s.interval}日` : "新規"}</div>
      <div class="track"><i style="width:${(s.count / maxStage * 100).toFixed(1)}%"></i></div>
      <div class="n">${s.count}</div>`).join("")}</div>`));
  keyHandler = e => { if (e.key === "Enter" && !isTyping(e) && d.due_today) go("study"); };
}

function attachTip(chart) {
  const tip = h(`<div class="tip"></div>`);
  chart.append(tip);
  chart.querySelectorAll("[data-tip]").forEach(el => {
    el.addEventListener("mouseenter", () => { tip.innerHTML = el.dataset.tip; tip.style.display = "block"; });
    el.addEventListener("mousemove", ev => {
      const r = chart.getBoundingClientRect();
      let x = ev.clientX - r.left + 12;
      if (x + tip.offsetWidth > r.width) x = ev.clientX - r.left - tip.offsetWidth - 12;
      tip.style.left = x + "px"; tip.style.top = (ev.clientY - r.top - 10) + "px";
    });
    el.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  });
}

function stackedChart(el, rows, today) {
  const max = Math.max(1, ...rows.map(r => r.good + r.fair + r.again));
  const total = rows.reduce((a, r) => a + r.good + r.fair + r.again, 0);
  const bars = rows.map(r => {
    const sum = r.good + r.fair + r.again;
    const seg = k => r[k] ? `<div class="seg-fill c-${k}" style="height:${(r[k] / max * 100).toFixed(2)}%"></div>` : "";
    const top = (sum / max * 100);
    return `<div class="bar" data-tip="<b>${fmtDate(r.date)}</b>○ ${r.good}　△ ${r.fair}　✖ ${r.again}<br>計 ${sum}回">
      ${seg("good")}${seg("fair")}${seg("again")}
      ${sum ? `<span class="val" style="bottom:calc(${top}% + 2px)">${sum}</span>` : ""}</div>`;
  }).join("");
  const labels = rows.map((r, i) => `<span class="${r.date === today ? "today" : ""}">${i % 2 === rows.length % 2 || r.date === today ? fmtDate(r.date, false) : ""}</span>`).join("");
  el.append(h(`<div class="chart">
    <div class="legend"><span><i class="c-good"></i>○</span><span><i class="c-fair"></i>△</span><span><i class="c-again"></i>✖</span>
      <span class="spacer"></span><span>14日で計 ${total}回（再確認を除く）</span></div>
    <div class="bars">${bars}</div><div class="xlabels">${labels}</div></div>`));
  attachTip(el.querySelector(".chart"));
}

function forecastChart(el, rows, today) {
  const max = Math.max(1, ...rows.map(r => r.count));
  const bars = rows.map(r => `<div class="bar" data-tip="<b>${fmtDate(r.date)}</b>${r.date === today ? "期限切れを含む " : ""}${r.count}枚">
      ${r.count ? `<div class="seg-fill c-accent" style="height:${(r.count / max * 100).toFixed(2)}%"></div>` : ""}
      <span class="val" style="bottom:calc(${(r.count / max * 100)}% + 2px)">${r.count}</span></div>`).join("");
  const labels = rows.map(r => `<span class="${r.date === today ? "today" : ""}">${r.date === today ? "今日" : fmtDate(r.date)}</span>`).join("");
  el.append(h(`<div class="chart"><div class="legend"><span>期日になる枚数（今日は期限切れを含む）</span></div>
    <div class="bars">${bars}</div><div class="xlabels">${labels}</div></div>`));
  attachTip(el.querySelector(".chart"));
}

/* ---------- 学習 ---------- */
async function pageStudy(params) {
  const subject = params.get("subject") || "";
  const wrap = h(`<div class="study-wrap">
    <div class="study-head">
      <h1 style="margin:0">学習</h1>
      <select id="subj" aria-label="科目">${subjectOptions(subject, "全科目")}</select>
      <span class="spacer"></span><span class="sub" id="counts"></span>
    </div>
    <div class="progress"><i id="prog" style="width:0"></i></div>
    <div id="stage"></div>
    <div class="hint-keys keys-only"><kbd>Space</kbd> 次の穴を開ける／答えを表示　<kbd>Enter</kbd> 全部表示　<kbd>1</kbd> ○　<kbd>2</kbd> △　<kbd>3</kbd> ✖　<kbd>E</kbd> 編集</div>
  </div>`);
  $main.append(wrap);
  wrap.querySelector("#subj").addEventListener("change", e => go("study", e.target.value ? { subject: e.target.value } : null));

  let current = null, revealed = false, busy = false, doneCount = 0, startTotal = null;
  const stageEl = wrap.querySelector("#stage");

  async function load() {
    const n = await api("GET", "session/next" + (subject ? "?subject=" + encodeURIComponent(subject) : ""));
    const remaining = n.remaining_due + n.remaining_recheck;
    if (startTotal === null) startTotal = remaining;
    startTotal = Math.max(startTotal, doneCount + remaining);
    wrap.querySelector("#counts").innerHTML =
      `残り <b>${n.remaining_due}</b>枚` + (n.remaining_recheck ? `　再確認 <b>${n.remaining_recheck}</b>枚` : "") +
      (doneCount ? `　｜このセッション ${doneCount}回` : "");
    wrap.querySelector("#prog").style.width = startTotal ? (doneCount / startTotal * 100) + "%" : "100%";
    current = n.card ? { ...n.card, kind: n.kind } : null;
    revealed = false;
    render();
  }

  function nextWhen(r) {
    if (current.kind === "recheck") return "間隔は変わりません";
    const s = current.stage, iv = META.intervals;
    if (r === "good") { const ns = Math.min(s + 1, iv.length); return `${iv[ns - 1]}日後`; }
    if (r === "fair") return s ? `${iv[s - 1]}日後` : "明日";
    return "明日・最後に再確認";
  }

  function render() {
    stageEl.innerHTML = "";
    if (!current) {
      stageEl.append(h(`<div class="flash"><div class="done">
        <div class="big">🎉</div><h2>${subject ? esc(subject) + "の" : ""}今日の分は終わりました</h2>
        <p class="sub">このセッションで ${doneCount}回 評価しました。</p>
        <div class="row" style="justify-content:center"><a class="btn" href="#/today">今日の画面へ</a><a class="btn" href="#/add">カードを追加</a>
        ${subject ? `<a class="btn" href="#/study">全科目で続ける</a>` : ""}</div></div></div>`));
      return;
    }
    const c = current;
    stageEl.append(h(`<div>
      <div class="flash ${revealed ? "revealed" : ""}">
        <div class="meta"><span class="tag accent">${esc(c.subject)}</span>${c.unit ? `<span>${esc(c.unit)}</span>` : ""}
          <span class="spacer"></span><span class="sub" id="holes"></span>
          ${c.kind === "recheck" ? `<span class="tag warn">再確認</span>` : `<span class="tag">${intervalLabel(c.stage)}</span>`}
          <span class="muted">周回 ${c.reps}</span></div>
        <div class="q">${c.question_html}</div>
        <div class="a">${revealed ? c.back_html : ""}</div>
      </div>
      <div class="answer-bar">${revealed
        ? ["good", "fair", "again"].map((r, i) => `<button class="btn rate ${r}" data-r="${r}">
              <span class="sym">${RATING[r].sym}</span><span class="when"><kbd>${i + 1}</kbd> ${nextWhen(r)}</span></button>`).join("")
        : `<span id="pre"></span>`}</div>
      <div class="row" style="justify-content:center;margin-top:10px"><button class="btn small" id="edit">このカードを編集</button></div>
    </div>`));
    holes = [...stageEl.querySelectorAll(".q .cl, .q .mask")];
    if (revealed) holes.forEach(x => x.classList.add("open"));
    holes.forEach(x => x.addEventListener("click", e => { e.stopPropagation(); openHole(x); }));
    if (!revealed) stageEl.querySelector(".flash").addEventListener("click", openNext);   // カードをタップすると次の穴
    stageEl.querySelectorAll("[data-r]").forEach(b => b.addEventListener("click", () => rate(b.dataset.r)));
    stageEl.querySelector("#edit").addEventListener("click", edit);
    stageEl.querySelectorAll(".q .card-img").forEach(im => im.addEventListener("error", () => im.replaceWith(h(`<span class="r-again">［画像が見つかりません］</span>`))));
    updateHoles();
  }
  let holes = [];
  function updateHoles() {
    const left = holes.filter(x => !x.classList.contains("open")).length;
    const $h = stageEl.querySelector("#holes");
    if ($h) $h.textContent = holes.length && !revealed ? `穴 ${holes.length - left}/${holes.length}` : "";
    const pre = stageEl.querySelector("#pre");
    if (!pre) return;
    pre.innerHTML = holes.length
      ? `<button class="btn primary big" id="next">次を開ける <kbd>Space</kbd></button><button class="btn big" id="all">全部表示 <kbd>Enter</kbd></button>`
      : `<button class="btn primary big" id="all">答えを表示 <kbd>Space</kbd></button>`;
    pre.querySelector("#next")?.addEventListener("click", openNext);
    pre.querySelector("#all").addEventListener("click", reveal);
  }
  /* 穴を1つ開ける。全部開いたら裏面と評価ボタンを出す */
  function openHole(x) {
    if (revealed || x.classList.contains("open")) return;
    x.classList.add("open");
    if (holes.every(y => y.classList.contains("open"))) reveal(); else updateHoles();
  }
  function openNext() {
    if (!current || revealed) return;
    const next = holes.find(x => !x.classList.contains("open"));
    if (next) openHole(next); else reveal();
  }
  function reveal() { if (current && !revealed) { revealed = true; render(); } }
  async function rate(r) {
    if (!current || !revealed || busy) return;
    busy = true;
    try {
      await api("POST", "review", { card_id: current.id, rating: r });
      doneCount++;
      await load();
    } catch (e) { fail(e); } finally { busy = false; }
  }
  function edit() {
    if (!current) return;
    openEditor(current.id, async changed => {
      if (changed === "deleted") { await load(); return; }
      const fresh = await api("GET", "cards/" + current.id).catch(() => null);
      if (fresh) { current = { ...fresh, kind: current.kind }; render(); }
    });
  }
  keyHandler = e => {
    if (isTyping(e) || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === "Space" || e.key === " ") { e.preventDefault(); openNext(); }
    else if (e.key === "Enter" && !revealed) { e.preventDefault(); reveal(); }
    else if (["1", "2", "3"].includes(e.key)) { e.preventDefault(); rate(["good", "fair", "again"][+e.key - 1]); }
    else if (e.key === "e" || e.key === "E") { e.preventDefault(); edit(); }
  };
  await load();
}

/* ---------- 追加 ---------- */
async function pageAdd(params) {
  const mode = params.get("mode") === "bulk" ? "bulk" : "single";
  const subject = store.get("subject", META.subjects[0]);
  const unit = store.get("unit:" + subject, "");
  $main.append(h(`<div>
    <div class="row" style="margin-bottom:16px"><h1 style="margin:0">カードを追加</h1>
      <div class="seg"><button data-m="single" class="${mode === "single" ? "on" : ""}">1枚ずつ</button>
      <button data-m="bulk" class="${mode === "bulk" ? "on" : ""}">まとめて（1行1枚）</button></div></div>
    <div class="panel"><div class="form-grid" style="margin-bottom:12px">
      <label class="field">科目<select id="subject">${subjectOptions(subject)}</select></label>
      <label class="field">系統・単元（任意）<input type="text" id="unit" list="units" value="${esc(unit)}" placeholder="例：自律神経系"><datalist id="units"></datalist></label>
    </div><div id="body"></div></div>
  </div>`));
  $main.querySelectorAll("[data-m]").forEach(b => b.addEventListener("click", () => go("add", b.dataset.m === "bulk" ? { mode: "bulk" } : null)));
  const $s = $main.querySelector("#subject"), $u = $main.querySelector("#unit");
  async function loadUnits() {
    const list = await api("GET", "units?subject=" + encodeURIComponent($s.value)).catch(() => []);
    $main.querySelector("#units").innerHTML = list.filter(x => x.unit).map(x => `<option value="${esc(x.unit)}">`).join("");
  }
  $s.addEventListener("change", () => { store.set("subject", $s.value); $u.value = store.get("unit:" + $s.value, ""); loadUnits(); });
  $u.addEventListener("change", () => store.set("unit:" + $s.value, $u.value.trim()));
  loadUnits();
  const body = $main.querySelector("#body");
  if (mode === "single") addSingle(body, $s, $u); else addBulk(body, $s, $u);
}

function addSingle(body, $s, $u) {
  body.append(h(`<div>
    <div class="cf"></div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="save">追加する <kbd>Ctrl</kbd>+<kbd>Enter</kbd></button>
      <span class="sub">追加したカードは今日が期日になります。追加後も科目と系統はそのまま残ります。</span></div>
    <div id="recent" style="margin-top:16px"></div>
  </div>`));
  const form = cardForm(body.querySelector(".cf"));
  const added = [];
  let saving = false;
  async function save() {
    if (saving) return;
    saving = true;
    try {
      store.set("unit:" + $s.value, $u.value.trim());
      const c = await api("POST", "cards", { subject: $s.value, unit: $u.value, ...form.get() });
      added.unshift(c);
      form.reset(); form.focus();
      toast(`追加しました（${c.subject}${c.unit ? "／" + c.unit : ""}）`);
      renderRecent();
    } catch (e) { fail(e); } finally { saving = false; }
  }
  function renderRecent() {
    const el = body.querySelector("#recent");
    el.innerHTML = added.length ? `<h2>今追加したカード（${added.length}枚）</h2><div class="table-wrap"><table><thead><tr><th></th><th>科目</th><th>系統</th><th>表面</th><th></th></tr></thead><tbody>
      ${added.slice(0, 10).map(c => `<tr><td class="thumb-cell">${thumbTag(c)}</td><td>${esc(c.subject)}</td><td>${esc(c.unit)}</td><td class="front-cell">${esc(c.front_plain)}</td>
        <td><button class="btn small" data-id="${c.id}">編集</button></td></tr>`).join("")}</tbody></table></div>` : "";
    el.querySelectorAll("[data-id]").forEach(b => b.addEventListener("click", () => openEditor(+b.dataset.id, async ch => {
      const i = added.findIndex(x => x.id === +b.dataset.id);
      if (ch === "deleted") added.splice(i, 1); else added[i] = await api("GET", "cards/" + b.dataset.id);
      renderRecent();
    })));
  }
  body.querySelector("#save").addEventListener("click", save);
  // 画面のどこにいても Ctrl+Enter で追加（画像の穴の編集を閉じた直後なども）
  keyHandler = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } };
  form.focus();
}

function thumbTag(c) {
  return c.thumb_id ? `<img class="thumb" src="/api/images/${c.thumb_id}/thumb" alt="" loading="lazy">` : "";
}

function addBulk(body, $s, $u) {
  body.append(h(`<div>
    <label class="field"><span>1行に1枚：<b>表面[Tab]裏面</b>　<span class="muted">Excel の2列をコピーして貼り付けると Tab 区切りになります。穴埋めだけの行は Tab なしでも可。空行は無視します</span></span>
      <textarea id="text" rows="12" placeholder="アトロピン&#9;ムスカリン受容体遮断&#10;{{c1::ピロカルピン}}は緑内障に使う"></textarea></label>
    <div id="pv" style="margin-top:12px"></div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="add" disabled>追加する</button>
      <span class="sub">すべて上の科目・系統で、今日が期日の新規カードとして追加されます。</span></div>
  </div>`));
  const $t = body.querySelector("#text"), $pv = body.querySelector("#pv"), $add = body.querySelector("#add");
  $t.addEventListener("keydown", e => {   // テキスト欄で Tab を入力できるようにする
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); $t.setRangeText("\t", $t.selectionStart, $t.selectionEnd, "end"); $t.dispatchEvent(new Event("input")); }
    if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); $add.click(); }
  });
  let timer = null;
  $t.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(preview, 250); });
  async function preview() {
    if (!$t.value.trim()) { $pv.innerHTML = ""; $add.disabled = true; $add.textContent = "追加する"; return; }
    try {
      const p = await api("POST", "cards/bulk", { subject: $s.value, unit: $u.value, text: $t.value, dry_run: true });
      $pv.innerHTML = `<div class="sub"><b>${p.count}枚</b> を読み取りました${p.errors.length ? `。<span class="r-again">${p.errors.length}行に問題があります（直すまで追加できません）</span>` : ""}</div>
        ${p.errors.length ? `<ul class="errors">${p.errors.slice(0, 20).map(x => `<li>${x.line}行目：${esc(x.message)}</li>`).join("")}</ul>` : ""}
        ${p.samples.length ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>表面（最初の5枚）</th><th>裏面</th></tr></thead><tbody>
          ${p.samples.map(s => `<tr><td>${s.question_html}</td><td>${s.back_html}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
      $add.disabled = !p.count || p.errors.length > 0;
      $add.textContent = p.count ? `${p.count}枚を追加する` : "追加する";
    } catch (e) { fail(e); }
  }
  $add.addEventListener("click", async () => {
    if ($add.disabled) return;
    $add.disabled = true;
    try {
      store.set("unit:" + $s.value, $u.value.trim());
      const r = await api("POST", "cards/bulk", { subject: $s.value, unit: $u.value, text: $t.value });
      toast(`${r.added}枚を追加しました（${$s.value}${$u.value.trim() ? "／" + $u.value.trim() : ""}）`);
      $t.value = ""; $pv.innerHTML = ""; $add.textContent = "追加する";
    } catch (e) { fail(e); $add.disabled = false; }
  });
  $t.focus();
}

/* ---------- カード一覧 ---------- */
async function pageCards(params) {
  const f = {
    q: params.get("q") || "", subject: params.get("subject") || "", level: params.get("level") || "",
    due: params.get("due") || "", sort: params.get("sort") || "due", unit: params.has("unit") ? params.get("unit") : null,
  };
  let offset = +(params.get("offset") || 0);
  const LIMIT = 50;
  $main.append(h(`<div>
    <div class="row" style="margin-bottom:12px"><h1 style="margin:0">カード一覧</h1><span class="sub" id="total"></span></div>
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <input type="search" id="q" placeholder="表面・裏面・系統を検索" value="${esc(f.q)}" style="flex:1;min-width:200px">
        <select id="subject">${subjectOptions(f.subject, "科目：すべて")}</select>
        <select id="level">${options(LEVELS, f.level)}</select>
        <select id="due">${options(DUES, f.due)}</select>
        <select id="sort">${options(SORTS, f.sort)}</select>
      </div>
      ${f.unit !== null ? `<div class="row" style="margin-bottom:10px"><span class="tag accent">系統：${esc(f.unit || "（未設定）")}</span><button class="btn small" id="clearUnit">系統の絞り込みを外す</button></div>` : ""}
      <div class="table-wrap"><table><thead><tr><th></th><th>科目</th><th>系統</th><th>表面</th><th>間隔</th><th>期日</th><th class="num">周回</th><th>最後</th></tr></thead>
        <tbody id="rows"></tbody></table></div>
      <div class="pager" id="pager"></div>
    </div></div>`));
  const update = () => {
    const p = {};
    for (const k of ["q", "subject", "level", "due"]) if (f[k]) p[k] = f[k];
    if (f.sort !== "due") p.sort = f.sort;
    if (f.unit !== null) p.unit = f.unit;
    if (offset) p.offset = offset;
    history.replaceState(null, "", "#/cards" + (Object.keys(p).length ? "?" + new URLSearchParams(p) : ""));
    load();
  };
  let qTimer = null;
  $main.querySelector("#q").addEventListener("input", e => { clearTimeout(qTimer); qTimer = setTimeout(() => { f.q = e.target.value.trim(); offset = 0; update(); }, 250); });
  for (const k of ["subject", "level", "due", "sort"]) {
    $main.querySelector("#" + k).addEventListener("change", e => { f[k] = e.target.value; offset = 0; if (k === "subject") f.unit = null; update(); });
  }
  $main.querySelector("#clearUnit")?.addEventListener("click", () => { f.unit = null; offset = 0; go("cards", Object.fromEntries(Object.entries({ q: f.q, subject: f.subject, level: f.level, due: f.due }).filter(([, v]) => v))); });

  async function load() {
    const qs = new URLSearchParams({ limit: LIMIT, offset });
    for (const k of ["q", "subject", "level", "due", "sort"]) if (f[k]) qs.set(k, f[k]);
    if (f.unit !== null) qs.set("unit", f.unit);
    const res = await api("GET", "cards?" + qs);
    $main.querySelector("#total").textContent = `${res.total}枚`;
    const tb = $main.querySelector("#rows");
    tb.innerHTML = res.items.length ? res.items.map(c => `<tr class="clickable" data-id="${c.id}">
      <td class="thumb-cell">${thumbTag(c)}</td><td>${esc(c.subject)}</td><td>${esc(c.unit)}</td><td class="front-cell" title="${esc(c.front_plain)}">${esc(c.front_plain)}</td>
      <td>${intervalLabel(c.stage)}</td><td>${fmtDate(c.due)} <span class="sub">${relDue(c.due)}</span></td>
      <td class="num">${c.reps}</td><td>${ratingChip(c.last_rating)}</td></tr>`).join("")
      : `<tr><td colspan="8" class="empty">該当するカードはありません</td></tr>`;
    tb.querySelectorAll("tr[data-id]").forEach(tr => tr.addEventListener("click", () => openEditor(+tr.dataset.id, () => load())));
    const pg = $main.querySelector("#pager");
    const pages = Math.max(1, Math.ceil(res.total / LIMIT)), cur = Math.floor(offset / LIMIT) + 1;
    pg.innerHTML = res.total > LIMIT ? `<button class="btn small" id="prev" ${cur <= 1 ? "disabled" : ""}>前へ</button>
      <span class="sub">${cur} / ${pages}ページ</span><button class="btn small" id="next" ${cur >= pages ? "disabled" : ""}>次へ</button>` : "";
    pg.querySelector("#prev")?.addEventListener("click", () => { offset = Math.max(0, offset - LIMIT); update(); });
    pg.querySelector("#next")?.addEventListener("click", () => { offset += LIMIT; update(); });
  }
  keyHandler = e => { if (e.key === "/" && !isTyping(e)) { e.preventDefault(); $main.querySelector("#q").focus(); } };
  await load();
}

/* ---------- 編集ダイアログ ---------- */
async function openEditor(id, onChange) {
  const dlg = document.getElementById("modal");
  let c, hist;
  try { [c, hist] = await Promise.all([api("GET", "cards/" + id), api("GET", `cards/${id}/history`)]); }
  catch (e) { fail(e); return; }
  dlg.innerHTML = `<form method="dialog" id="ef">
    <div class="mh"><b>カードを編集</b><span class="tag">${intervalLabel(c.stage)}</span><span class="sub">期日 ${fmtDate(c.due)}・周回 ${c.reps}・${ratingChip(c.last_rating)}</span>
      <span class="spacer"></span><button class="btn small" value="cancel" formnovalidate>閉じる</button></div>
    <div class="mb">
      <div class="form-grid" style="margin-bottom:12px">
        <label class="field">科目<select name="subject">${subjectOptions(c.subject)}</select></label>
        <label class="field">系統・単元<input type="text" name="unit" value="${esc(c.unit)}"></label></div>
      <div class="cf"></div>
      <h2 style="margin-top:18px">評価の履歴（${hist.length}件）</h2>
      ${hist.length ? `<div class="table-wrap" style="max-height:200px"><table><thead><tr><th>学習日</th><th>日時</th><th>評価</th><th>間隔</th><th></th></tr></thead><tbody>
        ${hist.map(r => `<tr class="${r.before_reset ? "muted" : ""}"><td>${fmtDate(r.review_date)}</td><td class="sub">${esc(r.reviewed_at.replace("T", " "))}</td>
          <td>${ratingChip(r.rating)}</td><td>${r.is_recheck ? "—" : `${intervalLabel(r.stage_before)} → ${intervalLabel(r.stage_after)}`}</td>
          <td>${r.is_recheck ? '<span class="tag">再確認</span>' : ""}${r.before_reset ? '<span class="tag">リセット前</span>' : ""}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">まだ評価していません</p>`}
    </div>
    <div class="mf"><button class="btn primary" value="save" id="esave">保存 <kbd>Ctrl</kbd>+<kbd>Enter</kbd></button>
      <span class="spacer"></span>
      <button class="btn" type="button" id="ereset">学習状況をリセット</button>
      <button class="btn danger" type="button" id="edel">削除</button></div></form>`;
  const form = dlg.querySelector("#ef");
  const cf = cardForm(dlg.querySelector(".cf"), c);
  const close = () => dlg.close();
  async function save() {
    try {
      await api("PUT", "cards/" + id, { subject: form.subject.value, unit: form.unit.value, ...cf.get() });
      toast("保存しました"); close(); onChange && onChange("saved");
    } catch (e) { fail(e); }
  }
  form.addEventListener("submit", e => { if (e.submitter && e.submitter.value === "save") { e.preventDefault(); save(); } });
  form.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
  dlg.querySelector("#ereset").addEventListener("click", async () => {
    if (!confirm("このカードを新規に戻し、今日を期日にします。\n評価の履歴は残りますが、集計（周回数・○△✖・定着率）には数えなくなります。よろしいですか？")) return;
    try { await api("POST", `cards/${id}/reset`, {}); toast("学習状況をリセットしました"); close(); onChange && onChange("reset"); } catch (e) { fail(e); }
  });
  dlg.querySelector("#edel").addEventListener("click", async () => {
    if (!confirm("このカードを削除します。評価の履歴も消え、元に戻せません。よろしいですか？")) return;
    try { await api("DELETE", "cards/" + id); toast("削除しました"); close(); onChange && onChange("deleted"); } catch (e) { fail(e); }
  });
  dlg.showModal();
  cf.focus();
}

/* ---------- 科目別・系統別 ---------- */
async function pageStats() {
  const res = await api("GET", "stats/subjects");
  const open = new Set(store.get("openSubjects", []));
  $main.append(h(`<div>
    <div class="row" style="margin-bottom:12px"><h1 style="margin:0">科目別・系統別</h1>
      <span class="sub">科目の行をクリックすると系統別が開きます。○△✖は各カードの最後の評価（再確認を除く）。定着率＝間隔30日以上のカード÷全カード。</span></div>
    <div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>科目／系統</th><th class="num">枚数</th><th class="num">○</th><th class="num">△</th><th class="num">✖</th><th class="num">未学習</th>
        <th class="num">平均周回</th><th>定着率</th><th></th></tr></thead>
      <tbody id="rows"></tbody></table></div></div></div>`));
  const tb = $main.querySelector("#rows");
  const cells = r => `<td class="num">${r.total}</td><td class="num r-good">${r.good}</td><td class="num r-fair">${r.fair}</td>
    <td class="num r-again">${r.again}</td><td class="num muted">${r.unlearned}</td><td class="num">${r.avg_reps.toFixed(2)}</td>
    <td style="white-space:nowrap"><span class="meter"><i style="width:${(r.mature_rate * 100).toFixed(1)}%"></i></span>${r.total ? pct(r.mature_rate) : "—"}</td>`;
  async function render() {
    tb.innerHTML = "";
    for (const r of res.rows) {
      const isOpen = open.has(r.subject) && r.total;
      const tr = h(`<table><tbody><tr class="${r.total ? "clickable" : ""}"><td><span class="caret">${r.total ? (isOpen ? "▾" : "▸") : ""}</span><b>${esc(r.subject)}</b></td>${cells(r)}
        <td><a class="btn small" href="#/cards?subject=${encodeURIComponent(r.subject)}">一覧</a></td></tr></tbody></table>`).querySelector("tr");
      tb.append(tr);
      if (r.total) tr.addEventListener("click", e => {
        if (e.target.closest("a")) return;
        open.has(r.subject) ? open.delete(r.subject) : open.add(r.subject);
        store.set("openSubjects", [...open]); render();
      });
      if (isOpen) {
        const units = await api("GET", "stats/units?subject=" + encodeURIComponent(r.subject));
        for (const u of units) {
          const ur = h(`<table><tbody><tr class="child"><td>${u.unit ? esc(u.unit) : '<span class="muted">（系統未設定）</span>'}</td>${cells(u)}
            <td><a class="btn small" href="#/cards?subject=${encodeURIComponent(r.subject)}&unit=${encodeURIComponent(u.unit)}">一覧</a></td></tr></tbody></table>`).querySelector("tr");
          tb.append(ur);
        }
      }
    }
    const t = res.total;
    tb.append(h(`<table><tbody><tr class="total"><td>合計</td>${cells(t)}<td></td></tr></tbody></table>`).querySelector("tr"));
  }
  await render();
}

/* ---------- 苦手リスト ---------- */
async function pageWeak(params) {
  const days = +(params.get("days") || 14), min = +(params.get("min") || 2);
  const w = await api("GET", `weak?days=${days}&min=${min}`);
  const seg = (name, cur, list) => `<div class="seg">${list.map(([v, l]) => `<button data-${name}="${v}" class="${v === cur ? "on" : ""}">${l}</button>`).join("")}</div>`;
  $main.append(h(`<div>
    <div class="row" style="margin-bottom:12px"><h1 style="margin:0">苦手リスト</h1>
      <span class="sub">${fmtDate(w.start)}〜${fmtDate(w.end)} の評価から（再確認の✖は数えません）</span></div>
    <div class="row" style="margin-bottom:16px">期間 ${seg("days", days, [[7, "7日"], [14, "14日"], [30, "30日"]])}
      ✖の回数 ${seg("min", min, [[1, "1回以上"], [2, "2回以上"], [3, "3回以上"]])}</div>
    <div class="panel"><h2>✖が多いカード（${w.cards.length}枚）</h2>
      ${w.cards.length ? `<div class="table-wrap"><table><thead><tr><th class="num">✖</th><th class="num">評価</th><th>科目</th><th>系統</th><th>表面</th><th>最後の✖</th><th>間隔</th></tr></thead><tbody>
        ${w.cards.map(c => `<tr class="clickable" data-id="${c.id}"><td class="num r-again"><b>${c.again}</b></td><td class="num">${c.reviews}</td>
          <td>${esc(c.subject)}</td><td>${esc(c.unit)}</td><td class="front-cell">${esc(c.front_plain)}</td><td>${fmtDate(c.last_again)}</td><td>${intervalLabel(c.stage)}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="empty">この条件に当てはまるカードはありません</p>`}</div>
    <div class="panel"><h2>✖が多い系統</h2>
      ${w.units.length ? `<div class="table-wrap"><table><thead><tr><th>科目</th><th>系統</th><th class="num">✖</th><th class="num">✖のカード</th><th class="num">評価</th><th>✖率</th><th></th></tr></thead><tbody>
        ${w.units.map(u => `<tr><td>${esc(u.subject)}</td><td>${u.unit ? esc(u.unit) : '<span class="muted">（系統未設定）</span>'}</td>
          <td class="num r-again"><b>${u.again}</b></td><td class="num">${u.again_cards}</td><td class="num">${u.reviews}</td>
          <td style="white-space:nowrap"><span class="meter"><i style="width:${(u.again_rate * 100).toFixed(1)}%;background:var(--again)"></i></span>${pct(u.again_rate)}</td>
          <td><a class="btn small" href="#/cards?subject=${encodeURIComponent(u.subject)}&unit=${encodeURIComponent(u.unit)}">一覧</a></td></tr>`).join("")}
        </tbody></table></div>` : `<p class="empty">この期間に✖はありません</p>`}</div></div>`));
  $main.querySelectorAll("[data-days]").forEach(b => b.addEventListener("click", () => go("weak", { days: b.dataset.days, min })));
  $main.querySelectorAll("[data-min]").forEach(b => b.addEventListener("click", () => go("weak", { days, min: b.dataset.min })));
  $main.querySelectorAll("tr[data-id]").forEach(tr => tr.addEventListener("click", () => openEditor(+tr.dataset.id, () => route())));
}

/* ---------- データ ---------- */
async function pageData() {
  const m = await api("GET", "meta");
  const ipad = !m.is_local ? `<div class="panel"><h2>iPad から使用中</h2>
      <p class="sub">データは PC の下のファイルに保存されています。バックアップや取り込みも PC のファイルに対して行われます。</p></div>`
    : m.lan ? `<div class="panel"><h2>iPad から使う</h2>
      <p class="sub">iPad を PC と同じ Wi-Fi につなぎ、Safari で次のアドレスを開いて、パスコードを入力してください。</p>
      ${(m.lan_urls || []).length ? m.lan_urls.map(u => `<div class="path" style="margin:4px 0">${esc(u)}</div>`).join("")
        : `<p class="r-again">この PC の Wi-Fi のアドレスが見つかりませんでした。Wi-Fi につながっているか確認してください。</p>`}
      <div class="row" style="margin-top:10px"><span class="sub">パスコード</span><span class="passcode" id="code">${esc(m.passcode)}</span>
        <button class="btn small" id="newcode">パスコードを変更する</button></div>
      <p class="sub">パスコードを変更すると、登録済みの iPad はすべて入力し直しになります（iPad をなくしたときなど）。</p></div>`
    : `<div class="panel"><h2>iPad から使うには</h2>
      <p class="sub">いまは PC 専用モードで起動しています。黒い画面を閉じ、<b>start_ipad.bat</b> で起動し直すと、同じ Wi-Fi の iPad から使えます（パスコード付き）。</p></div>`;
  $main.append(h(`<div>
    <h1>データ（バックアップ・書き出し・取り込み）</h1>
    ${ipad}
    <div class="panel"><h2>データファイルの場所</h2>
      <div class="path">${esc(m.db_path)}</div>
      <p class="sub">カードと評価の履歴はすべてこの1つのファイルに入っています。このファイルをコピーすればバックアップになります。</p>
      <h2 style="margin-top:16px">バックアップ</h2>
      <div class="row"><button class="btn primary" id="bk">今すぐバックアップを作る</button>
        <span class="sub">保存先：</span><span class="path">${esc(m.backup_dir)}</span></div>
      <p class="sub">起動時にも1日1回、自動でバックアップを作ります（最新14個を残します）。JSONの取り込み前にも自動で作ります。</p>
      <h2 style="margin-top:16px">バックアップから戻す</h2>
      <ol class="steps sub">
        <li>黒い画面（サーバー）を閉じてアプリを終了する</li>
        <li>上の <b>flashcards.db</b> を別名（例：flashcards_old.db）に変える</li>
        <li>戻したいバックアップファイルをコピーし、名前を <b>flashcards.db</b> に変えて同じフォルダに置く</li>
        <li>アプリを起動し直す</li></ol>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="panel"><h2>JSONで書き出す</h2>
        <p class="sub">全カードと評価の履歴を1つのJSONファイルに保存します。別のPCへの移動や、念のための控えに使えます。</p>
        <a class="btn primary" href="/api/export" download>JSONファイルを書き出す</a></div>
      <div class="panel"><h2>JSONを取り込む</h2>
        <p class="sub">このアプリで書き出したJSONを読み込みます。</p>
        <div class="row" style="margin-bottom:10px"><input type="file" id="file" accept=".json,application/json"></div>
        <div style="margin-bottom:10px">
          <label class="row" style="gap:6px"><input type="radio" name="mode" value="append" checked> <b>追加</b>：今のカードはそのまま、JSONのカードを新しいカードとして足す</label>
          <label class="row" style="gap:6px"><input type="radio" name="mode" value="replace"> <b>全置き換え</b>：今のカードと履歴をすべて消して、JSONの内容にする</label></div>
        <button class="btn" id="imp" disabled>取り込む</button>
        <p class="sub">どちらの場合も、取り込む前に自動でバックアップを作ります。</p></div>
    </div>
    <p class="sub" style="margin-top:16px">バージョン ${esc(m.version)}</p>
  </div>`));
  $main.querySelector("#newcode")?.addEventListener("click", async () => {
    if (!confirm("パスコードを変更します。登録済みの iPad はすべて新しいパスコードの入力が必要になります。よろしいですか？")) return;
    try { const r = await api("POST", "lan/passcode", {}); $main.querySelector("#code").textContent = r.passcode; toast("パスコードを変更しました"); } catch (e) { fail(e); }
  });
  $main.querySelector("#bk").addEventListener("click", async () => {
    try { const r = await api("POST", "backup", {}); toast("バックアップを作りました：" + r.path.split(/[\\/]/).pop()); } catch (e) { fail(e); }
  });
  const $file = $main.querySelector("#file"), $imp = $main.querySelector("#imp");
  $file.addEventListener("change", () => { $imp.disabled = !$file.files.length; });
  $imp.addEventListener("click", async () => {
    const file = $file.files[0];
    if (!file) return;
    const mode = $main.querySelector("input[name=mode]:checked").value;
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast("JSONファイルを読み取れませんでした", true); return; }
    const n = Array.isArray(data.cards) ? data.cards.length : "?";
    const msg = mode === "replace"
      ? `今のカードと履歴をすべて消して、「${file.name}」の ${n} 枚に置き換えます。\n（取り込む前に自動でバックアップを作ります）\nよろしいですか？`
      : `「${file.name}」の ${n} 枚を、今のカードに追加します。よろしいですか？`;
    if (!confirm(msg)) return;
    $imp.disabled = true;
    try {
      const r = await api("POST", "import", { mode, data });
      toast(`${r.cards}枚（評価 ${r.reviews}件）を取り込みました`);
      $file.value = "";
    } catch (e) { fail(e); } finally { $imp.disabled = !$file.files.length; }
  });
}

/* ---------- パスコード入力（iPad など PC 以外から開いたとき） ---------- */
let loginShown = false;
function showLogin() {
  if (loginShown) return;
  loginShown = true;
  keyHandler = null;
  document.getElementById("tabs").style.visibility = "hidden";
  $main.innerHTML = "";
  $main.append(h(`<div class="panel login">
    <h1>パスコードを入力</h1>
    <p class="sub">PC の黒い画面、または PC で開いたアプリの「データ」画面に表示されている6桁の数字です。<br>
      一度入力すれば、この端末では次回から入力不要です。</p>
    <form id="lf" class="row" autocomplete="off">
      <input type="text" id="pc" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" aria-label="パスコード">
      <button class="btn primary big">入る</button></form>
    <p class="errors" id="lerr" style="padding:0"></p></div>`));
  const $pc = $main.querySelector("#pc");
  $pc.focus();
  $main.querySelector("#lf").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      await api("POST", "login", { passcode: $pc.value });
      location.reload();
    } catch (err) { $main.querySelector("#lerr").textContent = err.message; $pc.select(); }
  });
}

/* ---------- 起動 ---------- */
(async function init() {
  try { META = await api("GET", "meta"); }
  catch (e) { if (!loginShown) $main.innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; return; }
  route();
})();
