const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTWOAFpmnkadEcNZEW7AC-NhxsRTEoN1p6j80Tx6YCtmZR1FsvNIL9kOdiLNFVQQTAlzUJ1uPfW6LDJ/pub?gid=735801705&single=true&output=csv";
const CARD_NUMBER = "4874100033306757";
const PAGE_SIZE = 30;

const $ = id => document.getElementById(id);
const state = { rows: [], period: "all", shown: PAGE_SIZE };

/* ---------- допоміжні функції ---------- */

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const money = v => v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }).replace(/\s/g, "\u202f") + "\u202f₴";
const pad = n => String(n).padStart(2, "0");
const time = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "";

// Тип операції з таблиці -> 'inc' | 'exp' | null (невідомий тип не рахуємо)
function kindOf(type) {
  if (/витрат|розхід|списан|expense/i.test(type)) return "exp";
  if (/надход|внесок|дохід|поповн|income/i.test(type)) return "inc";
  return null;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  text = text.replace(/\r/g, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

function parseNumber(s) {
  const n = parseFloat(String(s).replace(/\s/g, "").replace(/[^0-9.,-]/g, "").replace(",", "."));
  return isNaN(n) ? 0 : n;
}

function parseDate(s) {
  s = String(s || "").trim();
  let m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/* ---------- завантаження ---------- */

async function load(silent) {
  state.last = Date.now();
  if (!silent) { $("loading").hidden = false; $("error").hidden = true; $("dash").hidden = true; }
  try {
    const res = await fetch(CSV_URL + "&_t=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const table = parseCSV(await res.text());
    if (table.length < 2) throw new Error("Таблиця порожня");

    let skipped = 0;
    state.rows = [];
    for (const r of table.slice(1)) {
      const sum = parseNumber(r[3]);
      if (sum <= 0) continue;
      const kind = kindOf(r[1] || "");
      if (!kind) { skipped++; continue; }
      state.rows.push({
        date: parseDate(r[0]), kind, sum,
        cat: (r[2] || "").trim() || "Без категорії",
        desc: (r[4] || "").trim()
      });
    }
    // ключ кожної операції, щоб помітити нові при наступному оновленні
    const seen = {};
    state.rows.forEach(r => {
      const base = [+r.date, r.kind, r.sum, r.cat, r.desc].join("|");
      r.key = base + "#" + (seen[base] = (seen[base] || 0) + 1);
    });
    const known = state.keys;
    state.keys = new Set(state.rows.map(r => r.key));
    state.fresh = known ? state.rows.filter(r => !known.has(r.key)) : [];
    state.skipped = skipped;
    $("loading").hidden = true;
    $("error").hidden = true;
    $("dash").hidden = false;
    if (!state.rendered) $("dash").classList.add("show");
    render(!state.rendered);
    state.rendered = true;
    if (state.fresh.length) showToast(state.fresh);
    state.fresh = [];
  } catch (e) {
    if (silent) return; // тихе оновлення не ховає вже показані дані
    $("loading").hidden = true;
    $("error").hidden = false;
    $("error").textContent = "Не вдалося завантажити дані. Перевірте інтернет — спробую ще раз за хвилину. (" + e.message + ")";
  }
}

/* ---------- відображення ---------- */

function periodRows() {
  const days = state.period === "all" ? null : +state.period;
  if (!days) return { rows: state.rows, opening: 0 };
  const cutoff = Date.now() - days * 864e5;
  const signed = r => r.kind === "exp" ? -r.sum : r.sum;
  return {
    rows: state.rows.filter(r => r.date && r.date.getTime() >= cutoff),
    opening: state.rows.filter(r => r.date && r.date.getTime() < cutoff).reduce((s, r) => s + signed(r), 0)
  };
}

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

// плавна зміна числа (без анімації, якщо значення те саме)
function animateNumber(el, to, fmt) {
  const from = el._v ?? 0;
  el._v = to;
  cancelAnimationFrame(el._raf);
  if (from === to || REDUCED) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = now => {
    const k = Math.min((now - t0) / 900, 1), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(k < 1 ? Math.round(from + (to - from) * e) : to);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

function render(animate) {
  const { rows, opening } = periodRows();
  const inc = rows.filter(r => r.kind === "inc"), exp = rows.filter(r => r.kind === "exp");
  const incSum = inc.reduce((s, r) => s + r.sum, 0), expSum = exp.reduce((s, r) => s + r.sum, 0);

  animateNumber($("balance"), opening + incSum - expSum, money);
  animateNumber($("inc"), incSum, v => "+" + money(v));
  animateNumber($("exp"), expSum, v => "−" + money(v));

  const warn = $("warn");
  warn.hidden = !state.skipped;
  warn.textContent = `Не враховано операцій: ${state.skipped}. У таблиці в них незрозумілий тип — має бути «Надходження» або «Витрата».`;

  state.trend = { rows, opening };
  renderTrend(rows, opening, animate);
  renderCats($("incCats"), inc, incSum, "Надходжень ще немає", animate);
  renderCats($("expCats"), exp, expSum, "Витрат ще немає", animate);
  renderJournal(rows);
  $("updated").textContent = "Оновлено " + time(new Date());
}

function renderCats(el, rows, total, emptyText, animate) {
  if (!rows.length) { el.innerHTML = `<li class="empty">${emptyText}</li>`; return; }
  const sums = {};
  rows.forEach(r => { sums[r.cat] = (sums[r.cat] || 0) + r.sum; });
  el.innerHTML = Object.entries(sums).sort((a, b) => b[1] - a[1]).map(([cat, sum]) => {
    const pct = Math.round(sum / total * 100);
    return `<li><div class="row"><span>${esc(cat)}</span><b>${money(sum)}</b></div>
      <div class="bar" title="${pct}%"><i data-w="${pct}" style="width:${animate && !REDUCED ? 0 : pct}%"></i></div></li>`;
  }).join("");
  if (animate && !REDUCED) requestAnimationFrame(() => requestAnimationFrame(() =>
    el.querySelectorAll("i[data-w]").forEach(i => { i.style.width = i.dataset.w + "%"; })));
}

function renderTrend(rows, opening, animate) {
  const el = $("trend"), info = $("trendInfo");
  const dated = rows.filter(r => r.date).sort((a, b) => a.date - b.date);
  if (!dated.length) { el.innerHTML = '<p class="empty">Ще немає операцій за цей період</p>'; info.innerHTML = ""; return; }

  let run = opening;
  const pts = [{ t: +dated[0].date, v: opening, text: "Початок періоду" }];
  dated.forEach(r => {
    run += r.kind === "exp" ? -r.sum : r.sum;
    pts.push({ t: +r.date, v: run, text: dayLabel(r.date) + ", " + time(r.date) });
  });

  const W = el.clientWidth || 320, H = 170, top = 24, bottom = 24, plotH = H - top - bottom;
  const vs = pts.map(p => p.v), min = Math.min(...vs), max = Math.max(...vs);
  const t0 = pts[0].t, tSpan = pts[pts.length - 1].t - t0;
  const f = n => n.toFixed(1);
  const Y = v => max === min ? top + plotH / 2 : top + (1 - (v - min) / (max - min)) * plotH;
  const xs = pts.map((p, i) => tSpan ? (p.t - t0) / tSpan * W : i / (pts.length - 1) * W);
  const dm = d => pad(d.getDate()) + "." + pad(d.getMonth() + 1);

  let d = `M${f(xs[0])} ${f(Y(pts[0].v))}`;
  for (let i = 1; i < pts.length; i++) d += ` H${f(xs[i])} V${f(Y(pts[i].v))}`;
  d += ` H${f(W)}`;
  const area = `${d} V${H - bottom} H${f(xs[0])} Z`;
  const cls = animate && !REDUCED ? " draw" : "";

  const first = dm(dated[0].date), last = dm(dated[dated.length - 1].date);
  const dots = pts.length <= 40 ? pts.slice(1).map((p, i) => `<circle class="dot" cx="${f(xs[i + 1])}" cy="${f(Y(p.v))}" r="3.5"/>`).join("") : "";

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Графік залишку">
    <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--income);stop-opacity:.3"/><stop offset="1" style="stop-color:var(--income);stop-opacity:0"/>
    </linearGradient></defs>
    <line class="grid-line" x1="0" x2="${W}" y1="${f(Y(max))}" y2="${f(Y(max))}"/>
    ${max !== min ? `<line class="grid-line" x1="0" x2="${W}" y1="${f(Y(min))}" y2="${f(Y(min))}"/>` : ""}
    <text class="lbl" x="0" y="${f(Y(max) - 6)}">${money(max)}</text>
    ${max !== min ? `<text class="lbl" x="0" y="${f(Y(min) + 15)}">${money(min)}</text>` : ""}
    <path class="trend-area${cls}" d="${area}" fill="url(#ga)"/>
    <path class="trend-line${cls}" pathLength="1" d="${d}"/>
    ${dots}
    <text class="lbl" x="0" y="${H - 6}">${first}</text>
    ${last !== first ? `<text class="lbl" x="${W}" y="${H - 6}" text-anchor="end">${last}</text>` : ""}
    <line class="cur" id="cur" x1="0" x2="0" y1="${top}" y2="${H - bottom}" style="display:none"/>
    <circle class="curdot" id="curdot" r="5.5" style="display:none"/>
  </svg>`;

  const svg = el.querySelector("svg"), cur = svg.querySelector("#cur"), dot = svg.querySelector("#curdot");
  const idle = () => { cur.style.display = dot.style.display = "none"; info.innerHTML = `Зараз <b>${money(run)}</b>`; };
  const show = i => {
    cur.setAttribute("x1", xs[i]); cur.setAttribute("x2", xs[i]);
    dot.setAttribute("cx", xs[i]); dot.setAttribute("cy", Y(pts[i].v));
    cur.style.display = dot.style.display = "";
    info.innerHTML = `<b>${money(pts[i].v)}</b> · ${esc(pts[i].text)}`;
  };
  const move = e => {
    const box = svg.getBoundingClientRect(), x = (e.clientX - box.left) * (W / box.width);
    let best = 0;
    xs.forEach((px, i) => { if (Math.abs(px - x) < Math.abs(xs[best] - x)) best = i; });
    show(best);
  };
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", idle);
  idle();
}

function dayLabel(d) {
  if (!d) return "Без дати";
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 864e5);
  if (diff === 0) return "Сьогодні";
  if (diff === 1) return "Вчора";
  return d.toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: "numeric" });
}

function renderJournal(rows) {
  const sorted = [...rows].sort((a, b) => (b.date || 0) - (a.date || 0));
  const part = sorted.slice(0, state.shown);
  let html = "", last = null, open = false;
  for (const r of part) {
    const label = dayLabel(r.date);
    if (label !== last) {
      if (open) html += "</div>";
      html += `<p class="day">${esc(label)}</p><div class="group">`;
      last = label; open = true;
    }
    html += `<div class="op${state.fresh.includes(r) ? " new" : ""}"><div>${esc(r.cat)}<small>${esc(r.desc)}${r.desc && r.date ? " · " : ""}${time(r.date)}</small></div>
      <span class="sum ${r.kind}">${r.kind === "exp" ? "−" : "+"}${money(r.sum)}</span></div>`;
  }
  if (open) html += "</div>";
  $("journal").innerHTML = html || '<p class="empty" style="padding:0 4px">Операцій ще немає</p>';
  $("more").hidden = sorted.length <= state.shown;
}

/* ---------- події ---------- */

$("more").addEventListener("click", () => { state.shown += PAGE_SIZE; render(); });

$("periods").addEventListener("click", e => {
  const btn = e.target.closest("[data-p]");
  if (!btn) return;
  state.period = btn.dataset.p;
  state.shown = PAGE_SIZE;
  document.querySelectorAll("#periods .chip").forEach(b => b.classList.toggle("on", b === btn));
  render(true);
});

$("copy").addEventListener("click", async () => {
  const btn = $("copy");
  try {
    await navigator.clipboard.writeText(CARD_NUMBER);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: CARD_NUMBER });
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  btn.textContent = "Скопійовано";
  setTimeout(() => (btn.textContent = "Копіювати картку"), 1600);
});

/* ---------- тема: авто / темна / світла ---------- */

const THEMES = ["auto", "dark", "light"];
const THEME_NAMES = { auto: "Авто", dark: "Темна", light: "Світла" };
const ICONS = {
  auto: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',
  dark: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
};
let theme = "auto";
try { theme = localStorage.getItem("theme") || "auto"; } catch {}
if (!THEMES.includes(theme)) theme = "auto";

function applyTheme() {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
  $("theme").innerHTML = ICONS[theme];
  $("theme").title = $("theme").ariaLabel = "Тема: " + THEME_NAMES[theme];
  const dark = theme === "dark" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? "#111113" : "#f2f2f5";
}

$("theme").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try { localStorage.setItem("theme", theme); } catch {}
  applyTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
applyTheme();

function showToast(fresh) {
  const t = $("toast"), r = fresh[0];
  t.textContent = fresh.length > 1
    ? `Нових операцій: ${fresh.length}`
    : (r.kind === "inc" ? "Нове надходження +" : "Нова витрата −") + money(r.sum);
  t.className = "toast " + (fresh.length === 1 ? r.kind : "");
  t.hidden = false;
  void t.offsetWidth; // перезапуск анімації
  t.classList.add("in");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 4600);
}

let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.trend && renderTrend(state.trend.rows, state.trend.opening, false), 150);
});

load(false);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - state.last > 20000) load(true);
});
setInterval(() => { if (!document.hidden) load(true); }, 180000);
