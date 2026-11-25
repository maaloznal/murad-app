/* ============================================================
   Учет выданного аванса — логика приложения
   Данные: Google Apps Script Web App (защищён ключом доступа)
   ============================================================ */
"use strict";

/* ---------- Конфигурация ---------- */
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyIYwuTCz3AD9vWZIJkXmiY1R2BXCFSwQgvHM66BMqG0R_Xu6q1X76M_BK5rt8LFzsZ/exec";
/* Секретов в публичном коде нет: код доступа вводит пользователь,
   сервер проверяет его в CONFIG.USERS (редактор Apps Script таблицы) */

const LS = {
  data: "avansData",
  ts: "avansTs",
  auth: "avansAuth",
  theme: "avansTheme",
  ui: "avansUi",
  hideInstall: "avansHideInstall",
};

const PERIOD_LABEL = { all: "за все время", month: "в этом месяце", week: "за 7 дней", today: "сегодня" };

const state = {
  records: [],
  view: "home",
  sort: "total-desc",
  period: "all",
  q: "",
  logQ: "",
  expanded: null,
  loading: false,
  submitting: false,
  source: "loading", // script | cache | error | loading
  canWrite: null,
  lastSync: null,
  helpShownOnce: false,
  auth: { code: null, name: null },
};

/* ---------- Помощники ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const nf = new Intl.NumberFormat("ru-RU");
const fmtMoney = (n) => nf.format(Math.round(Number(n) || 0)) + " ₽";
const fmtNum = (n) => nf.format(Number(n) || 0);
const timeStr = (ts) => new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

function plural(n, forms) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
  return forms[2];
}

function iso(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function todayISO() { return iso(new Date()); }

function parseISO(s) {
  if (typeof s !== "string") return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function toISODate(v) {
  if (v instanceof Date) return iso(v);
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const d = parseISO(s);
  return d ? iso(d) : s;
}
function fmtDate(d) {
  if (!d) return "—";
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
}
function fmtDateLong(d) {
  if (!d) return "Без даты";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}
function genId() { return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function parseAmount(v) {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v == null ? "" : v).replace(/\s/g, "").replace(",", "."));
  return isNaN(n) ? 0 : n;
}
function friendlyErr(e) {
  if (e && e.name === "AbortError") return "превышено время ожидания";
  if (e && e.message && e.message !== "script" && e.message !== "AUTH") return e.message; // текст от сервера
  return "нет связи с сервером";
}

/* ---------- Иконки ---------- */
const svgWrap = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICON = {
  trash: svgWrap('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  crown: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M3 7l4 3.5L12 4l5 6.5L21 7l-1.2 10.5H4.2L3 7Z"/></svg>',
  trendDown: svgWrap('<path d="M22 17l-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>'),
  check: svgWrap('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/>'),
  alert: svgWrap('<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5h.01"/>'),
  wifiOff: svgWrap('<path d="M12 20h.01"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="m2 2 20 20"/><path d="M5.5 12.7a10 10 0 0 1 3-2.1M18.5 12.7a10 10 0 0 0-2.2-1.7"/><path d="M9.6 6.4a14 14 0 0 1 6.9-1M5.2 8.9a14 14 0 0 1 1.6-1.1"/>'),
  download: svgWrap('<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>'),
};

const GRADS = [
  "linear-gradient(135deg,#F59E0B,#F97316)",
  "linear-gradient(135deg,#10B981,#059669)",
  "linear-gradient(135deg,#F43F5E,#E11D48)",
  "linear-gradient(135deg,#8B5CF6,#7C3AED)",
  "linear-gradient(135deg,#0D9488,#14B8A6)",
  "linear-gradient(135deg,#D946EF,#C026D3)",
  "linear-gradient(135deg,#84CC16,#65A30D)",
  "linear-gradient(135deg,#FB7185,#F97316)",
];
function gradFor(key) {
  let h = 0;
  const s = String(key);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return GRADS[h % GRADS.length];
}
function initials(e) {
  return ((e.firstName || "?")[0] || "?").toUpperCase() + ((e.lastName || "")[0] || "").toUpperCase();
}

const ART = `<svg class="art" viewBox="0 0 200 140" aria-hidden="true">
  <defs>
    <linearGradient id="ec1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34D399"/><stop offset="1" stop-color="#0D9488"/></linearGradient>
    <linearGradient id="ec2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FBBF24"/><stop offset="1" stop-color="#F59E0B"/></linearGradient>
    <linearGradient id="ec3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E879F9"/><stop offset="1" stop-color="#C026D3"/></linearGradient>
  </defs>
  <ellipse cx="100" cy="128" rx="72" ry="9" fill="rgba(13,148,136,.14)"/>
  <circle cx="84" cy="66" r="44" fill="url(#ec1)"/>
  <text x="84" y="80" text-anchor="middle" font-size="38" font-weight="900" fill="#fff" font-family="Arial, sans-serif">₽</text>
  <circle cx="146" cy="92" r="24" fill="url(#ec2)"/>
  <text x="146" y="100" text-anchor="middle" font-size="20" font-weight="900" fill="#fff" font-family="Arial, sans-serif">₽</text>
  <circle cx="148" cy="40" r="13" fill="url(#ec3)"/>
  <path d="M30 40l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#FBBF24"/>
  <path d="M120 14l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#34D399"/>
</svg>`;

/* ---------- Кэш ---------- */
function saveCache() {
  try {
    localStorage.setItem(LS.data, JSON.stringify(state.records));
    localStorage.setItem(LS.ts, String(Date.now()));
  } catch (e) { /* ignore */ }
}
function loadCache() {
  try {
    const raw = localStorage.getItem(LS.data);
    if (!raw) return false;
    state.records = JSON.parse(raw);
    state.lastSync = Number(localStorage.getItem(LS.ts)) || null;
    return true;
  } catch (e) { return false; }
}

/* ---------- Авторизация ---------- */
function loadAuth() {
  try {
    const a = JSON.parse(localStorage.getItem(LS.auth) || "null");
    if (a && a.code) { state.auth = { code: String(a.code), name: a.name || null }; return true; }
  } catch (e) { /* ignore */ }
  return false;
}
function saveAuth() {
  try { localStorage.setItem(LS.auth, JSON.stringify({ code: state.auth.code, name: state.auth.name })); } catch (e) { /* ignore */ }
}
function clearAuth() {
  try {
    localStorage.removeItem(LS.auth);
    localStorage.removeItem(LS.data);
    localStorage.removeItem(LS.ts);
  } catch (e) { /* ignore */ }
  state.auth = { code: null, name: null };
  state.records = [];
  state.lastSync = null;
  state.canWrite = null;
}

/* ---------- API ---------- */
async function fetchJson(url, opts, timeout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout || 20000);
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal, redirect: "follow" }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* не JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally { clearTimeout(t); }
}

