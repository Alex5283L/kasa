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
    state.skipped = skipped;
    $("loading").hidden = true;
    $("dash").hidden = false;
    render();
  } catch (e) {
    if (silent) return; // тихе оновлення не ховає вже показані дані
    $("loading").hidden = true;
    $("error").hidden = false;
    $("error").textContent = "Не вдалося завантажити дані. Перевірте інтернет і те, що таблиця опублікована, та натисніть «Оновити». (" + e.message + ")";
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

function render() {
  const { rows, opening } = periodRows();
  const inc = rows.filter(r => r.kind === "inc"), exp = rows.filter(r => r.kind === "exp");
  const incSum = inc.reduce((s, r) => s + r.sum, 0), expSum = exp.reduce((s, r) => s + r.sum, 0);

  $("balance").textContent = money(opening + incSum - expSum);
  $("inc").textContent = "+" + money(incSum);
  $("exp").textContent = "−" + money(expSum);

  const warn = $("warn");
  warn.hidden = !state.skipped;
  warn.textContent = `Не враховано операцій: ${state.skipped}. У таблиці в них незрозумілий тип — має бути «Надходження» або «Витрата».`;

  renderTrend(rows, opening);
  renderCats($("incCats"), inc, incSum, "Надходжень ще немає");
  renderCats($("expCats"), exp, expSum, "Витрат ще немає");
  renderJournal(rows);
  $("updated").textContent = "Оновлено " + time(new Date());
}

function renderCats(el, rows, total, emptyText) {
  if (!rows.length) { el.innerHTML = `<li class="empty">${emptyText}</li>`; return; }
  const sums = {};
  rows.forEach(r => { sums[r.cat] = (sums[r.cat] || 0) + r.sum; });
  el.innerHTML = Object.entries(sums).sort((a, b) => b[1] - a[1]).map(([cat, sum]) => {
    const pct = Math.round(sum / total * 100);
    return `<li><div class="row"><span>${esc(cat)}</span><b>${money(sum)}</b></div>
      <div class="bar" title="${pct}%"><i style="width:${pct}%"></i></div></li>`;
  }).join("");
}

function renderTrend(rows, opening) {
  const dated = rows.filter(r => r.date).sort((a, b) => a.date - b.date);
  const el = $("trend");
  if (!dated.length) { el.innerHTML = '<p class="empty">Ще немає операцій за цей період</p>'; return; }
  let run = opening;
  const vals = [opening, ...dated.map(r => (run += r.kind === "exp" ? -r.sum : r.sum))];
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => [
    (i / (vals.length - 1)) * 300,
    8 + (1 - (v - min) / span) * 64
  ]);
  const line = pts.map(p => p.map(n => n.toFixed(1)).join(",")).join(" ");
  el.innerHTML = `<svg viewBox="0 0 300 80" preserveAspectRatio="none" role="img" aria-label="Графік залишку">
    <polyline points="${line}" fill="none" stroke="#34c759" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
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
    html += `<div class="op"><div>${esc(r.cat)}<small>${esc(r.desc)}${r.desc && r.date ? " · " : ""}${time(r.date)}</small></div>
      <span class="sum ${r.kind}">${r.kind === "exp" ? "−" : "+"}${money(r.sum)}</span></div>`;
  }
  if (open) html += "</div>";
  $("journal").innerHTML = html || '<p class="empty" style="padding:0 4px">Операцій ще немає</p>';
  $("more").hidden = sorted.length <= state.shown;
}

/* ---------- події ---------- */

$("refresh").addEventListener("click", () => load(false));
$("more").addEventListener("click", () => { state.shown += PAGE_SIZE; render(); });

$("periods").addEventListener("click", e => {
  const btn = e.target.closest("[data-p]");
  if (!btn) return;
  state.period = btn.dataset.p;
  state.shown = PAGE_SIZE;
  document.querySelectorAll("#periods .chip").forEach(b => b.classList.toggle("on", b === btn));
  render();
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
  setTimeout(() => (btn.textContent = "Скопіювати"), 1600);
});

load(false);
setInterval(() => { if (!document.hidden) load(true); }, 60000);
