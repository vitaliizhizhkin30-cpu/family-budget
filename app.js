'use strict';

const sb = window.supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_KEY);
const $ = (s, r = document) => r.querySelector(s);

const state = {
  user: null,
  householdId: null,
  members: [],      // {user_id, display_name}
  accounts: [],     // активные счета, с полем balance
  allAccounts: [],  // вместе с архивными (для отображения старых операций)
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
    sb.from('accounts').select('id, name, type, bank, currency, owner_id, archived, created_at').order('created_at'),
    sb.from('categories').select('id, name, kind, is_fixed').eq('archived', false).order('name'),
    sb.from('transactions').select('id, kind, account_id, amount, category_id, to_account_id, to_amount, tx_date, note, created_by, created_at')
      .order('tx_date', { ascending: false }).order('created_at', { ascending: false }).limit(200),
    sb.from('planned_items').select('id, kind, title, amount, currency, category_id, due_date, status, recurrence, note')
      .in('status', ['planned', 'invoiced']).order('due_date'),
  ]);
  for (const r of [bal, acc, cat, tx, pl]) if (r.error) throw r.error;
  const balMap = new Map(bal.data.map((b) => [b.account_id, Number(b.balance)]));
  state.allAccounts = acc.data.map((a) => ({ ...a, balance: balMap.get(a.id) ?? 0 }));
  state.accounts = state.allAccounts.filter((a) => !a.archived);   // активные: для итогов, ввода, прогноза
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
  renderArchived();
  updateBackupHint();
  renderForecast();
  renderTxList($('#recent'), state.txs.slice(0, 5));
  renderTxList($('#ops'), state.txs.slice(0, state.txLimit));
  $('#more-ops').hidden = state.txs.length <= state.txLimit;
}

// Сводка по счетам: Map валюта -> сумма
function sumByCurrency(accs) {
  const m = new Map();
  for (const a of accs) m.set(a.currency, round2((m.get(a.currency) ?? 0) + a.balance));
  return m;
}

// Карточка с остатком: общий итог в RUB по курсу ЦБ (если есть другие валюты) и разбивка по валютам
function balanceCard(title, accs, extraClass = '') {
  const m = sumByCurrency(accs);
  if (!m.size) {
    return `<div class="total ${extraClass}"><div class="cur">${esc(title)}</div><div class="sub2 muted">Счетов пока нет</div></div>`;
  }
  const entries = [...m];
  const foreign = entries.some(([c]) => c !== BASE);
  let main, label, note = '';
  if (foreign) {
    const known = entries.filter(([c]) => rateOf(c) != null);
    const missing = entries.filter(([c]) => rateOf(c) == null).map(([c]) => c);
    const sum = known.reduce((s, [c, v]) => s + v * rateOf(c), 0);
    main = known.length ? '≈ ' + money(sum, BASE) : '—';
    label = `${title}, в ${BASE} по курсу ЦБ`;
    if (missing.length) note = `<div class="sub2 muted">${state.ratesDate ? 'Нет курса ЦБ: ' + esc(missing.join(', ')) : 'Курсы загружаются…'}</div>`;
  } else {
    main = money(entries[0][1], BASE);
    label = title;
  }
  const lines = (foreign || entries.length > 1)
    ? entries.map(([c, v]) => `<div class="sub2">${esc(money(v, c))}</div>`).join('')
    : '';
  return `<div class="total ${extraClass}"><div class="cur">${esc(label)}</div><div class="sum">${esc(main)}</div>${lines}${note}</div>`;
}

// Участники: сначала текущий пользователь
function orderedMembers() {
  return [...state.members].sort((a, b) => (b.user_id === state.user?.id) - (a.user_id === state.user?.id));
}

function renderTotals() {
  const box = $('#totals');
  if (!state.accounts.length) { box.innerHTML = ''; return; }
  const family = balanceCard('Семья — общий бюджет', state.accounts, 'family');
  const persons = orderedMembers().map((m) => balanceCard(m.display_name, state.accounts.filter((a) => a.owner_id === m.user_id))).join('');
  box.innerHTML = family + persons;
}

