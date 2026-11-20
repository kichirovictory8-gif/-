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

/* 穴埋めのプレビュー（サーバー側 cloze.py と同じ規則） */
const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
function renderQuestion(text) {
  let out = "", pos = 0;
  for (const m of text.matchAll(CLOZE_RE)) {
    out += esc(text.slice(pos, m.index)).replace(/\n/g, "<br>");
    out += `<span class="cloze">[${m[3] ? esc(m[3]) : "&hellip;"}]</span>`;
    pos = m.index + m[0].length;
  }
  return out + esc(text.slice(pos)).replace(/\n/g, "<br>");
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

/* ---------- ルーター ---------- */
const PAGES = { today: pageToday, study: pageStudy, add: pageAdd, cards: pageCards, stats: pageStats, weak: pageWeak, data: pageData };

async function route() {
  const { page, params } = parseHash();
  const fn = PAGES[page] || pageToday;
  document.querySelectorAll("#tabs a").forEach(a => a.classList.toggle("active", a.dataset.page === page));
  keyHandler = null;
  $main.innerHTML = "";
  try { await fn(params); } catch (e) { fail(e); }
}
window.addEventListener("hashchange", route);
document.addEventListener("keydown", e => {
  if (document.getElementById("modal").open) return;
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
    <div class="hint-keys"><kbd>Space</kbd> 答えを表示　<kbd>1</kbd> ○　<kbd>2</kbd> △　<kbd>3</kbd> ✖　<kbd>E</kbd> 編集</div>
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
      <div class="flash">
        <div class="meta"><span class="tag accent">${esc(c.subject)}</span>${c.unit ? `<span>${esc(c.unit)}</span>` : ""}
          <span class="spacer"></span>
          ${c.kind === "recheck" ? `<span class="tag warn">再確認</span>` : `<span class="tag">${intervalLabel(c.stage)}</span>`}
          <span class="muted">周回 ${c.reps}</span></div>
        <div class="q">${revealed ? c.answer_html : c.question_html}</div>
        <div class="a">${revealed ? c.back_html : ""}</div>
      </div>
      <div class="answer-bar">${revealed
        ? ["good", "fair", "again"].map((r, i) => `<button class="btn rate ${r}" data-r="${r}">
              <span class="sym">${RATING[r].sym}</span><span class="when"><kbd>${i + 1}</kbd> ${nextWhen(r)}</span></button>`).join("")
        : `<button class="btn primary big" id="show">答えを表示 <kbd>Space</kbd></button>`}</div>
      <div class="row" style="justify-content:center;margin-top:10px"><button class="btn small" id="edit">このカードを編集</button></div>
    </div>`));
    stageEl.querySelector("#show")?.addEventListener("click", reveal);
    stageEl.querySelectorAll("[data-r]").forEach(b => b.addEventListener("click", () => rate(b.dataset.r)));
    stageEl.querySelector("#edit").addEventListener("click", edit);
    (stageEl.querySelector("#show") || stageEl.querySelector("[data-r]"))?.blur();
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
    if (e.code === "Space" || e.key === " ") { e.preventDefault(); reveal(); }
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
    <label class="field"><span>表面　<span class="muted">穴埋めは {{c1::語句}} または {{c1::語句::ヒント}}。語句を選んで <kbd>Alt</kbd>+<kbd>C</kbd> で囲めます</span></span>
      <textarea id="front" rows="4" placeholder="例：β1受容体を刺激すると心拍数は{{c1::増加::増減}}する"></textarea></label>
    <div class="row" style="margin:6px 0 2px"><button type="button" class="btn small" id="wrap">選んだ語句を穴埋めにする <kbd>Alt</kbd>+<kbd>C</kbd></button><span class="spacer"></span><span class="sub">表面のプレビュー</span></div><div class="preview" id="pv"><span class="muted">（入力するとここに表示）</span></div>
    <label class="field" style="margin-top:12px"><span>裏面　<span class="muted">穴埋めカードなら省略できます</span></span>
      <textarea id="back" rows="4"></textarea></label>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="save">追加する <kbd>Ctrl</kbd>+<kbd>Enter</kbd></button>
      <span class="sub">追加したカードは今日が期日になります。追加後も科目と系統はそのまま残ります。</span></div>
    <div id="recent" style="margin-top:16px"></div>
  </div>`));
  const $f = body.querySelector("#front"), $b = body.querySelector("#back"), $pv = body.querySelector("#pv");
  const added = [];
  $f.addEventListener("input", () => { $pv.innerHTML = $f.value.trim() ? renderQuestion($f.value) : '<span class="muted">（入力するとここに表示）</span>'; });
  async function save() {
    try {
      store.set("unit:" + $s.value, $u.value.trim());
      const c = await api("POST", "cards", { subject: $s.value, unit: $u.value, front: $f.value, back: $b.value });
      added.unshift(c);
      $f.value = ""; $b.value = ""; $f.dispatchEvent(new Event("input")); $f.focus();
      toast(`追加しました（${c.subject}${c.unit ? "／" + c.unit : ""}）`);
      renderRecent();
    } catch (e) { fail(e); }
  }
  function renderRecent() {
    const el = body.querySelector("#recent");
    el.innerHTML = added.length ? `<h2>今追加したカード（${added.length}枚）</h2><div class="table-wrap"><table><thead><tr><th>科目</th><th>系統</th><th>表面</th><th></th></tr></thead><tbody>
      ${added.slice(0, 10).map(c => `<tr><td>${esc(c.subject)}</td><td>${esc(c.unit)}</td><td class="front-cell">${esc(c.front_plain)}</td>
        <td><button class="btn small" data-id="${c.id}">編集</button></td></tr>`).join("")}</tbody></table></div>` : "";
    el.querySelectorAll("[data-id]").forEach(b => b.addEventListener("click", () => openEditor(+b.dataset.id, async ch => {
      const i = added.findIndex(x => x.id === +b.dataset.id);
      if (ch === "deleted") added.splice(i, 1); else added[i] = await api("GET", "cards/" + b.dataset.id);
      renderRecent();
    })));
  }
  body.querySelector("#save").addEventListener("click", save);
  body.querySelector("#wrap").addEventListener("mousedown", e => e.preventDefault());  // 選択を保ったまま
  body.querySelector("#wrap").addEventListener("click", () => { $f.focus(); wrapCloze($f); });
  body.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    if (e.code === "KeyC" && e.altKey && !e.ctrlKey && e.target.tagName === "TEXTAREA") { e.preventDefault(); wrapCloze(e.target); }
  });
  $s.addEventListener("keydown", e => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); save(); } });
  $u.addEventListener("keydown", e => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); save(); } });
  $f.focus();
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
          ${p.samples.map(s => `<tr><td>${s.question_html}</td><td>${esc(s.back)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
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
      <div class="table-wrap"><table><thead><tr><th>科目</th><th>系統</th><th>表面</th><th>間隔</th><th>期日</th><th class="num">周回</th><th>最後</th></tr></thead>
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
      <td>${esc(c.subject)}</td><td>${esc(c.unit)}</td><td class="front-cell" title="${esc(c.front_plain)}">${esc(c.front_plain)}</td>
      <td>${intervalLabel(c.stage)}</td><td>${fmtDate(c.due)} <span class="sub">${relDue(c.due)}</span></td>
      <td class="num">${c.reps}</td><td>${ratingChip(c.last_rating)}</td></tr>`).join("")
      : `<tr><td colspan="7" class="empty">該当するカードはありません</td></tr>`;
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
      <label class="field"><span>表面　<span class="muted">語句を選んで <kbd>Alt</kbd>+<kbd>C</kbd> で穴埋め</span></span><textarea name="front" rows="4">${esc(c.front)}</textarea></label>
      <div class="preview" id="epv" style="margin-top:6px">${c.question_html}</div>
      <label class="field" style="margin-top:12px">裏面<textarea name="back" rows="4">${esc(c.back)}</textarea></label>
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
  form.front.addEventListener("input", () => { dlg.querySelector("#epv").innerHTML = renderQuestion(form.front.value); });
  const close = () => dlg.close();
  async function save() {
    try {
      await api("PUT", "cards/" + id, { subject: form.subject.value, unit: form.unit.value, front: form.front.value, back: form.back.value });
      toast("保存しました"); close(); onChange && onChange("saved");
    } catch (e) { fail(e); }
  }
  form.addEventListener("submit", e => { if (e.submitter && e.submitter.value === "save") { e.preventDefault(); save(); } });
  form.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    if (e.code === "KeyC" && e.altKey && !e.ctrlKey && e.target.tagName === "TEXTAREA") { e.preventDefault(); wrapCloze(e.target); }
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
  form.front.focus();
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
  $main.append(h(`<div>
    <h1>データ（バックアップ・書き出し・取り込み）</h1>
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

/* ---------- 起動 ---------- */
(async function init() {
  try { META = await api("GET", "meta"); }
  catch (e) { $main.innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; return; }
  route();
})();