function normRec(r) {
  const first = String(r.firstName || "").trim();
  const last = String(r.lastName || "").trim();
  if (!first && !last) return null;
  return {
    id: String(r.id || "").trim() || genId(),
    date: toISODate(r.date),
    firstName: first,
    lastName: last,
    plate: String(r.plate || "").trim().toUpperCase(),
    amount: Math.round(Number(r.amount) || 0),
  };
}

async function scriptGet() {
  if (!state.auth.code) throw new Error("AUTH");
  const r = await fetchJson(SCRIPT_URL + "?t=" + Date.now() + "&key=" + encodeURIComponent(state.auth.code));
  if (r.json && r.json.code === "AUTH") throw new Error("AUTH");
  if (r.json && r.json.status === "ok" && !r.json.user) throw new Error("OLDSERVER");
  if (!r.json || r.json.status !== "ok") throw new Error("script");
  if (r.json.user) state.auth.name = r.json.user;
  return (r.json.records || []).map(normRec).filter(Boolean);
}

async function scriptPost(payload) {
  const r = await fetchJson(SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ key: state.auth.code || "" }, payload)),
  }, 25000);
  if (!r.json || r.json.status !== "ok") throw new Error((r.json && r.json.message) || "script");
  return r.json;
}

async function refresh() {
  if (state.loading) return;
  if (!state.auth.code) { showLock(); return; }
  state.loading = true;
  $("#refreshBtn").classList.add("spin");
  renderSyncTime();
  try {
    state.records = await scriptGet();
    state.source = "script";
    state.canWrite = true;
    state.lastSync = Date.now();
    saveCache();
  } catch (e) {
    if (e && e.message === "AUTH") {
      clearAuth();
      state.source = "error";
      showLock("Код доступа больше не действует. Войдите заново.");
    } else if (!state.records.length) state.source = "error";
    else state.source = "cache";
  } finally {
    state.loading = false;
    $("#refreshBtn").classList.remove("spin");
    renderAll();
  }
}

/* ---------- Агрегация ---------- */
function periodStart(period) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "today") return +d;
  if (period === "week") { const w = new Date(d); w.setDate(w.getDate() - 6); return +w; }
  if (period === "month") return +new Date(now.getFullYear(), now.getMonth(), 1);
  return -Infinity;
}
function inPeriod(rec) {
  const s = periodStart(state.period);
  if (s === -Infinity) return true;
  const d = parseISO(rec.date);
  return d ? +d >= s : false;
}
function matchesQ(rec, q) {
  if (!q) return true;
  const t = (rec.firstName + " " + rec.lastName + " " + rec.plate).toLowerCase();
  return t.indexOf(q) !== -1;
}

function currentEmployees() {
  const q = state.q.trim().toLowerCase();
  const recs = state.records.filter((r) => inPeriod(r) && matchesQ(r, q));
  const map = new Map();
  for (const r of recs) {
    const key = (r.firstName + "|" + r.lastName).trim().toLowerCase();
    let e = map.get(key);
    if (!e) { e = { key, firstName: r.firstName, lastName: r.lastName, plates: [], count: 0, total: 0, records: [] }; map.set(key, e); }
    if (r.plate && e.plates.indexOf(r.plate) === -1) e.plates.push(r.plate);
    e.count++;
    e.total += r.amount;
    e.records.push(r);
  }
  const list = Array.from(map.values());
  const cmp = {
    "total-desc": (a, b) => b.total - a.total || b.count - a.count,
    "total-asc": (a, b) => a.total - b.total || a.count - b.count,
    "name": (a, b) => (a.lastName + " " + a.firstName).localeCompare(b.lastName + " " + b.firstName, "ru"),
    "count": (a, b) => b.count - a.count || b.total - a.total,
  }[state.sort] || function () { return 0; };
  list.sort(cmp);
  for (const e of list) {
    e.records.sort((a, b) => (b.date || "").localeCompare(a.date || "") || String(b.id).localeCompare(String(a.id)));
  }
  return { list, recs };
}