function accountRow(a) {
  const sub = [a.type === 'cash' ? 'наличные' : a.type === 'card' ? 'карта' : '', a.currency, a.bank].filter(Boolean).map(esc).join(' · ');
  return `
    <div class="item clickable" data-acc="${esc(a.id)}">
      <div class="main">
        <div class="title">${esc(a.name)}</div>
        <div class="sub">${sub}</div>
      </div>
      <div class="amount">${esc(money(a.balance, a.currency))}</div>
    </div>`;
}

function renderAccounts() {
  const box = $('#accounts');
  if (!state.accounts.length) {
    box.innerHTML = '<div class="empty">Счетов пока нет. Добавь первый кнопкой «+ Счёт».</div>';
    return;
  }
  const known = new Set(state.members.map((m) => m.user_id));
  const groups = orderedMembers().map((m) => ({ name: m.display_name, accs: state.accounts.filter((a) => a.owner_id === m.user_id) }));
  const rest = state.accounts.filter((a) => !known.has(a.owner_id));
  if (rest.length) groups.push({ name: 'Без владельца', accs: rest });
  box.innerHTML = groups.filter((g) => g.accs.length)
    .map((g) => `<div class="group-label">${esc(g.name)}</div>` + g.accs.map(accountRow).join('')).join('');
}

function renderTxList(box, list) {
  if (!list.length) { box.innerHTML = '<div class="empty">Операций пока нет.</div>'; return; }
  const acc = new Map(state.allAccounts.map((a) => [a.id, a]));
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
  renderTotals();
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

// ---------- правка и архив счетов ----------
state.editAccId = null;

function renderArchived() {
  const arch = state.allAccounts.filter((a) => a.archived);
  $('#archived-box').hidden = !arch.length;
  $('#archived').innerHTML = arch.map((a) => `
    <div class="item archived-item">
      <div class="main">
        <div class="title">${esc(a.name)}</div>
        <div class="sub">${esc(memberName(a.owner_id))} · ${esc(a.currency)}</div>
      </div>
      <div class="amount">${esc(money(a.balance, a.currency))}</div>
      <button class="done-btn" data-restore="${esc(a.id)}">Вернуть</button>
    </div>`).join('');
}

function openAccEdit(a) {
  state.editAccId = a.id;
  const f = $('#accedit-form');
  f.reset();
  f.name.value = a.name;
  f.type.value = a.type;
  f.bank.value = a.bank ?? '';
  $('#accedit-cur').textContent = `Валюта: ${a.currency} (менять нельзя). Остаток в приложении: ${money(a.balance, a.currency)}.`;
  $('#accedit-error').textContent = '';
  $('#accedit-dialog').showModal();
}

$('#accedit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const a = state.allAccounts.find((x) => x.id === state.editAccId);
  if (!a) return;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  const err = (msg) => { btn.disabled = false; $('#accedit-error').textContent = msg; };

  const upd = await sb.from('accounts').update({
    name: f.name.value.trim(), type: f.type.value, bank: f.bank.value.trim() || null,
  }).eq('id', a.id);
  if (upd.error) return err('Не удалось сохранить: ' + upd.error.message);

  const raw = f.actual.value.trim();
  if (raw) {
    const actual = parseAmount(raw);
    if (Number.isNaN(actual)) return err('Фактическая сумма должна быть числом.');
    const diff = round2(actual - a.balance);
    if (diff !== 0) {
      const ins = await sb.from('transactions').insert({
        household_id: state.householdId,
        kind: diff > 0 ? 'income' : 'expense',
        account_id: a.id,
        amount: Math.abs(diff),
        tx_date: todayLocal(),
        note: 'Корректировка остатка',
      });
      if (ins.error) return err('Название сохранено, но корректировка не записалась: ' + ins.error.message);
    }
  }
  btn.disabled = false;
  $('#accedit-dialog').close();
  toast('Сохранено');
  refresh();
});

