'use strict';

const sb = window.supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_KEY);
const $ = (s, r = document) => r.querySelector(s);

const state = {
  user: null,
  householdId: null,
  members: [],      // {user_id, display_name}
  accounts: [],     // с полем balance
  categories: [],
  txs: [],
  txLimit: 30,
  txKind: 'expense',
};

// ---------- утилиты ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtCache = {};
function money(value, cur) {
  try {
    fmtCache[cur] ??= new Intl.NumberFormat('ru-RU', { style: 'currency', currency: cur });
    return fmtCache[cur].format(value);
  } catch {
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + ' ' + cur;
  }
}

function parseAmount(raw) {
  const n = Number(String(raw).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function todayLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

const memberName = (id) => state.members.find((m) => m.user_id === id)?.display_name ?? '—';

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- тема ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-btn').textContent = theme === 'dark' ? '☀' : '☾';
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#14161a' : '#f4f5f7';
}
function initTheme() {
  let theme = 'dark';
  try { theme = localStorage.getItem('theme') || 'dark'; } catch { /* приватный режим */ }
  applyTheme(theme);
  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('theme', next); } catch { /* ignore */ }
  });
}

// ---------- вход ----------
function showLogin() {
  $('#view-app').hidden = true;
  $('#view-login').hidden = false;
}
function showApp() {
  $('#view-login').hidden = true;
  $('#view-app').hidden = false;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  $('#login-error').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
  btn.disabled = false;
  if (error) $('#login-error').textContent = 'Не удалось войти: проверь email и пароль.';
});

$('#logout-btn').addEventListener('click', () => sb.auth.signOut());

// ---------- данные ----------
async function loadContext() {
  const { data, error } = await sb.from('members').select('user_id, household_id, display_name');
  if (error) throw error;
  state.members = data;
  const me = data.find((m) => m.user_id === state.user.id);
  if (!me) throw new Error('Аккаунт не привязан к семье (см. 02_seed.sql).');
  state.householdId = me.household_id;
}

async function loadData() {
  const [bal, acc, cat, tx] = await Promise.all([
    sb.from('account_balances').select('account_id, balance'),
    sb.from('accounts').select('id, name, type, bank, currency, owner_id, archived, created_at').eq('archived', false).order('created_at'),
    sb.from('categories').select('id, name, kind, is_fixed').eq('archived', false).order('name'),
    sb.from('transactions').select('id, kind, account_id, amount, category_id, tx_date, note, created_by, created_at')
      .order('tx_date', { ascending: false }).order('created_at', { ascending: false }).limit(200),
  ]);
  for (const r of [bal, acc, cat, tx]) if (r.error) throw r.error;
  const balMap = new Map(bal.data.map((b) => [b.account_id, Number(b.balance)]));
  state.accounts = acc.data.map((a) => ({ ...a, balance: balMap.get(a.id) ?? 0 }));
  state.categories = cat.data;
  state.txs = tx.data.map((t) => ({ ...t, amount: Number(t.amount) }));
}

async function refresh() {
  try {
    await loadData();
    render();
  } catch (err) {
    console.error(err);
    toast('Ошибка загрузки: ' + (err.message || err));
  }
}

// ---------- отрисовка ----------
function render() {
  renderTotals();
  renderAccounts();
  renderTxList($('#recent'), state.txs.slice(0, 5));
  renderTxList($('#ops'), state.txs.slice(0, state.txLimit));
  $('#more-ops').hidden = state.txs.length <= state.txLimit;
}

function renderTotals() {
  const sums = new Map();
  for (const a of state.accounts) sums.set(a.currency, (sums.get(a.currency) ?? 0) + a.balance);
  const box = $('#totals');
  if (!sums.size) { box.innerHTML = ''; return; }
  box.innerHTML = [...sums].map(([cur, sum]) =>
    `<div class="total"><div class="cur">Всего, ${esc(cur)}</div><div class="sum">${esc(money(sum, cur))}</div></div>`).join('');
}

function renderAccounts() {
  const box = $('#accounts');
  if (!state.accounts.length) {
    box.innerHTML = '<div class="empty">Счетов пока нет. Добавь первый кнопкой «+ Счёт».</div>';
    return;
  }
  box.innerHTML = state.accounts.map((a) => `
    <div class="item">
      <div class="main">
        <div class="title">${esc(a.name)}</div>
        <div class="sub">${esc(memberName(a.owner_id))} · ${esc(a.currency)}${a.bank ? ' · ' + esc(a.bank) : ''}</div>
      </div>
      <div class="amount">${esc(money(a.balance, a.currency))}</div>
    </div>`).join('');
}