/* ---------- Рендер ---------- */
function renderSyncTime() {
  $("#syncTime").textContent = state.loading
    ? "обновление…"
    : state.lastSync ? "в " + timeStr(state.lastSync) : "—";
}

function renderBadges() {
  const badge = $("#sourceBadge"), txt = $("#sourceText");
  if (state.source === "script") { badge.className = "hero-badge"; txt.textContent = "онлайн"; }
  else if (state.source === "auth") { badge.className = "hero-badge off"; txt.textContent = "нет доступа"; }
  else if (state.source === "loading") { badge.className = "hero-badge off"; txt.textContent = "…"; }
  else { badge.className = "hero-badge off"; txt.textContent = "офлайн"; }
}

function renderStatus() {
  const bar = $("#statusBar");
  let hide = false;
  try { hide = !!sessionStorage.getItem("avansHideStatus"); } catch (e) { /* ignore */ }
  if (state.source === "auth") {
    bar.classList.remove("hidden", "offline");
    $("#statusTitle").textContent = "Сервер отклонил ключ доступа";
    $("#statusText").textContent = "Ключ API_KEY в приложении не совпадает с CONFIG.API_KEY в Apps Script. Проверьте оба места (инструкция — в README на GitHub).";
    $("#statusAction").textContent = "Повторить";
    $("#statusIcon").innerHTML = ICON.alert;
  } else if (state.source === "cache" || state.source === "error") {
    bar.classList.remove("hidden");
    bar.classList.add("offline");
    $("#statusTitle").textContent = state.source === "error" ? "Данные не загрузились" : "Нет соединения";
    $("#statusText").textContent = state.source === "error"
      ? "Проверьте интернет и попробуйте снова."
      : "Показаны сохраненные данные" + (state.lastSync ? " (обновлено в " + timeStr(state.lastSync) + ")" : "") + ".";
    $("#statusAction").textContent = "Повторить";
    $("#statusIcon").innerHTML = ICON.wifiOff;
  } else {
    bar.classList.add("hidden");
  }
}

function renderHero() {
  const recs = state.records.filter(inPeriod);
  const total = recs.reduce((s, r) => s + r.amount, 0);
  const people = new Set(recs.map((r) => (r.firstName + "|" + r.lastName).toLowerCase())).size;
  $("#heroTotal").textContent = fmtMoney(total);
  $("#heroPeople").textContent = fmtNum(people);
  $("#heroCount").textContent = fmtNum(recs.length);
  $("#heroAvg").textContent = fmtMoney(recs.length ? Math.round(total / recs.length) : 0);
  $("#heroPeriod").textContent = PERIOD_LABEL[state.period] || "за все время";
  const allTotal = state.records.reduce((s, r) => s + r.amount, 0);
  const heroAll = $("#heroAll");
  if (state.period !== "all" && allTotal > 0) {
    heroAll.textContent = "за все время: " + fmtMoney(allTotal);
    heroAll.classList.remove("hidden");
  } else {
    heroAll.classList.add("hidden");
  }
  renderChart();
}

function renderChart() {
  const wrap = $(".hero-chart");
  const svg = $("#heroChart");
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push({ t: +d, sum: 0 });
  }
  for (const r of state.records) {
    const d = parseISO(r.date);
    if (!d) continue;
    d.setHours(0, 0, 0, 0);
    const day = days.find((x) => x.t === +d);
    if (day) day.sum += r.amount;
  }
  const max = Math.max.apply(null, days.map((x) => x.sum));
  if (max <= 0) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  const W = 320, H = 56, gap = 6, n = days.length;
  const bw = (W - gap * (n - 1)) / n;
  let bars = "";
  days.forEach((x, i) => {
    const h = Math.max(3, Math.round((x.sum / max) * (H - 4)));
    const isToday = i === n - 1;
    bars += `<rect x="${((bw + gap) * i).toFixed(1)}" y="${H - h}" width="${bw.toFixed(1)}" height="${h}" rx="${Math.min(5, bw / 2)}" fill="${isToday ? "#FCD34D" : "rgba(255,255,255,.5)"}"><title>${fmtDate(new Date(x.t))}: ${fmtMoney(x.sum)}</title></rect>`;
  });
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.innerHTML = bars;
}

function leaderCard(e, cls, tag) {
  const icon = cls === "max" ? ICON.crown : ICON.trendDown;
  return `<button type="button" class="leader ${cls}" data-key="${esc(e.key)}">
    <span class="leader-tag">${icon}${tag}</span>
    <span class="leader-row">
      <span class="leader-av">${esc(initials(e))}</span>
      <span class="leader-names"><span class="leader-name">${esc(e.firstName)} ${esc(e.lastName)}</span><span class="leader-sub">${e.count} ${plural(e.count, ["выдача", "выдачи", "выдач"])}</span></span>
    </span>
    <span class="leader-amt">${fmtMoney(e.total)}</span>
  </button>`;
}