$('#accedit-archive').addEventListener('click', async () => {
  const a = state.allAccounts.find((x) => x.id === state.editAccId);
  if (!a) return;
  const warn = a.balance !== 0 ? ` На счёте ещё ${money(a.balance, a.currency)}, эти деньги пропадут из итогов и прогноза.` : '';
  if (!confirm(`Убрать счёт «${a.name}» в архив?${warn} Операции сохранятся, счёт можно вернуть.`)) return;
  const { error } = await sb.from('accounts').update({ archived: true }).eq('id', a.id);
  if (error) { $('#accedit-error').textContent = 'Не удалось: ' + error.message; return; }
  $('#accedit-dialog').close();
  toast('Счёт в архиве');
  refresh();
});

document.addEventListener('click', async (e) => {
  const restoreId = e.target.closest?.('[data-restore]')?.dataset.restore;
  if (restoreId) {
    const { error } = await sb.from('accounts').update({ archived: false }).eq('id', restoreId);
    if (error) return toast('Не удалось вернуть: ' + error.message);
    toast('Счёт возвращён');
    refresh();
    return;
  }
  const accId = e.target.closest?.('[data-acc]')?.dataset.acc;
  if (accId) { const a = state.allAccounts.find((x) => x.id === accId); if (a) openAccEdit(a); }
});

// ---------- резервная копия ----------
const BACKUP_KEY = 'lastBackup';

function lastBackupDate() {
  try { return localStorage.getItem(BACKUP_KEY); } catch { return null; }
}

function updateBackupHint() {
  const last = lastBackupDate();
  const stale = !last || daysBetween(last, todayLocal()) > 14;
  $('#backup-hint').hidden = !(stale && state.accounts.length);
  $('#backup-last').textContent = last
    ? `Последняя копия с этого устройства: ${fmtDate(last)}. Рекомендуется раз в 1–2 недели.`
    : 'С этого устройства копия ещё не скачивалась. Рекомендуется раз в 1–2 недели.';
}

function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// PostgREST отдаёт максимум 1000 строк за запрос — докачиваем страницами
async function fetchAll(table, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('*').order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

$('#data-btn').addEventListener('click', () => {
  $('#data-error').textContent = '';
  updateBackupHint();
  $('#data-dialog').showModal();
});

$('#backup-json').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  $('#data-error').textContent = '';
  try {
    const [households, members, accounts, categories, transactions, planned_items] = await Promise.all([
      fetchAll('households', 'created_at'), fetchAll('members', 'user_id'), fetchAll('accounts', 'created_at'),
      fetchAll('categories', 'name'), fetchAll('transactions', 'created_at'), fetchAll('planned_items', 'created_at'),
    ]);
    const payload = { app: 'family-budget', version: 1, exported_at: new Date().toISOString(),
      tables: { households, members, accounts, categories, transactions, planned_items } };
    download(`family-budget-backup-${todayLocal()}.json`, JSON.stringify(payload, null, 2), 'application/json');
    try { localStorage.setItem(BACKUP_KEY, todayLocal()); } catch { /* ignore */ }
    updateBackupHint();
    toast(`Копия скачана: ${transactions.length} операций, ${accounts.length} счетов`);
  } catch (err) {
    $('#data-error').textContent = 'Не удалось скачать: ' + (err.message || err);
  }
  btn.disabled = false;
});

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

