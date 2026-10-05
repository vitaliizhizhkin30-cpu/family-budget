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
  rates: {},        // курсы ЦБ: сколько RUB за 1 единицу валюты
  ratesDate: null,
  ratesStale: false,
  markup: 3,        // спред обмена, %
  planned: [],      // открытые пункты плана (planned / invoiced)
  plEditId: null,
  plKind: 'income',
  doneItem: null,
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
  const [bal, acc, cat, tx, pl] = await Promise.all([
    sb.from('account_balances').select('account_id, balance'),
    sb.from('accounts').select('id, name, type, bank, currency, owner_id, archived, created_at').eq('archived', false).order('created_at'),
    sb.from('categories').select('id, name, kind, is_fixed').eq('archived', false).order('name'),
    sb.from('transactions').select('id, kind, account_id, amount, category_id, to_account_id, to_amount, tx_date, note, created_by, created_at')
      .order('tx_date', { ascending: false }).order('created_at', { ascending: false }).limit(200),
    sb.from('planned_items').select('id, kind, title, amount, currency, category_id, due_date, status, recurrence, note')
      .in('status', ['planned', 'invoiced']).order('due_date'),
  ]);
  for (const r of [bal, acc, cat, tx, pl]) if (r.error) throw r.error;
  const balMap = new Map(bal.data.map((b) => [b.account_id, Number(b.balance)]));
  state.accounts = acc.data.map((a) => ({ ...a, balance: balMap.get(a.id) ?? 0 }));
  state.categories = cat.data;
  state.txs = tx.data.map((t) => ({ ...t, amount: Number(t.amount), to_amount: t.to_amount == null ? null : Number(t.to_amount) }));
  state.planned = pl.data.map((p) => ({ ...p, amount: Number(p.amount) }));
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
  renderPlan();
  renderForecast();
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
    if (t.kind === 'transfer') {
      const b = acc.get(t.to_account_id);
      const sub = [fmtDate(t.tx_date), memberName(t.created_by), t.note].filter(Boolean).map(esc).join(' · ');
      const amt = a?.currency === b?.currency
        ? money(t.amount, a?.currency ?? 'RUB')
        : `${money(t.amount, a?.currency ?? 'RUB')} → ${money(t.to_amount, b?.currency ?? 'RUB')}`;
      return `
    <div class="item">
      <div class="main">
        <div class="title">Перевод: ${esc(a?.name ?? '?')} → ${esc(b?.name ?? '?')}</div>
        <div class="sub">${sub}</div>
      </div>
      <div class="amount transfer">${esc(amt)}</div>
      <button class="del" data-del="${esc(t.id)}" title="Удалить" aria-label="Удалить операцию">✕</button>
    </div>`;
    }
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
  for (const name of ['overview', 'plan', 'forecast', 'ops']) $('#tab-' + name).hidden = b.dataset.tab !== name;
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

const accById = (id) => state.accounts.find((a) => a.id === id);

// Подсказка о курсе при переводе между счетами в разных валютах
function updateRateHint() {
  const f = $('#tx-form');
  const hint = $('#tx-rate-hint');
  hint.hidden = true;
  if (state.txKind !== 'transfer') return;
  const a = accById(f.account.value), b = accById(f.to_account.value);
  const out = parseAmount(f.amount.value), inn = parseAmount(f.to_amount.value);
  if (!a || !b || a.currency === b.currency || !(out > 0) || !(inn > 0)) return;
  hint.textContent = `Курс обмена: 1 ${a.currency} = ${(inn / out).toLocaleString('ru-RU', { maximumFractionDigits: 4 })} ${b.currency}`;
  hint.hidden = false;
}