function renderLeaders() {
  const el = $("#leaders");
  const { list } = currentEmployees();
  if (list.length < 1) { el.innerHTML = ""; return; }
  const max = list.reduce((a, b) => (b.total > a.total ? b : a));
  const min = list.reduce((a, b) => (b.total < a.total ? b : a));
  let html = leaderCard(max, "max", "Больше всех");
  if (list.length > 1 && min.key !== max.key) html += leaderCard(min, "min", "Меньше всех");
  el.innerHTML = '<div class="leaders-grid">' + html + "</div>";
}

function detailsHtml(e) {
  if (!e.records.length) return "";
  const rows = e.records.map((r) =>
    `<div class="det-row" data-id="${esc(r.id)}">
      <span class="det-date">${r.date ? esc(fmtDate(parseISO(r.date))) : "—"}</span>
      ${r.plate ? '<span class="plate sm">' + esc(r.plate) + "</span>" : ""}
      <span class="det-amt">${fmtMoney(r.amount)}</span>
      <button class="icon-btn del" type="button" aria-label="Удалить выдачу">${ICON.trash}</button>
    </div>`).join("");
  return `<div><div class="det-inner">${rows}</div></div>`;
}

function empCard(e, i, maxTotal) {
  const pct = maxTotal > 0 ? Math.max(2, Math.round((e.total / maxTotal) * 100)) : 0;
  const open = state.expanded === e.key;
  const top1 = state.sort === "total-desc" && i === 0 && e.total > 0 ? " top1" : "";
  const plates = e.plates.slice(0, 2).map((p) => '<span class="plate">' + esc(p) + "</span>").join("");
  const extra = e.plates.length > 2 ? '<span class="plate">+' + (e.plates.length - 2) + "</span>" : "";
  return `<article class="emp${open ? " open" : ""}${top1}" data-key="${esc(e.key)}" style="--i:${i}">
    <div class="emp-head" role="button" tabindex="0" aria-expanded="${open}">
      <div class="avatar" style="background:${gradFor(e.key)}">${esc(initials(e))}</div>
      <div class="emp-info">
        <div class="emp-name">${esc(e.firstName)} ${esc(e.lastName)}</div>
        <div class="emp-sub">${plates}${extra}<span class="cnt">${e.count} ${plural(e.count, ["выдача", "выдачи", "выдач"])}</span></div>
      </div>
      <div class="emp-amount"><div class="amt">${fmtMoney(e.total)}</div><div class="share">${pct}%</div></div>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </div>
    <div class="emp-bar"><i style="width:${pct}%;background:${gradFor(e.key)}"></i></div>
    <div class="emp-details">${detailsHtml(e)}</div>
  </article>`;
}

function skeletonHtml() {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += `<div class="emp skel"><div class="skel-row"><div class="skel-av"></div><div class="skel-lines"><i></i><i></i></div><div class="skel-amt"></div></div><div class="skel-bar"></div></div>`;
  }
  return out;
}
function logSkeleton() {
  let out = '<div class="log-skel">';
  for (let i = 0; i < 5; i++) out += "<i></i>";
  return out + "</div>";
}

function emptyHomeHtml() {
  if (state.source === "error") {
    return `<div class="empty">${ART}<h3>Не удалось загрузить данные</h3><p>Проверьте интернет-соединение и попробуйте снова</p><button class="btn-primary sm" id="emptyRetry" type="button">Повторить</button></div>`;
  }
  return `<div class="empty">${ART}<h3>Пока нет ни одного аванса</h3><p>Добавьте первую выдачу — она сразу появится в Google-таблице и на дашборде</p><button class="btn-primary sm" id="emptyAdd" type="button">Выдать первый аванс</button></div>`;
}
function noResultsHtml() {
  return `<div class="empty"><h3>Ничего не найдено</h3><p>Попробуйте изменить запрос или сбросить фильтры</p><button class="btn-ghost" id="resetFilters" type="button">Сбросить фильтры</button></div>`;
}
function logEmptyHtml() {
  return `<div class="empty">${ART}<h3>Журнал пуст</h3><p>Выданные авансы появятся здесь</p></div>`;
}

function renderEmployees() {
  const wrap = $("#empList");
  const emptyEl = $("#homeEmpty");
  if ((state.loading || state.source === "loading") && !state.records.length) {
    wrap.innerHTML = skeletonHtml();
    emptyEl.innerHTML = "";
    $("#listCount").textContent = "…";
    return;
  }
  const { list } = currentEmployees();
  $("#listCount").textContent = fmtNum(list.length);
  if (!state.records.length) { wrap.innerHTML = ""; emptyEl.innerHTML = emptyHomeHtml(); return; }
  if (!list.length) { wrap.innerHTML = ""; emptyEl.innerHTML = noResultsHtml(); return; }
  emptyEl.innerHTML = "";
  const maxTotal = Math.max.apply(null, list.map((e) => e.total).concat([1]));
  wrap.innerHTML = list.map((e, i) => empCard(e, i, maxTotal)).join("");
}