$('#backup-csv').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  $('#data-error').textContent = '';
  try {
    const txs = await fetchAll('transactions', 'tx_date');
    const acc = new Map(state.allAccounts.map((a) => [a.id, a]));
    const cat = new Map(state.categories.map((c) => [c.id, c.name]));
    const kinds = { income: 'Доход', expense: 'Расход', transfer: 'Перевод' };
    const num = (n) => String(n).replace('.', ',');
    const head = ['Дата', 'Тип', 'Счёт', 'Валюта', 'Сумма', 'Категория', 'На счёт', 'Сумма зачисления', 'Валюта зачисления', 'Кто внёс', 'Комментарий'];
    const rows = txs.reverse().map((t) => {
      const a = acc.get(t.account_id), b = acc.get(t.to_account_id);
      return [t.tx_date, kinds[t.kind], a?.name, a?.currency, num(t.amount), cat.get(t.category_id), b?.name,
        t.to_amount == null ? '' : num(t.to_amount), b?.currency, memberName(t.created_by), t.note].map(csvCell).join(';');
    });
    download(`family-budget-operations-${todayLocal()}.csv`, '﻿' + [head.join(';'), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
    toast(`Выгружено операций: ${txs.length}`);
  } catch (err) {
    $('#data-error').textContent = 'Не удалось выгрузить: ' + (err.message || err);
  }
  btn.disabled = false;
});

// ---------- фото чека ----------
state.rc = null;

// Сжимаем фото до разумного размера: быстрее загрузка и дешевле распознавание
async function imageToJpegDataUrl(file, maxSide = 1600, quality = 0.82) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    src = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Не удалось открыть фото'));
      im.src = URL.createObjectURL(file);
    });
  }
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * k);
  c.height = Math.round(src.height * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  src.close?.();
  return c.toDataURL('image/jpeg', quality);
}

$('#rc-loading').addEventListener('cancel', (e) => e.preventDefault());
$('#scan-btn').addEventListener('click', () => {
  if (!state.accounts.length) { toast('Сначала добавь счёт'); return; }
  $('#scan-input').click();
});