function renderTxList(box, list) {
  if (!list.length) { box.innerHTML = '<div class="empty">Операций пока нет.</div>'; return; }
  const acc = new Map(state.accounts.map((a) => [a.id, a]));
  const cat = new Map(state.categories.map((c) => [c.id, c]));
  box.innerHTML = list.map((t) => {
    const a = acc.get(t.account_id);
    const sign = t.kind === 'income' ? '+' : '−';
    const title = cat.get(t.category_id)?.name ?? (t.kind === 'income' ? 'Доход' : 'Расход');
    const sub = [fmtDate(t.tx_date), a?.name, memberName(t.created_by), t.note].filter(Boolean).map(esc).join(' · ');
    return `
    <div class="item">
      <div class="main">
        <div class="title">${esc(title)}</div>
        <div class="sub">${sub}</div>
      </div>
      <div class="amount ${esc(t.kind)}">${sign}${esc(money(t.amount, a?.currency ?? 'RUB'))}</div>
      <button class="del" data-del="${esc(t.id)}" title="Удалить" aria-label="Удалить операцию">✕</button>
    </div>`;
  }).join('');
}

// ---------- вкладки ----------
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $('#tab-overview').hidden = b.dataset.tab !== 'overview';
  $('#tab-ops').hidden = b.dataset.tab !== 'ops';
}));
$('#more-ops').addEventListener('click', () => { state.txLimit += 30; render(); });

document.addEventListener('click', async (e) => {
  const id = e.target.closest?.('[data-del]')?.dataset.del;
  if (!id) return;
  if (!confirm('Удалить эту операцию? Остаток счёта пересчитается.')) return;
  const { error } = await sb.from('transactions').delete().eq('id', id);
  if (error) return toast('Не удалось удалить: ' + error.message);
  toast('Операция удалена');
  refresh();
});

// ---------- диалоги ----------
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

// Операция
function fillCategories() {
  const sel = $('#tx-form [name=category]');
  const opts = state.categories.filter((c) => c.kind === state.txKind);
  sel.innerHTML = '<option value="">— без категории —</option>' + opts.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
}

$('#tx-kind').addEventListener('click', (e) => {
  const kind = e.target.dataset?.kind;
  if (!kind) return;
  state.txKind = kind;
  document.querySelectorAll('#tx-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  fillCategories();
});

$('#add-tx-btn').addEventListener('click', () => {
  if (!state.accounts.length) { toast('Сначала добавь счёт'); return; }
  const f = $('#tx-form');
  f.reset();
  f.date.value = todayLocal();
  f.account.innerHTML = state.accounts.map((a) =>
    `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.currency)} (${esc(memberName(a.owner_id))})</option>`).join('');
  let last = null;
  try { last = localStorage.getItem('lastAccount'); } catch { /* ignore */ }
  if (last && state.accounts.some((a) => a.id === last)) f.account.value = last;
  fillCategories();
  $('#tx-error').textContent = '';
  $('#tx-dialog').showModal();
  f.amount.focus();
});

$('#tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const amount = parseAmount(f.amount.value);
  if (!(amount > 0)) { $('#tx-error').textContent = 'Введи сумму больше нуля.'; return; }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  const { error } = await sb.from('transactions').insert({
    household_id: state.householdId,
    kind: state.txKind,
    account_id: f.account.value,
    amount,
    category_id: f.category.value || null,
    tx_date: f.date.value,
    note: f.note.value.trim() || null,
  });
  btn.disabled = false;
  if (error) { $('#tx-error').textContent = 'Не удалось сохранить: ' + error.message; return; }
  try { localStorage.setItem('lastAccount', f.account.value); } catch { /* ignore */ }
  $('#tx-dialog').close();
  toast('Сохранено');
  refresh();
});

// Счёт
$('#add-account-btn').addEventListener('click', () => {
  $('#acc-form').reset();
  $('#acc-error').textContent = '';
  $('#acc-dialog').showModal();
  $('#acc-form').name.focus();
});

$('#acc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const currency = f.currency.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(currency)) { $('#acc-error').textContent = 'Код валюты: 2–8 латинских букв или цифр, например USD.'; return; }
  const balance = parseAmount(f.balance.value || '0');
  if (Number.isNaN(balance)) { $('#acc-error').textContent = 'Остаток должен быть числом.'; return; }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  const { error } = await sb.from('accounts').insert({
    household_id: state.householdId,
    owner_id: state.user.id,
    name: f.name.value.trim(),
    type: f.type.value,
    bank: f.bank.value.trim() || null,
    currency,
    opening_balance: balance,
  });
  btn.disabled = false;
  if (error) { $('#acc-error').textContent = 'Не удалось создать: ' + error.message; return; }
  $('#acc-dialog').close();
  toast('Счёт добавлен');
  refresh();
});

// ---------- запуск ----------
async function onSession(session) {
  if (!session) { state.user = null; showLogin(); return; }
  if (state.user?.id === session.user.id) return; // обновление токена — перезагружать не нужно
  state.user = session.user;
  showApp();
  try {
    await loadContext();
    await refresh();
  } catch (err) {
    console.error(err);
    toast('Ошибка: ' + (err.message || err));
  }
}

initTheme();
sb.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
sb.auth.getSession().then(({ data }) => { if (!data.session) showLogin(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