function logRow(r) {
  return `<div class="log-row">
    <div class="avatar sm" style="background:${gradFor(r.firstName + "|" + r.lastName)}">${esc(initials(r))}</div>
    <div class="log-info"><b>${esc(r.firstName)} ${esc(r.lastName)}</b><span>${r.plate ? esc(r.plate) + " · " : ""}${r.date ? esc(fmtDate(parseISO(r.date))) : "без даты"}</span></div>
    <div class="log-amt">${fmtMoney(r.amount)}</div>
    <button class="icon-btn del" type="button" data-id="${esc(r.id)}" aria-label="Удалить выдачу">${ICON.trash}</button>
  </div>`;
}

function renderLog() {
  const q = state.logQ.trim().toLowerCase();
  const recs = state.records
    .filter((r) => matchesQ(r, q))
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || String(b.id).localeCompare(String(a.id)));
  const sum = recs.reduce((s, r) => s + r.amount, 0);
  const sumEl = $("#logSummary");
  if (recs.length) {
    sumEl.textContent = recs.length + " " + plural(recs.length, ["выдача", "выдачи", "выдач"]) + " · " + fmtMoney(sum);
    sumEl.classList.remove("hidden");
  } else {
    sumEl.classList.add("hidden");
  }
  const listEl = $("#logList");
  const emptyEl = $("#logEmpty");
  if ((state.loading || state.source === "loading") && !state.records.length) {
    listEl.innerHTML = logSkeleton();
    emptyEl.innerHTML = "";
    return;
  }
  if (!recs.length) {
    listEl.innerHTML = "";
    emptyEl.innerHTML = state.records.length
      ? '<div class="empty"><h3>Ничего не найдено</h3><p>Попробуйте другой запрос</p></div>'
      : logEmptyHtml();
    return;
  }
  emptyEl.innerHTML = "";
  const groups = new Map();
  for (const r of recs) {
    const k = r.date || "—";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  listEl.innerHTML = Array.from(groups.entries()).map(([k, rows]) => {
    const d = k === "—" ? null : parseISO(k);
    const daySum = rows.reduce((s, r) => s + r.amount, 0);
    return `<div class="log-group">
      <div class="log-date">${d ? esc(fmtDateLong(d)) : "Без даты"} <b>${fmtMoney(daySum)}</b></div>
      ${rows.map(logRow).join("")}
    </div>`;
  }).join("");
}

function renderAll() {
  renderBadges();
  renderStatus();
  renderHero();
  renderLeaders();
  renderEmployees();
  if (state.view === "log") renderLog();
  renderSyncTime();
}

/* ---------- Навигация ---------- */
function setView(v) {
  state.view = v;
  $$(".view").forEach((s) => s.classList.toggle("hidden", s.id !== "view-" + v));
  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  window.scrollTo({ top: 0 });
  if (v === "log") renderLog();
}

/* ---------- Тост ---------- */
let toastTimer = null;
function toast(msg, type) {
  const el = $("#toast");
  el.className = "toast show " + (type || "info");
  const ic = type === "success" ? ICON.check : type === "error" ? ICON.alert : ICON.alert;
  el.innerHTML = ic + "<span>" + esc(msg) + "</span>";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 2800);
}

/* ---------- Модальные окна ---------- */
function confirmSheet(title, text, okLabel) {
  return new Promise((resolve) => {
    $("#sheetTitle").textContent = title;
    $("#sheetText").textContent = text;
    $("#sheetOk").textContent = okLabel || "Удалить";
    const bd = $("#backdrop"), sh = $("#sheet");
    bd.classList.add("show");
    sh.classList.add("show");
    const done = (v) => {
      bd.classList.remove("show");
      sh.classList.remove("show");
      $("#sheetOk").onclick = $("#sheetCancel").onclick = bd.onclick = null;
      resolve(v);
    };
    $("#sheetOk").onclick = () => done(true);
    $("#sheetCancel").onclick = () => done(false);
    bd.onclick = () => done(false);
  });
}
function openHelp() { $("#helpBackdrop").classList.add("show"); $("#helpSheet").classList.add("show"); }
function closeHelp() { $("#helpBackdrop").classList.remove("show"); $("#helpSheet").classList.remove("show"); }

/* ---------- Конфетти ---------- */
function confetti() {
  const host = $("#confetti");
  const hero = $(".hero");
  if (!host || !hero) return;
  const r = hero.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + 46;
  const colors = ["#F59E0B", "#10B981", "#E11D48", "#7C3AED", "#0D9488", "#F43F5E", "#84CC16", "#D946EF"];
  for (let i = 0; i < 18; i++) {
    const s = document.createElement("i");
    s.style.setProperty("--c", colors[i % colors.length]);
    s.style.setProperty("--x", (Math.random() * 280 - 140).toFixed(0) + "px");
    s.style.setProperty("--y", (-(70 + Math.random() * 170)).toFixed(0) + "px");
    s.style.setProperty("--r", (Math.random() * 720 - 360).toFixed(0) + "deg");
    s.style.left = x + "px";
    s.style.top = y + "px";
    host.appendChild(s);
    setTimeout(() => s.remove(), 1000);
  }
}