function applyKindUI() {
  const t = state.txKind === 'transfer';
  document.querySelectorAll('#tx-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === state.txKind));
  $('#tx-to-wrap').hidden = !t;
  $('#tx-cat-wrap').hidden = t;
  $('#tx-acc-lbl').textContent = t ? 'Со счёта' : 'Счёт';
  $('#tx-amount-lbl').textContent = t ? 'Сумма списания (в валюте счёта-отправителя)' : 'Сумма';
  syncToAmountVisibility();
  if (!t) fillCategories();
  updateRateHint();
}

// Поле «сумма зачисления» нужно только если валюты счетов разные
function syncToAmountVisibility() {
  const f = $('#tx-form');
  const a = accById(f.account.value), b = accById(f.to_account.value);
  const cross = state.txKind === 'transfer' && a && b && a.currency !== b.currency;
  $('#tx-toamt-wrap').hidden = !cross;
}

$('#tx-kind').addEventListener('click', (e) => {
  const kind = e.target.dataset?.kind;
  if (!kind) return;
  state.txKind = kind;
  applyKindUI();
});
['account', 'to_account'].forEach((n) => $('#tx-form [name=' + n + ']').addEventListener('change', () => { syncToAmountVisibility(); updateRateHint(); }));
['amount', 'to_amount'].forEach((n) => $('#tx-form [name=' + n + ']').addEventListener('input', updateRateHint));

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
  f.to_account.innerHTML = f.account.innerHTML;
  f.to_account.value = (state.accounts.find((a) => a.id !== f.account.value) ?? state.accounts[0]).id;
  applyKindUI();
  $('#tx-error').textContent = '';
  $('#tx-dialog').showModal();
  f.amount.focus();
});