$('#scan-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const loading = $('#rc-loading');
  loading.showModal();
  try {
    const image = await imageToJpegDataUrl(file);
    const session = (await sb.auth.getSession()).data.session;
    if (!session) throw new Error('Нужно войти заново.');
    const categories = state.categories.filter((c) => c.kind === 'expense').map((c) => ({ id: c.id, name: c.name }));
    const res = await fetch(`${window.APP_CONFIG.SUPABASE_URL}/functions/v1/parse-receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: window.APP_CONFIG.SUPABASE_KEY },
      body: JSON.stringify({ image, categories, today: todayLocal() }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* не JSON */ }
    if (res.status === 404) throw new Error('функция распознавания ещё не установлена в Supabase.');
    if (!res.ok) throw new Error(data?.error || `ошибка ${res.status}`);
    loading.close();
    openReceiptDialog(data);
  } catch (err) {
    loading.close();
    console.error(err);
    toast('Чек: ' + (err.message || err));
  }
});

function openReceiptDialog(data) {
  // группируем позиции по категориям
  const map = new Map();
  for (const it of data.items) {
    const key = it.category_id ?? '';
    const g = map.get(key) ?? { category_id: it.category_id, amount: 0, names: [] };
    g.amount = round2(g.amount + it.amount);
    if (it.name) g.names.push(it.name);
    map.set(key, g);
  }
  if (!map.size) { toast('В чеке не нашлось позиций. Сфотографируй ровнее и ближе, чтобы текст читался.'); return; }
  state.rc = { total: data.total, currency: data.currency, groups: [...map.values()] };

  const f = $('#rc-form');
  f.reset();
  f.account.innerHTML = state.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.currency)} (${esc(memberName(a.owner_id))})</option>`).join('');
  let pick = state.accounts.find((a) => a.currency === data.currency)?.id;
  if (!pick) {
    try { pick = localStorage.getItem('lastAccount'); } catch { /* ignore */ }
  }
  if (pick && state.accounts.some((a) => a.id === pick)) f.account.value = pick;
  f.date.value = data.date ?? todayLocal();
  f.store.value = data.store ?? '';
  $('#rc-error').textContent = '';
  renderRcGroups();
  $('#rc-dialog').showModal();
}

function renderRcGroups() {
  const cats = state.categories.filter((c) => c.kind === 'expense');
  const options = (sel) => '<option value="">— без категории —</option>'
    + cats.map((c) => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  $('#rc-groups').innerHTML = state.rc.groups.map((g, i) => {
    const names = g.names.slice(0, 4).join(', ') + (g.names.length > 4 ? ` и ещё ${g.names.length - 4}` : '');
    return `
    <div class="rc-group">
      <select data-rc-cat="${i}" aria-label="Категория">${options(g.category_id)}</select>
      <input data-rc-amt="${i}" inputmode="decimal" value="${esc(String(g.amount).replace('.', ','))}" aria-label="Сумма">
      <button type="button" class="del" data-rc-del="${i}" title="Убрать" aria-label="Убрать группу">✕</button>
      <div class="names">${esc(names)}</div>
    </div>`;
  }).join('');
  updateRcCheck();
}

function updateRcCheck() {
  const el = $('#rc-check');
  const { groups, total, currency } = state.rc;
  const sum = round2(groups.reduce((s, g) => s + (Number.isFinite(g.amount) ? g.amount : 0), 0));
  const parts = [];
  if (total != null) {
    const ok = Math.abs(sum - total) < 0.015;
    parts.push(ok
      ? `<span class="rc-check-ok">✓ Сумма сходится с итогом чека (${esc(String(total))}).</span>`
      : `<span class="rc-check-warn">⚠ По категориям ${esc(String(sum))}, а в чеке итого ${esc(String(total))}. Проверь суммы.</span>`);
  } else {
    parts.push(`Итого по категориям: ${esc(String(sum))}.`);
  }
  const acc = state.accounts.find((a) => a.id === $('#rc-form').account.value);
  if (acc && currency && acc.currency !== currency) {
    parts.push(`<span class="rc-check-warn">Валюта чека ${esc(currency)}, а счёт в ${esc(acc.currency)}: суммы сохранятся как есть, проверь выбор счёта.</span>`);
  }
  el.innerHTML = parts.join('<br>');
}

$('#rc-groups').addEventListener('change', (e) => {
  const i = e.target.dataset?.rcCat;
  if (i !== undefined) state.rc.groups[i].category_id = e.target.value || null;
});
$('#rc-groups').addEventListener('input', (e) => {
  const i = e.target.dataset?.rcAmt;
  if (i === undefined) return;
  state.rc.groups[i].amount = parseAmount(e.target.value);
  updateRcCheck();
});
$('#rc-groups').addEventListener('click', (e) => {
  const i = e.target.closest?.('[data-rc-del]')?.dataset.rcDel;
  if (i === undefined) return;
  state.rc.groups.splice(Number(i), 1);
  renderRcGroups();
});
$('#rc-form').account.addEventListener('change', updateRcCheck);

$('#rc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!state.rc.groups.length) { $('#rc-error').textContent = 'Нет ни одной суммы для сохранения.'; return; }
  // одинаковые категории объединяем в одну операцию
  const merged = new Map();
  for (const g of state.rc.groups) {
    if (!(g.amount > 0)) { $('#rc-error').textContent = 'Все суммы должны быть больше нуля. Скидку лучше убрать или вычесть из суммы нужной категории.'; return; }
    const key = g.category_id ?? '';
    merged.set(key, round2((merged.get(key) ?? 0) + g.amount));
  }
  const note = f.store.value.trim() || 'Чек';
  const rows = [...merged].map(([cat, amount]) => ({
    household_id: state.householdId, kind: 'expense', account_id: f.account.value, amount,
    category_id: cat || null, tx_date: f.date.value, note,
  }));
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  const { error } = await sb.from('transactions').insert(rows);
  btn.disabled = false;
  if (error) { $('#rc-error').textContent = 'Не удалось сохранить: ' + error.message; return; }
  try { localStorage.setItem('lastAccount', f.account.value); } catch { /* ignore */ }
  $('#rc-dialog').close();
  toast(`Сохранено операций: ${rows.length}`);
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