/* ---------- Вход / выход ---------- */
function showLock(message) {
  const lock = $("#lockScreen");
  if (!lock) return;
  lock.classList.remove("hidden");
  $("#lockError").textContent = message || "";
  $("#lockCode").value = "";
  setTimeout(() => { try { $("#lockCode").focus(); } catch (e) { /* ignore */ } }, 200);
}
function hideLock() {
  const lock = $("#lockScreen");
  if (lock) lock.classList.add("hidden");
}
function lockError(msg) {
  $("#lockError").textContent = msg;
  const input = $("#lockCode");
  input.classList.add("invalid");
  setTimeout(() => input.classList.remove("invalid"), 700);
}

async function login() {
  if (state.submitting) return;
  const code = String($("#lockCode").value || "").trim();
  if (!code) { lockError("Введите код доступа"); return; }

  state.submitting = true;
  const btn = $("#lockBtn"), label = btn.querySelector("span");
  btn.disabled = true;
  label.textContent = "Проверяем…";
  $("#lockError").textContent = "";
  try {
    state.auth = { code, name: null };
    const recs = await scriptGet();
    saveAuth();
    hideLock();
    state.records = recs;
    state.source = "script";
    state.canWrite = true;
    state.lastSync = Date.now();
    saveCache();
    renderAll();
    toast("Вы вошли" + (state.auth.name ? " как " + state.auth.name : "") + "!", "success");
  } catch (e) {
    state.auth = { code: null, name: null };
    if (e && e.message === "AUTH") lockError("Неверный код доступа");
    else if (e && e.message === "OLDSERVER") lockError("Сервер ещё без авторизации. Обновите код в Apps Script таблицы (Расширения → Apps Script) и разверните новую версию");
    else lockError("Нет связи с сервером — проверьте интернет");
  } finally {
    state.submitting = false;
    btn.disabled = false;
    label.textContent = "Войти";
  }
}

async function askLogout() {
  const ok = await confirmSheet(
    "Выйти из аккаунта?",
    "Данные останутся на сервере" + (state.auth.name ? ". Вы вошли как " + state.auth.name : "") + ". Для входа понадобится код доступа.",
    "Выйти"
  );
  if (!ok) return;
  clearAuth();
  state.source = "loading";
  renderAll();
  showLock();
  toast("Вы вышли. Локальная копия данных удалена с устройства.", "info");
}

/* ---------- Действия ---------- */
async function askDelete(id) {
  const rec = state.records.find((r) => r.id === id);
  if (!rec) return;
  const ok = await confirmSheet(
    "Удалить выдачу?",
    rec.firstName + " " + rec.lastName + " — " + fmtMoney(rec.amount) + (rec.date ? ", " + fmtDate(parseISO(rec.date)) : "")
  );
  if (!ok) return;
  if (state.canWrite === false) {
    openHelp();
    toast("Удаление доступно после настройки доступа", "info");
    return;
  }
  const idx = state.records.indexOf(rec);
  state.records.splice(idx, 1);
  saveCache();
  renderAll();
  try {
    await scriptPost({ action: "delete", id: rec.id });
    toast("Выдача удалена", "success");
    refresh();
  } catch (e) {
    state.records.splice(idx, 0, rec);
    saveCache();
    renderAll();
    toast("Не удалось удалить: " + friendlyErr(e), "error");
  }
}

function checkNameHint() {
  const first = $("#fFirst").value.trim().toLowerCase();
  const last = $("#fLast").value.trim().toLowerCase();
  const hint = $("#nameHint");
  if (!first || !last) { hint.classList.add("hidden"); return; }
  const key = first + "|" + last;
  const recs = state.records.filter((r) => (r.firstName + "|" + r.lastName).trim().toLowerCase() === key);
  if (recs.length) {
    const total = recs.reduce((s, r) => s + r.amount, 0);
    hint.textContent = "У " + recs[0].firstName + " " + recs[0].lastName + " уже " + recs.length + " " +
      plural(recs.length, ["выдача", "выдачи", "выдач"]) + " на " + fmtMoney(total);
    hint.classList.remove("hidden");
  } else {
    hint.classList.add("hidden");
  }
}