$('#tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const amount = parseAmount(f.amount.value);
  if (!(amount > 0)) { $('#tx-error').textContent = 'Введи сумму больше нуля.'; return; }
  const row = {
    household_id: state.householdId,
    kind: state.txKind,
    account_id: f.account.value,
    amount,
    category_id: f.category.value || null,
    tx_date: f.date.value,
    note: f.note.value.trim() || null,
  };
  if (state.txKind === 'transfer') {
    const a = accById(f.account.value), b = accById(f.to_account.value);
    if (!b || a.id === b.id) { $('#tx-error').textContent = 'Выбери два разных счёта.'; return; }
    let toAmount = amount;
    if (a.currency !== b.currency) {
      toAmount = parseAmount(f.to_amount.value);
      if (!(toAmount > 0)) { $('#tx-error').textContent = `Введи, сколько в итоге пришло на счёт (${b.currency}).`; return; }
    }
    row.category_id = null;
    row.to_account_id = b.id;
    row.to_amount = toAmount;
  }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  const { error } = await sb.from('transactions').insert(row);
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

// ---------- план ----------
const RECUR = { none: '', weekly: 'каждую неделю', monthly: 'каждый месяц', yearly: 'каждый год' };

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (m - 1) + n;
  const ty = y + Math.floor(total / 12);
  const tm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
function nextDue(iso, rec) {
  if (rec === 'weekly') return addDays(iso, 7);
  if (rec === 'monthly') return addMonths(iso, 1);
  if (rec === 'yearly') return addMonths(iso, 12);
  return null;
}

function nthDue(iso, rec, k) {
  if (rec === 'weekly') return addDays(iso, 7 * k);
  if (rec === 'monthly') return addMonths(iso, k);
  if (rec === 'yearly') return addMonths(iso, 12 * k);
  return null;
}

function planRow(p, today) {
  const overdue = p.due_date < today;
  const cat = state.categories.find((c) => c.id === p.category_id)?.name;
  const sub = [fmtDate(p.due_date), cat, RECUR[p.recurrence], p.note].filter(Boolean).map(esc).join(' · ');
  const badges = [
    overdue ? '<span class="badge warn">просрочено</span>' : '',
    p.status === 'invoiced' ? '<span class="badge info">счёт выставлен</span>' : '',
  ].join(' ');
  const sign = p.kind === 'income' ? '+' : '−';
  return `
    <div class="item clickable ${overdue ? 'overdue' : ''}" data-plan="${esc(p.id)}">
      <div class="main">
        <div class="title">${esc(p.title)} ${badges}</div>
        <div class="sub">${sub}</div>
      </div>
      <div class="amount ${esc(p.kind)}">${sign}${esc(money(p.amount, p.currency))}</div>
      <button class="done-btn" data-done="${esc(p.id)}">${p.kind === 'income' ? 'Получено' : 'Оплачено'}</button>
    </div>`;
}

function renderPlan() {
  const today = todayLocal();
  const horizon = addDays(today, 30);

  // итоги на 30 дней (включая просроченное) по валютам
  const by = new Map();
  for (const p of state.planned) {
    if (p.due_date > horizon) continue;
    const r = by.get(p.currency) ?? { income: 0, expense: 0 };
    r[p.kind] += p.amount;
    by.set(p.currency, r);
  }
  $('#plan-totals').innerHTML = [...by].map(([cur, r]) => `
    <div class="total">
      <div class="cur">Ближайшие 30 дней, ${esc(cur)}</div>
      ${r.income ? `<div class="sub2 income">+${esc(money(r.income, cur))}</div>` : ''}
      ${r.expense ? `<div class="sub2 expense">−${esc(money(r.expense, cur))}</div>` : ''}
    </div>`).join('');

  const box = $('#plan-list');
  if (!state.planned.length) {
    box.innerHTML = '<div class="empty">В плане пока пусто. Добавь ожидаемую оплату от клиента или регулярный платёж.</div>';
    return;
  }
  const late = state.planned.filter((p) => p.due_date < today);
  const soon = state.planned.filter((p) => p.due_date >= today && p.due_date <= horizon);
  const later = state.planned.filter((p) => p.due_date > horizon);
  const group = (label, arr) => (arr.length ? `<div class="group-label">${label}</div>` + arr.map((p) => planRow(p, today)).join('') : '');
  box.innerHTML = group('Просрочено', late) + group('Ближайшие 30 дней', soon) + group('Позже', later);
}

function fillPlanCategories(selected) {
  const opts = state.categories.filter((c) => c.kind === state.plKind);
  $('#pl-form [name=category]').innerHTML = '<option value="">— без категории —</option>'
    + opts.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
}

$('#pl-kind').addEventListener('click', (e) => {
  const kind = e.target.dataset?.kind;
  if (!kind) return;
  state.plKind = kind;
  document.querySelectorAll('#pl-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  fillPlanCategories();
});

function openPlanDialog(item) {
  const f = $('#pl-form');
  f.reset();
  state.plEditId = item?.id ?? null;
  state.plKind = item?.kind ?? 'income';
  document.querySelectorAll('#pl-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === state.plKind));
  $('#pl-title').textContent = item ? 'Редактировать пункт' : 'В план';
  $('#pl-delete').hidden = !item;
  $('#pl-error').textContent = '';
  fillPlanCategories(item?.category_id);
  f.due.value = item?.due_date ?? todayLocal();
  if (item) {
    f.title.value = item.title;
    f.amount.value = String(item.amount).replace('.', ',');
    f.currency.value = item.currency;
    f.recurrence.value = item.recurrence;
    f.status.value = item.status;
    f.note.value = item.note ?? '';
  } else if (state.accounts[0]) {
    f.currency.value = state.accounts[0].currency;
  }
  $('#pl-dialog').showModal();
  f.title.focus();
}

$('#add-plan-btn').addEventListener('click', () => openPlanDialog(null));

$('#pl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const amount = parseAmount(f.amount.value);
  if (!(amount > 0)) { $('#pl-error').textContent = 'Введи сумму больше нуля.'; return; }
  const currency = f.currency.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(currency)) { $('#pl-error').textContent = 'Код валюты: 2–8 латинских букв или цифр, например USD.'; return; }
  const row = {
    kind: state.plKind,
    title: f.title.value.trim(),
    amount,
    currency,
    category_id: f.category.value || null,
    due_date: f.due.value,
    recurrence: f.recurrence.value,
    status: f.status.value,
    note: f.note.value.trim() || null,
  };
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  const q = state.plEditId
    ? sb.from('planned_items').update(row).eq('id', state.plEditId)
    : sb.from('planned_items').insert({ ...row, household_id: state.householdId });
  const { error } = await q;
  btn.disabled = false;
  if (error) { $('#pl-error').textContent = 'Не удалось сохранить: ' + error.message; return; }
  $('#pl-dialog').close();
  toast('Сохранено');
  refresh();
});

$('#pl-delete').addEventListener('click', async () => {
  if (!state.plEditId || !confirm('Удалить этот пункт из плана?')) return;
  const { error } = await sb.from('planned_items').delete().eq('id', state.plEditId);
  if (error) { $('#pl-error').textContent = 'Не удалось удалить: ' + error.message; return; }
  $('#pl-dialog').close();
  toast('Удалено');
  refresh();
});

// «Получено / Оплачено»: создаём настоящую операцию и закрываем пункт плана
function openDoneDialog(item) {
  state.doneItem = item;
  const f = $('#done-form');
  f.reset();
  $('#done-title').textContent = `${item.kind === 'income' ? 'Получено' : 'Оплачено'}: ${item.title}`;
  f.amount.value = String(item.amount).replace('.', ',');
  f.date.value = todayLocal();
  const accs = state.accounts.filter((a) => a.currency === item.currency);
  f.account.innerHTML = accs.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.currency)} (${esc(memberName(a.owner_id))})</option>`).join('');
  $('#done-error').textContent = accs.length ? '' : `Нет счёта в валюте ${item.currency}. Сначала добавь такой счёт.`;
  f.querySelector('button[type=submit]').disabled = !accs.length;
  if (accs.length) {
    let last = null;
    try { last = localStorage.getItem('lastAccount'); } catch { /* ignore */ }
    if (last && accs.some((a) => a.id === last)) f.account.value = last;
  }
  $('#done-dialog').showModal();
}

$('#done-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const item = state.doneItem;
  const amount = parseAmount(f.amount.value);
  if (!(amount > 0)) { $('#done-error').textContent = 'Введи сумму больше нуля.'; return; }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;

  const ins = await sb.from('transactions').insert({
    household_id: state.householdId,
    kind: item.kind,
    account_id: f.account.value,
    amount,
    category_id: item.category_id,
    tx_date: f.date.value,
    note: [item.title, item.note].filter(Boolean).join(' — '),
  }).select('id').single();
  if (ins.error) { btn.disabled = false; $('#done-error').textContent = 'Не удалось записать: ' + ins.error.message; return; }

  const upd = await sb.from('planned_items').update({ status: 'done', transaction_id: ins.data.id }).eq('id', item.id);
  if (upd.error) {
    btn.disabled = false;
    $('#done-error').textContent = 'Операция записана, но пункт плана не закрылся: ' + upd.error.message + ' Закрой его вручную, чтобы не записать дважды.';
    refresh();
    return;
  }

  const nd = nextDue(item.due_date, item.recurrence);
  if (nd) {
    const nx = await sb.from('planned_items').insert({
      household_id: state.householdId, kind: item.kind, title: item.title, amount: item.amount,
      currency: item.currency, category_id: item.category_id, due_date: nd, recurrence: item.recurrence, note: item.note,
    });
    if (nx.error) toast('Следующий повтор не создался: ' + nx.error.message);
  }
  btn.disabled = false;
  try { localStorage.setItem('lastAccount', f.account.value); } catch { /* ignore */ }
  $('#done-dialog').close();
  toast(nd ? `Записано. Следующий — ${fmtDate(nd)}` : 'Записано');
  refresh();
});

document.addEventListener('click', (e) => {
  const doneId = e.target.closest?.('[data-done]')?.dataset.done;
  if (doneId) { const it = state.planned.find((p) => p.id === doneId); if (it) openDoneDialog(it); return; }
  const planId = e.target.closest?.('[data-plan]')?.dataset.plan;
  if (planId) { const it = state.planned.find((p) => p.id === planId); if (it) openPlanDialog(it); }
});

// ---------- курсы ЦБ ----------
const BASE = 'RUB';
const RATES_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
const round2 = (n) => Math.round(n * 100) / 100;
const rateOf = (cur) => (cur === BASE ? 1 : state.rates[cur] ?? null);

function loadCachedRates() {
  try {
    const c = JSON.parse(localStorage.getItem('cbrRates'));
    if (c?.rates) { state.rates = c.rates; state.ratesDate = c.date; }
  } catch { /* нет кэша */ }
}

async function fetchRates() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(RATES_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const rates = {};
    for (const v of Object.values(d.Valute)) rates[v.CharCode] = v.Value / v.Nominal;
    state.rates = rates;
    state.ratesDate = String(d.Date).slice(0, 10);
    state.ratesStale = false;
    try { localStorage.setItem('cbrRates', JSON.stringify({ rates, date: state.ratesDate })); } catch { /* ignore */ }
  } catch (err) {
    console.warn('Курсы ЦБ не загружены:', err);
    state.ratesStale = true;
  }
  renderForecast();
}

// ---------- прогноз ----------
function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// События плана по одной валюте на период [today, end]. Повторяющиеся пункты разворачиваются.
// Просроченный пункт считаем ожидаемым «сегодня».
function planEvents(cur, today, end) {
  const out = [];
  for (const p of state.planned) {
    if (p.currency !== cur) continue;
    const delta = p.kind === 'income' ? p.amount : -p.amount;
    const first = p.due_date < today ? today : p.due_date;
    if (first <= end) out.push({ date: first, delta, title: p.title });
    // k-е повторение считаем от исходной даты, чтобы «31-е» не залипало на 30-м
    for (let k = 1; k < 400; k++) {
      const d = nthDue(p.due_date, p.recurrence, k);
      if (!d || d > end) break;
      if (d >= today) out.push({ date: d, delta, title: p.title });
    }
  }
  return out;
}

const sortEvents = (arr) => arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.delta - a.delta));

function runSeries(start, events, today) {
  sortEvents(events);
  let bal = start;
  const series = [{ date: today, bal }];
  let min = { bal, date: today };
  let firstNeg = bal < 0 ? today : null;
  for (const ev of events) {
    bal = round2(bal + ev.delta);
    ev.bal = bal;
    series.push({ date: ev.date, bal });
    if (bal < min.bal) min = { bal, date: ev.date };
    if (bal < 0 && !firstNeg) firstNeg = ev.date;
  }
  return { start, end: bal, events, series, min, firstNeg };
}

const balanceIn = (cur) => state.accounts.filter((a) => a.currency === cur).reduce((s, a) => s + a.balance, 0);

function buildForecast(cur, today, end) {
  return runSeries(round2(balanceIn(cur)), planEvents(cur, today, end), today);
}

// Общий прогноз в базовой валюте по текущим курсам ЦБ
function buildTotal(currencies, today, end) {
  let start = 0;
  const events = [];
  const skipped = [];
  for (const cur of currencies) {
    const r = rateOf(cur);
    if (r == null) { skipped.push(cur); continue; }
    start += balanceIn(cur) * r;
    for (const ev of planEvents(cur, today, end)) {
      events.push({ date: ev.date, delta: round2(ev.delta * r), title: ev.title, orig: cur === BASE ? null : { delta: ev.delta, cur } });
    }
  }
  const fc = runSeries(round2(start), events, today);
  fc.skipped = skipped;
  return fc;
}

function forecastSvg(fc, today, end, idx) {
  const W = 600, H = 150, pad = 10;
  const span = Math.max(1, daysBetween(today, end));
  const vals = fc.series.map((p) => p.bal);
  const yMax = Math.max(0, ...vals), yMin = Math.min(0, ...vals);
  const range = yMax - yMin || 1;
  const x = (d) => pad + ((W - 2 * pad) * daysBetween(today, d)) / span;
  const y = (v) => pad + ((H - 2 * pad) * (yMax - v)) / range;
  let path = `M${x(today).toFixed(1)},${y(fc.series[0].bal).toFixed(1)}`;
  for (const p of fc.series.slice(1)) path += ` H${x(p.date).toFixed(1)} V${y(p.bal).toFixed(1)}`;
  path += ` H${(W - pad).toFixed(1)}`;
  const zero = y(0).toFixed(1);
  return `<svg class="fc-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="График прогноза остатка">
    <defs>
      <clipPath id="up${idx}"><rect x="0" y="0" width="${W}" height="${zero}"/></clipPath>
      <clipPath id="dn${idx}"><rect x="0" y="${zero}" width="${W}" height="${H}"/></clipPath>
    </defs>
    <line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" clip-path="url(#up${idx})"/>
    <path d="${path}" fill="none" stroke="var(--expense)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" clip-path="url(#dn${idx})"/>
  </svg>`;
}

function forecastCard({ title, fc, cur, idx, months, today, end, note = '' }) {
  const verdict = fc.firstNeg
    ? `<div class="fc-verdict bad">⚠ Остаток уходит в минус ${fc.firstNeg === today ? 'уже сейчас' : 'с ' + fmtDate(fc.firstNeg)}</div>`
    : '<div class="fc-verdict ok">✓ В минус не уходит</div>';
  const rows = fc.events.map((ev) => `
      <div class="fc-ev">
        <span class="d">${fmtDate(ev.date)}</span>
        <span>${esc(ev.title)}${ev.orig ? ` <span class="orig">(${ev.orig.delta > 0 ? '+' : '−'}${esc(money(Math.abs(ev.orig.delta), ev.orig.cur))})</span>` : ''}</span>
        <span class="amount ${ev.delta > 0 ? 'income' : 'expense'}">${ev.delta > 0 ? '+' : '−'}${esc(money(Math.abs(ev.delta), cur))}</span>
        <span class="bal ${ev.bal < 0 ? 'neg' : ''}">${esc(money(ev.bal, cur))}</span>
      </div>`).join('');
  return `
    <div class="fc-card">
      <h3>${esc(title)}</h3>
      ${verdict}${note}
      <div class="fc-stats">
        <div class="fc-stat"><div class="lbl">Сейчас</div><div class="val">${esc(money(fc.start, cur))}</div></div>
        <div class="fc-stat"><div class="lbl">Через ${months} мес.</div><div class="val">${esc(money(fc.end, cur))}</div></div>
        <div class="fc-stat"><div class="lbl">Минимум${fc.events.length ? ' (' + fmtDate(fc.min.date) + ')' : ''}</div><div class="val">${esc(money(fc.min.bal, cur))}</div></div>
      </div>
      ${forecastSvg(fc, today, end, idx)}
      <div class="fc-axis"><span>${fmtDate(today)}</span><span>${fmtDate(end)}</span></div>
      ${fc.events.length
        ? `<details><summary>События и остаток после каждого (${fc.events.length})</summary><div class="fc-events">${rows}</div></details>`
        : '<p class="hint">Плановых событий на период нет.</p>'}
    </div>`;
}

// Сколько нужно обменять на валюту, в которой по прогнозу не хватает денег
function exchangeCards(currencies, today, months) {
  const out = [];
  for (const cur of currencies) {
    const r = rateOf(cur);
    if (cur === BASE || r == null) continue;
    const fc = buildForecast(cur, today, addMonths(today, months));
    if (!(fc.min.bal < 0)) continue;
    const deficit = round2(-fc.min.bal);
    const byCbr = deficit * r;
    const withSpread = byCbr * (1 + state.markup / 100);
    out.push(`
    <div class="fc-card exchange">
      <h3>Нужно обменять в ${esc(cur)}</h3>
      <p>${fc.firstNeg === today ? 'Уже сейчас' : 'С ' + fmtDate(fc.firstNeg)} в ${esc(cur)} не хватает денег; максимальный дефицит на периоде — <strong>${esc(money(deficit, cur))}</strong>.</p>
      <p>Это около <strong>${esc(money(byCbr, BASE))}</strong> по курсу ЦБ (1 ${esc(cur)} = ${esc(money(r, BASE))}), с запасом на спред ${esc(String(state.markup))}% — около <strong>${esc(money(withSpread, BASE))}</strong>.</p>
      <p class="hint">Расчёт примерный: курс будущих дат неизвестен, а банк обменивает по своему курсу. Обменять можно частями — перед каждой нехваткой.</p>
    </div>`);
  }
  return out.join('');
}

function renderForecast() {
  const months = Number($('#fc-months').value) || 3;
  const today = todayLocal();
  const end = addMonths(today, months);
  const currencies = [...new Set([...state.accounts.map((a) => a.currency), ...state.planned.map((p) => p.currency)])].sort();
  const box = $('#forecast');

  // строка о курсах
  const info = $('#rates-info');
  if (currencies.every((c) => c === BASE)) info.textContent = '';
  else if (!state.ratesDate) info.textContent = state.ratesStale ? 'Курсы ЦБ не загрузились — общий прогноз недоступен.' : 'Загружаю курсы ЦБ…';
  else info.textContent = state.ratesStale
    ? `Не удалось обновить курсы, используются сохранённые на ${fmtDate(state.ratesDate)}.`
    : `Курсы ЦБ на ${fmtDate(state.ratesDate)}.`;

  if (!currencies.length) { box.innerHTML = '<div class="empty">Добавь счета и плановые пункты, чтобы увидеть прогноз.</div>'; return; }

  let html = '';
  const multi = currencies.some((c) => c !== BASE);
  if (multi) {
    const total = buildTotal(currencies, today, end);
    const note = total.skipped.length ? `<p class="hint">Не учтены (нет курса ЦБ): ${esc(total.skipped.join(', '))}.</p>` : '';
    html += forecastCard({ title: `Всего, в ${BASE} (по курсу ЦБ)`, fc: total, cur: BASE, idx: 'T', months, today, end, note });
    html += exchangeCards(currencies, today, months);
  }
  html += currencies.map((cur, i) => {
    const hasAccount = state.accounts.some((a) => a.currency === cur);
    const note = hasAccount ? '' : `<p class="hint">Счетов в ${esc(cur)} нет, прогноз считается от нуля.</p>`;
    return forecastCard({ title: multi ? `Только ${cur}` : cur, fc: buildForecast(cur, today, end), cur, idx: i, months, today, end, note });
  }).join('');
  box.innerHTML = html;
}

$('#fc-months').addEventListener('change', renderForecast);

$('#fc-markup').addEventListener('change', (e) => {
  const v = Number(String(e.target.value).replace(',', '.'));
  state.markup = Number.isFinite(v) && v >= 0 && v <= 30 ? v : 3;
  e.target.value = state.markup;
  try { localStorage.setItem('markup', String(state.markup)); } catch { /* ignore */ }
  renderForecast();
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
try {
  const m = Number(localStorage.getItem('markup'));
  if (localStorage.getItem('markup') !== null && Number.isFinite(m) && m >= 0 && m <= 30) state.markup = m;
} catch { /* ignore */ }
$('#fc-markup').value = state.markup;
loadCachedRates();
fetchRates();
sb.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
sb.auth.getSession().then(({ data }) => { if (!data.session) showLogin(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