function exportCsv() {
  if (!state.records.length) { toast("Нет данных для экспорта", "info"); return; }
  const rows = [["ID", "Дата", "Имя", "Фамилия", "Гос. номер", "Сумма"]].concat(
    state.records.map((r) => [r.id, r.date, r.firstName, r.lastName, r.plate, r.amount])
  );
  const csv = "\uFEFF" + rows.map((r) => r.map((v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"').join(";")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "avansy.csv";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  toast("Файл CSV скачан", "success");
}

/* ---------- Состояние UI ---------- */
function persistUi() {
  try { localStorage.setItem(LS.ui, JSON.stringify({ sort: state.sort, period: state.period })); } catch (e) { /* ignore */ }
}
function restoreUi() {
  try {
    const u = JSON.parse(localStorage.getItem(LS.ui) || "{}");
    if (u.sort) state.sort = u.sort;
    if (u.period) state.period = u.period;
  } catch (e) { /* ignore */ }
}
function syncChips() {
  $$("#sortChips .chip").forEach((c) => c.classList.toggle("active", c.dataset.sort === state.sort));
  $$("#periodChips .chip").forEach((c) => c.classList.toggle("active", c.dataset.period === state.period));
}
function resetFilters() {
  state.q = "";
  $("#searchInput").value = "";
  $("#searchClear").classList.add("hidden");
  state.period = "all";
  state.sort = "total-desc";
  syncChips();
  persistUi();
  renderHero();
  renderLeaders();
  renderEmployees();
}

/* ---------- Тема ---------- */
function applyTheme(t) {
  document.documentElement.classList.toggle("dark", t === "dark");
  $("#metaTheme").setAttribute("content", t === "dark" ? "#0E141B" : "#F4F7F5");
}

/* ---------- Установка PWA ---------- */
function initInstall() {
  const el = $("#installBanner");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone || localStorage.getItem(LS.hideInstall)) return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let promptEvent = null;
  const dismiss = () => { localStorage.setItem(LS.hideInstall, "1"); el.innerHTML = ""; };
  const render = () => {
    el.innerHTML = `<div class="install">
      <div class="install-icon">${ICON.download}</div>
      <div class="install-text"><b>Установить приложение</b><span>${isIOS ? "Поделиться → «На экран Домой»" : "Работает офлайн, как обычное приложение"}</span></div>
      ${promptEvent ? '<button class="install-btn" id="installGo" type="button">Установить</button>' : ""}
      <button class="install-x" id="installNo" type="button" aria-label="Закрыть"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>`;
    const go = $("#installGo");
    if (go) {
      go.onclick = async () => {
        promptEvent.prompt();
        try {
          const res = await promptEvent.userChoice;
          if (res && res.outcome === "accepted") { toast("Приложение установлено", "success"); dismiss(); }
        } catch (e) { /* ignore */ }
      };
    }
    $("#installNo").onclick = dismiss;
  };
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); promptEvent = e; render(); });
  window.addEventListener("appinstalled", () => { el.innerHTML = ""; });
  if (isIOS) render();
}

/* ---------- Pull-to-refresh ---------- */
function initPtr() {
  const ind = $("#ptr");
  let sy = null, pulling = false, dist = 0;
  window.addEventListener("touchstart", (e) => {
    if (window.scrollY <= 0 && state.view === "home") sy = e.touches[0].clientY;
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (sy == null) return;
    const dy = e.touches[0].clientY - sy;
    if (dy > 12 && window.scrollY <= 0) {
      pulling = true;
      dist = Math.min(dy, 120);
      ind.style.transform = "translate(-50%," + (dist * 0.45).toFixed(0) + "px)";
      ind.style.opacity = String(Math.min(1, dist / 70));
    }
  }, { passive: true });
  window.addEventListener("touchend", () => {
    if (pulling && dist >= 60) refresh();
    ind.style.transform = "";
    ind.style.opacity = "";
    pulling = false;
    sy = null;
    dist = 0;
  });
}

/* ---------- Service Worker ---------- */
function initSw() {
  if (!("serviceWorker" in navigator)) return;
  const host = location.hostname;
  if (location.protocol === "https:" && /(^|\.)github\.io$/.test(host)) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}

/* ---------- Привязка событий ---------- */
function bind() {
  $("#bottomnav").addEventListener("click", (e) => {
    const b = e.target.closest(".navbtn");
    if (b) setView(b.dataset.view);
  });

  $("#refreshBtn").onclick = refresh;
  $("#syncBtn").onclick = refresh;

  $("#themeBtn").onclick = () => {
    const cur = document.documentElement.classList.contains("dark") ? "dark" : "light";
    const next = cur === "dark" ? "light" : "dark";
    applyTheme(next);
    localStorage.setItem(LS.theme, next);
  };

  $("#statusAction").onclick = () => refresh();
  $("#statusClose").onclick = () => {
    $("#statusBar").classList.add("hidden");
  };

  $("#lockForm").addEventListener("submit", (ev) => { ev.preventDefault(); login(); });
  $("#logoutBtn").onclick = askLogout;

  $("#helpClose").onclick = closeHelp;
  $("#helpRetry").onclick = () => { closeHelp(); refresh(); };
  $("#helpBackdrop").onclick = closeHelp;

  $("#sortChips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    state.sort = b.dataset.sort;
    syncChips();
    persistUi();
    renderLeaders();
    renderEmployees();
  });
  $("#periodChips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    state.period = b.dataset.period;
    syncChips();
    persistUi();
    renderHero();
    renderLeaders();
    renderEmployees();
  });

  let searchTimer = null;
  $("#searchInput").addEventListener("input", (e) => {
    state.q = e.target.value;
    $("#searchClear").classList.toggle("hidden", !state.q);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { renderLeaders(); renderEmployees(); }, 120);
  });
  $("#searchClear").onclick = () => {
    state.q = "";
    $("#searchInput").value = "";
    $("#searchClear").classList.add("hidden");
    renderLeaders();
    renderEmployees();
  };

  let logTimer = null;
  $("#logSearch").addEventListener("input", (e) => {
    state.logQ = e.target.value;
    clearTimeout(logTimer);
    logTimer = setTimeout(renderLog, 120);
  });

  $("#leaders").addEventListener("click", (e) => {
    const b = e.target.closest(".leader");
    if (!b) return;
    const key = b.dataset.key;
    state.expanded = key;
    renderEmployees();
    const card = document.querySelector('.emp[data-key="' + CSS.escape(key) + '"]');
    if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  $("#empList").addEventListener("click", (e) => {
    const del = e.target.closest(".det-row .icon-btn.del");
    if (del) { e.stopPropagation(); askDelete(del.closest(".det-row").dataset.id); return; }
    const head = e.target.closest(".emp-head");
    if (head) {
      const card = head.closest(".emp");
      state.expanded = state.expanded === card.dataset.key ? null : card.dataset.key;
      renderEmployees();
    }
  });
  $("#empList").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const head = e.target.closest(".emp-head");
    if (head) {
      e.preventDefault();
      const card = head.closest(".emp");
      state.expanded = state.expanded === card.dataset.key ? null : card.dataset.key;
      renderEmployees();
    }
  });

  $("#logList").addEventListener("click", (e) => {
    const del = e.target.closest(".icon-btn.del");
    if (del) askDelete(del.dataset.id);
  });

  $("#homeEmpty").addEventListener("click", (e) => {
    if (e.target.closest("#emptyAdd")) setView("add");
    if (e.target.closest("#emptyRetry")) refresh();
    if (e.target.closest("#resetFilters")) resetFilters();
  });

  $("#fFirst").addEventListener("input", checkNameHint);
  $("#fLast").addEventListener("input", checkNameHint);
  $("#fPlate").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });
  $("#fAmount").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/[^\d]/g, ""); });
  $("#fAmount").addEventListener("blur", (e) => {
    const n = parseInt(e.target.value.replace(/\s/g, ""), 10);
    if (n > 0) e.target.value = nf.format(n);
  });

  $("#quickAmounts").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-amt]");
    if (!b) return;
    $("#fAmount").value = nf.format(Number(b.dataset.amt));
  });

  $("#addForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (state.submitting) return;
    const first = $("#fFirst"), last = $("#fLast"), dateEl = $("#fDate"), amountEl = $("#fAmount");
    [first, last, amountEl].forEach((el) => el.classList.remove("invalid"));
    const vFirst = first.value.trim();
    const vLast = last.value.trim();
    const vDate = dateEl.value || todayISO();
    const vAmount = parseAmount(amountEl.value);
    let bad = null;
    if (!vFirst) { first.classList.add("invalid"); bad = first; }
    if (!vLast) { last.classList.add("invalid"); bad = bad || last; }
    if (!(vAmount > 0)) { amountEl.classList.add("invalid"); bad = bad || amountEl; }
    if (bad) { bad.focus(); toast("Заполните имя, фамилию и сумму", "error"); return; }

    const plate = $("#fPlate").value.trim().toUpperCase();
    const payload = { action: "add", id: genId(), date: vDate, firstName: vFirst, lastName: vLast, plate: plate, amount: Math.round(vAmount) };

    if (state.canWrite === false) {
      openHelp();
      toast("Сохранение появится после настройки доступа", "info");
      return;
    }

    state.submitting = true;
    const btn = $("#submitBtn");
    const label = btn.querySelector("span");
    btn.disabled = true;
    label.textContent = "Сохраняем…";

    state.records.push({ id: payload.id, date: vDate, firstName: vFirst, lastName: vLast, plate: plate, amount: payload.amount });
    saveCache();
    renderAll();
    setView("home");

    try {
      await scriptPost(payload);
      toast(vFirst + " " + vLast + ": аванс " + fmtMoney(payload.amount) + " выдан", "success");
      confetti();
      first.value = "";
      last.value = "";
      $("#fPlate").value = "";
      amountEl.value = "";
      $("#nameHint").classList.add("hidden");
      dateEl.value = todayISO();
      refresh();
    } catch (err) {
      state.records = state.records.filter((r) => r.id !== payload.id);
      saveCache();
      renderAll();
      setView("add");
      toast("Не удалось сохранить: " + friendlyErr(err), "error");
      if (!state.helpShownOnce) { state.helpShownOnce = true; openHelp(); }
    } finally {
      state.submitting = false;
      btn.disabled = false;
      label.textContent = "Выдать аванс";
    }
  });

  $("#exportBtn").onclick = exportCsv;

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.auth.code && state.lastSync && Date.now() - state.lastSync > 60000) refresh();
  });
  window.addEventListener("online", () => { if (state.auth.code) refresh(); });
}

/* ---------- Инициализация ---------- */
(function init() {
  restoreUi();
  syncChips();

  const storedTheme = localStorage.getItem(LS.theme);
  const sysDark = matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(storedTheme || (sysDark ? "dark" : "light"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem(LS.theme)) applyTheme(e.matches ? "dark" : "light");
  });

  $("#fDate").value = todayISO();

  bind();
  initInstall();
  initPtr();
  initSw();

  const hadAuth = loadAuth();
  if (!hadAuth) {
    state.source = "loading";
    renderAll();
    showLock();
  } else {
    const had = loadCache();
    state.source = had ? "cache" : "loading";
    renderAll();
    refresh();
  }
})();
