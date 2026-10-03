// WellnessCFO — Client Application Logic (Phase 3: AI Intelligence & Command Center)
const API_BASE = '/api';
const TOKEN_KEY = 'wellnesscfo-token';
const CACHE_KEY = 'wellnesscfo-cache';
const LEGACY_KEY = 'wellnesscfo-data-v1';
const MIGRATED_KEY = 'wellnesscfo-migrated-v1';

let currentUser = null;
let currentSummary = null;
let activeFilter = 'all';
let activeCategory = 'all';
let currentTab = 'income';
let chartInterval = 'monthly';
let chartView = 'cashflow';
let staged = [];
let editingTxId = null;
let currentCandidateTx = null;

// Localization & Helpers
function money(n) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  }).format(Number(n) || 0);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function txKey(t) {
  return [t.date, Math.abs(Number(t.amount)).toFixed(2), norm(t.description)].join('|');
}

function toast(msg) {
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3200);
}

// Network Layer with Offline Fallback
async function api(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  try {
    const res = await fetch(`${API_BASE}${path}`, { credentials: 'omit', ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/auth/')) {
        handleUnauthorized();
      }
      throw new Error(data.error || `HTTP error ${res.status}`);
    }
    setSyncStatus(true);
    return data;
  } catch (err) {
    console.warn(`API call ${path} failed:`, err);
    if (!path.startsWith('/auth/')) {
      setSyncStatus(false);
    }
    throw err;
  }
}

function setSyncStatus(online) {
  const el = document.querySelector('#sync-status');
  if (!el) return;
  if (online) {
    el.innerHTML = '<span class="sync-dot"></span> Cloud active';
  } else {
    el.innerHTML = '<span class="sync-dot offline"></span> Offline cache';
  }
}

// Authentication
function handleUnauthorized() {
  localStorage.removeItem(TOKEN_KEY);
  currentUser = null;
  updateAuthUI();
  openAuthDialog(false);
}

async function checkAuth() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return false;
  try {
    const data = await api('/auth/me');
    currentUser = data.user;
    updateAuthUI();
    return true;
  } catch {
    currentUser = null;
    updateAuthUI();
    return false;
  }
}

function updateAuthUI() {
  const topAvatar = document.querySelector('#topbar-avatar');
  const topName = document.querySelector('#topbar-name');
  const sideAvatar = document.querySelector('#sidebar-avatar');
  const sideName = document.querySelector('#sidebar-user-name');
  const sideStatus = document.querySelector('#sidebar-user-status');

  if (currentUser) {
    const initial = (currentUser.avatarText || currentUser.name.charAt(0) || 'A').toUpperCase();
    if (topAvatar) topAvatar.textContent = initial;
    if (topName) topName.textContent = currentUser.name;
    if (sideAvatar) sideAvatar.textContent = initial;
    if (sideName) sideName.textContent = currentUser.name;
    if (sideStatus) sideStatus.textContent = currentUser.motto || 'Personal CFO';
  } else {
    if (topAvatar) topAvatar.textContent = '?';
    if (topName) topName.textContent = 'Log in';
    if (sideAvatar) sideAvatar.textContent = '?';
    if (sideName) sideName.textContent = 'Guest';
    if (sideStatus) sideStatus.textContent = 'Click to sign in';
  }
}

// Dashboard Refresh & Data Orchestration
async function refreshDashboard() {
  const todayStr = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date());
  const todayEl = document.querySelector('#today');
  if (todayEl) todayEl.textContent = todayStr;

  if (!currentUser) {
    renderSummaryZeroState();
    return;
  }

  try {
    const summary = await api('/summary');
    currentSummary = summary;
    localStorage.setItem(CACHE_KEY, JSON.stringify(summary));
    renderSummary(summary);
    await checkAndMigrateLegacyData();
  } catch (err) {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        const s = JSON.parse(cached);
        currentSummary = s;
        renderSummary(s);
        toast('Displaying offline cached data');
      } catch {}
    } else {
      renderSummaryZeroState();
    }
  }

  await loadTransactions();
  await loadAndRenderCharts();
  await loadInvestments();
  await loadLending();
  await loadSplits();
  await loadCalendar();
  await loadRecurring();
}

function renderSummaryZeroState() {
  document.querySelector('#balance').textContent = money(0);
  document.querySelector('#available-cash').textContent = money(0);
  document.querySelector('#spending').textContent = money(0);
  document.querySelector('#spending-note').textContent = 'Income: ₹0';
  document.querySelector('#cfo-savings').textContent = money(0);
  document.querySelector('#cfo-emergency').textContent = money(0);
  document.querySelector('#cfo-emergency-sub').textContent = '0.0 mos runway';
  document.querySelector('#cfo-business').textContent = money(0);
  document.querySelector('#cfo-business-sub').textContent = '0% funded';
  document.querySelector('#cfo-investments').textContent = money(0);
  document.querySelector('#cfo-investments-sub').textContent = 'Long-term wealth';
  const recEl = document.querySelector('#cfo-receivables');
  if (recEl) recEl.textContent = money(0);
  const recSubEl = document.querySelector('#cfo-receivables-sub');
  if (recSubEl) recSubEl.textContent = 'Lent / split owed';
  document.querySelector('#investment-total').textContent = money(0);
  document.querySelector('#sparkline-container').innerHTML = '';
  document.querySelector('#cash-bars').innerHTML = '';
  document.querySelector('#spending-bars').innerHTML = '';
  document.querySelector('#buckets-container').innerHTML = '<div class="card-note">Log in to view money buckets.</div>';
  document.querySelector('#goals-container').innerHTML = '<div class="card-note">Log in to view financial goals.</div>';
  document.querySelector('#accounts-list').innerHTML = '';
  document.querySelector('#transaction-list').innerHTML = '<div class="review-empty">Please log in to view transactions.</div>';

  const holdingsEl = document.querySelector('#holdings-container');
  if (holdingsEl) holdingsEl.innerHTML = '<div class="empty-cfo-state"><span>◉</span>No investment holdings recorded yet. Add your stocks, mutual funds, or ETFs.</div>';
  const lendingEl = document.querySelector('#lending-list');
  if (lendingEl) lendingEl.innerHTML = '<div class="empty-cfo-state"><span>⇄</span>No active loans or advances. Record money lent to or borrowed from people.</div>';
  const splitsEl = document.querySelector('#splits-list');
  if (splitsEl) splitsEl.innerHTML = '<div class="empty-cfo-state"><span>☲</span>No split expenses recorded yet.</div>';
  const calEl = document.querySelector('#calendar-timeline');
  if (calEl) calEl.innerHTML = '<div class="empty-cfo-state"><span>◷</span>No upcoming commitments scheduled in the next 45 days.</div>';
  const recListEl = document.querySelector('#recurring-list');
  if (recListEl) recListEl.innerHTML = '<div class="empty-cfo-state"><span>◷</span>No recurring rules configured.</div>';
}

function renderSummary(s) {
  // Primary Cards
  document.querySelector('#balance').textContent = money(s.netWorth);
  document.querySelector('#available-cash').textContent = money(s.availableCash);
  document.querySelector('#spending').textContent = money(s.thisMonth.spending);
  document.querySelector('#spending-note').textContent = `Income: ${money(s.thisMonth.income)}`;

  // CFO Strip
  document.querySelector('#cfo-savings').textContent = money(s.savingsFund);
  document.querySelector('#cfo-emergency').textContent = money(s.emergencyFund);
  const emDetails = s.emergencyFundDetails || {};
  document.querySelector('#cfo-emergency-sub').textContent = `${emDetails.monthsCovered || 0} mos runway`;

  document.querySelector('#cfo-business').textContent = money(s.businessFund);
  const bzDetails = s.businessFundDetails || {};
  document.querySelector('#cfo-business-sub').textContent = `${bzDetails.progressPct || 0}% funded`;

  document.querySelector('#cfo-investments').textContent = money(s.investments);
  document.querySelector('#cfo-investments-sub').textContent = `${s.portfolioAllocations?.length || 0} holdings`;

  const recEl = document.querySelector('#cfo-receivables');
  if (recEl) {
    const netRec = (s.totalReceivables || 0) - (s.totalPayables || 0);
    recEl.textContent = money(netRec);
    const recSubEl = document.querySelector('#cfo-receivables-sub');
    if (recSubEl) {
      recSubEl.textContent = `+${money(s.totalReceivables || 0)} / -${money(s.totalPayables || 0)}`;
    }
  }

  // Dynamic Sparkline & Mini-bars
  renderSparkline(s.thisMonth.dailySeries, s.availableCash);
  renderDailyBars('#cash-bars', s.thisMonth.dailySeries.map(d => d.income - d.spending));
  renderDailyBars('#spending-bars', s.thisMonth.dailySeries.map(d => d.spending));

  // Buckets, Goals & Accounts
  renderBuckets(s.buckets);
  renderGoals(s.goals || []);
  renderAccountsList(s.accounts || []);

  // Investments Panel
  document.querySelector('#investment-total').textContent = money(s.investments);
  renderPortfolioAllocation(s.portfolioAllocations);
}

function renderSparkline(series, currentCash) {
  const container = document.querySelector('#sparkline-container');
  if (!container || !series || series.length < 2) {
    if (container) container.innerHTML = '';
    return;
  }

  let running = currentCash;
  const points = [];
  for (let i = series.length - 1; i >= 0; i--) {
    points.unshift(running);
    const dayDelta = (series[i].income || 0) - (series[i].spending || 0);
    running -= dayDelta;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const width = 300;
  const height = 54;
  const pad = 6;

  const coords = points.map((val, idx) => {
    const x = (idx / (points.length - 1)) * width;
    const y = height - pad - ((val - min) / range) * (height - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD = 'M ' + coords.join(' L ');
  const areaD = `${pathD} L ${width},${height} L 0,${height} Z`;

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkFade" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#dce7d3" stop-opacity="0.8"/>
          <stop offset="1" stop-color="#f5f7f1" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${areaD}" fill="url(#sparkFade)" />
      <path d="${pathD}" fill="none" stroke="#8da882" stroke-width="2.5" stroke-linecap="round" />
    </svg>
  `;
}

function renderDailyBars(selector, values) {
  const container = document.querySelector(selector);
  if (!container || !values || !values.length) return;

  const max = Math.max(...values.map(v => Math.abs(v))) || 1;
  container.innerHTML = values.map(v => {
    const pct = Math.max(8, Math.round((Math.abs(v) / max) * 100));
    return `<i style="height:${pct}%" title="${money(v)}"></i>`;
  }).join('');
}

// Buckets, Goals & Accounts
function renderBuckets(buckets) {
  const container = document.querySelector('#buckets-container');
  if (!container) return;
  if (!buckets || !buckets.length) {
    container.innerHTML = '<div class="card-note">No buckets found.</div>';
    return;
  }

  container.innerHTML = buckets.map(b => {
    const target = b.target_amount || 0;
    const pct = target > 0 ? Math.min(100, Math.round((b.balance / target) * 100)) : 100;
    return `
      <div class="bucket-card">
        <div class="bucket-card-head">
          <span style="font-weight:600">${esc(b.name)}</span>
          <button class="tx-action-btn" title="Edit Bucket" onclick="openBucketModal('${b.id}')">✎</button>
        </div>
        <div class="bucket-card-val">${money(b.balance)}</div>
        ${target > 0 ? `
          <div class="bucket-progress">
            <div class="bucket-bar" style="width:${pct}%"></div>
          </div>
          <div style="font-size:9px;color:var(--muted);margin-top:4px;display:flex;justify-content:space-between">
            <span>Target: ${money(target)}</span>
            <span>${pct}%</span>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderGoals(goals) {
  const container = document.querySelector('#goals-container');
  if (!container) return;
  if (!goals || !goals.length) {
    container.innerHTML = '<div class="card-note">No active goals. Create one above to track progress.</div>';
    return;
  }

  container.innerHTML = goals.map(g => {
    const isEmergency = g.type === 'emergency';
    const isBusiness = g.type === 'business';
    const badgeName = isEmergency ? 'Emergency' : (isBusiness ? 'Business' : (g.type === 'investments' ? 'Investments' : 'Savings'));
    const target = g.target_amount || 1;
    const current = g.current_amount || 0;
    const pct = Math.min(100, Math.round((current / target) * 100));

    return `
      <div class="goal-card">
        <div class="goal-card-top">
          <div>
            <span class="goal-card-badge">${badgeName}</span>
            <div class="goal-card-name" style="margin-top:4px">${esc(g.name)}</div>
          </div>
          <button class="tx-action-btn" title="Edit Goal" onclick="openBucketModal('${g.bucket_id || ''}')">✎</button>
        </div>
        <div class="goal-card-amount">${money(current)} <small style="font-size:12px;color:var(--muted);font-weight:400">/ ${money(target)}</small></div>
        <div class="goal-progress-wrap">
          <div class="goal-progress-bar" style="width:${pct}%"></div>
        </div>
        <div class="goal-card-sub">
          <span>${pct}% Funded</span>
          <span>${money(Math.max(0, target - current))} remaining</span>
        </div>
        ${g.target_date ? `
          <div class="goal-card-footer">
            <span>Target Date: ${esc(g.target_date)}</span>
            <button class="outline-btn" style="padding:4px 8px;font-size:10px" onclick="openRecordModal('bucket-transfer')">Allocate Funds</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderAccountsList(accounts) {
  const container = document.querySelector('#accounts-list');
  if (!container) return;
  if (!accounts || !accounts.length) {
    container.innerHTML = '<div class="card-note">No accounts recorded.</div>';
    return;
  }

  container.innerHTML = accounts.map(a => {
    const isCredit = a.type === 'credit_card';
    const typeLabel = isCredit ? 'Credit Card (Liability)' : (a.type === 'investment' ? 'Investment' : 'Liquid Cash');
    return `
      <div class="account-card ${isCredit ? 'credit-card' : ''}">
        <div>
          <div style="font-weight:600;font-size:13px">${esc(a.name)}</div>
          <small style="font-size:10px;color:var(--muted)">${typeLabel}</small>
        </div>
        <div style="text-align:right">
          <div style="font:700 15px Manrope;color:${isCredit ? 'var(--rose)' : 'var(--ink)'}">${money(a.balance)}</div>
          <button class="tx-action-btn" title="Deactivate Account" onclick="deactivateAccount('${a.id}')">✕</button>
        </div>
      </div>
    `;
  }).join('');
  populatePhase4Selectors();
}

function renderPortfolioAllocation(allocs) {
  const bar = document.querySelector('#allocation-bar');
  const legend = document.querySelector('#allocation-legend');
  if (!bar || !legend) return;

  if (!allocs || !allocs.length) {
    bar.innerHTML = '<span style="width:100%;background:#e0e4db"></span>';
    legend.innerHTML = '<div style="font-size:10px;color:var(--muted)">No portfolio assets recorded.</div>';
    return;
  }

  const colors = ['#81977e', '#c9b27f', '#d6dad1', '#9ba998', '#b8a688'];
  bar.innerHTML = allocs.map((a, i) => `
    <span style="width:${Math.max(2, a.percentage)}%;background:${colors[i % colors.length]}" title="${esc(a.kind)}: ${a.percentage}%"></span>
  `).join('');

  legend.innerHTML = allocs.map((a, i) => `
    <div>
      <i class="dot" style="background:${colors[i % colors.length]}"></i>
      ${esc(a.kind)} <strong>${a.percentage}%</strong>
    </div>
  `).join('');
}

// Real Time-Series Chart Renderer
async function loadAndRenderCharts() {
  if (!currentUser) return;
  try {
    const chartData = await api(`/charts?interval=${chartInterval}`);
    renderDynamicChart(chartData);
  } catch (err) {
    console.warn('Chart loading error:', err);
  }
}

function renderDynamicChart(data) {
  const svg = document.querySelector('#chart-svg');
  const legend = document.querySelector('#chart-legend');
  const heading = document.querySelector('#chart-heading');
  if (!svg || !data) return;

  const width = 800;
  const height = 220;
  const padBottom = 28;
  const padTop = 16;
  const padSide = 32;

  if (chartView === 'cashflow') {
    heading.textContent = `Cash Flow Dynamics (${data.interval.toUpperCase()})`;
    legend.innerHTML = `
      <span><i class="dot" style="background:#667b66"></i> Income</span>
      <span><i class="dot" style="background:#b97f79"></i> Spending</span>
      <span><i class="dot" style="background:#c7a76b"></i> Net Cash Flow</span>
    `;

    const items = data.cashFlow || [];
    if (!items.length) {
      svg.innerHTML = '<text x="400" y="110" text-anchor="middle" fill="#879087" font-size="12">No cash flow transactions recorded yet.</text>';
      return;
    }

    const maxVal = Math.max(...items.map(d => Math.max(d.income, d.expense, Math.abs(d.net)))) || 1000;
    const barWidth = Math.min(24, Math.floor((width - 2 * padSide) / (items.length * 2.5)));
    const step = (width - 2 * padSide) / items.length;

    let elements = `<line x1="${padSide}" y1="${height - padBottom}" x2="${width - padSide}" y2="${height - padBottom}" stroke="#e0e3dc" stroke-width="1" />`;
    const netPoints = [];

    items.forEach((item, idx) => {
      const centerX = padSide + idx * step + step / 2;
      const incH = Math.max(2, Math.round((item.income / maxVal) * (height - padBottom - padTop)));
      const expH = Math.max(2, Math.round((item.expense / maxVal) * (height - padBottom - padTop)));

      const incY = height - padBottom - incH;
      const expY = height - padBottom - expH;

      elements += `
        <rect x="${centerX - barWidth - 1}" y="${incY}" width="${barWidth}" height="${incH}" rx="3" fill="#667b66" opacity="0.85">
          <title>${item.period}: Income ${money(item.income)}</title>
        </rect>
        <rect x="${centerX + 1}" y="${expY}" width="${barWidth}" height="${expH}" rx="3" fill="#b97f79" opacity="0.85">
          <title>${item.period}: Expense ${money(item.expense)}</title>
        </rect>
        <text x="${centerX}" y="${height - 8}" text-anchor="middle" font-size="9" fill="#879087">${item.period.length > 7 ? item.period.slice(5) : item.period}</text>
      `;

      const netY = height - padBottom - Math.max(2, Math.round((Math.max(0, item.net) / maxVal) * (height - padBottom - padTop)));
      netPoints.push(`${centerX},${netY}`);
    });

    if (netPoints.length > 1) {
      elements += `<polyline points="${netPoints.join(' ')}" fill="none" stroke="#c7a76b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
    }

    svg.innerHTML = elements;
  } else if (chartView === 'allocation') {
    heading.textContent = 'Allocation: Where Capital Goes';
    const alloc = data.allocation || { savings: 0, investments: 0, business: 0, spending: 0 };
    const total = alloc.savings + alloc.investments + alloc.business + alloc.spending || 1;

    legend.innerHTML = `
      <span><i class="dot" style="background:#81977e"></i> Savings (${money(alloc.savings)})</span>
      <span><i class="dot" style="background:#c9b27f"></i> Investments (${money(alloc.investments)})</span>
      <span><i class="dot" style="background:#566a58"></i> Business (${money(alloc.business)})</span>
      <span><i class="dot" style="background:#b97f79"></i> Spending (${money(alloc.spending)})</span>
    `;

    const segments = [
      { name: 'Savings', val: alloc.savings, color: '#81977e' },
      { name: 'Investments', val: alloc.investments, color: '#c9b27f' },
      { name: 'Business', val: alloc.business, color: '#566a58' },
      { name: 'Spending', val: alloc.spending, color: '#b97f79' }
    ];

    let startX = padSide;
    const usableW = width - 2 * padSide;
    let elements = `<line x1="${padSide}" y1="140" x2="${width - padSide}" y2="140" stroke="#e0e3dc" stroke-width="1" />`;

    segments.forEach(seg => {
      const segW = Math.max(4, Math.round((seg.val / total) * usableW));
      elements += `
        <rect x="${startX}" y="70" width="${segW - 2}" height="48" rx="6" fill="${seg.color}" opacity="0.9">
          <title>${seg.name}: ${money(seg.val)} (${Math.round((seg.val/total)*100)}%)</title>
        </rect>
        <text x="${startX + segW / 2}" y="100" text-anchor="middle" fill="#fff" font-size="11" font-weight="600">
          ${segW > 45 ? `${Math.round((seg.val/total)*100)}%` : ''}
        </text>
      `;
      startX += segW;
    });

    svg.innerHTML = elements;
  } else if (chartView === 'categories') {
    heading.textContent = 'Category Breakdown (Spending Distribution)';
    const cats = (data.categories || []).slice(0, 7);
    legend.innerHTML = '<span>Top spending categories sorted by volume</span>';

    if (!cats.length) {
      svg.innerHTML = '<text x="400" y="110" text-anchor="middle" fill="#879087" font-size="12">No category spending recorded yet.</text>';
      return;
    }

    let elements = '';
    cats.forEach((c, idx) => {
      const y = 20 + idx * 27;
      const barMaxW = 460;
      const barW = Math.max(6, Math.round((c.percentage / 100) * barMaxW));
      elements += `
        <text x="36" y="${y + 14}" font-size="11" fill="#435a48" font-weight="500">${esc(c.category)}</text>
        <rect x="200" y="${y}" width="${barW}" height="18" rx="4" fill="#adc0a1" opacity="0.9" />
        <text x="${210 + barW}" y="${y + 13}" font-size="10" fill="#69736b" font-weight="600">${money(c.amount)} (${c.percentage}%)</text>
      `;
    });

    svg.innerHTML = elements;
  }
}

// Transactions Loading & Filtering
async function loadTransactions() {
  const list = document.querySelector('#transaction-list');
  const catFilter = document.querySelector('#category-filter');
  if (!list) return;

  if (!currentUser) {
    list.innerHTML = '<div class="review-empty">Please log in to view transactions.</div>';
    return;
  }

  try {
    let url = `/transactions?type=${encodeURIComponent(activeFilter)}`;
    if (activeCategory !== 'all') {
      url += `&category=${encodeURIComponent(activeCategory)}`;
    }
    const data = await api(url);
    const txs = data.transactions || [];

    if (catFilter && activeCategory === 'all') {
      const cats = Array.from(new Set(txs.map(t => t.category).filter(Boolean)));
      catFilter.innerHTML = '<option value="all">All categories</option>' +
        cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    }

    renderTransactions(txs);
  } catch (err) {
    list.innerHTML = `<div class="review-empty">Could not load transactions (${esc(err.message)}).</div>`;
  }
}

function renderTransactions(txs) {
  const list = document.querySelector('#transaction-list');
  if (!list) return;

  if (!txs.length) {
    list.innerHTML = '<div class="review-empty">No transactions found for this view. Add one above or ask the CFO assistant.</div>';
    return;
  }

  const icons = {
    'income': '↙',
    'expense': '↗',
    'transfer_account': '⇄',
    'transfer_bucket': '☲',
    'refund': '↺'
  };

  list.innerHTML = txs.map(t => {
    const isIncome = t.type === 'income' || t.type === 'refund';
    const isTransfer = t.type === 'transfer_account' || t.type === 'transfer_bucket';
    const sign = isTransfer ? '' : (isIncome ? '+' : '−');
    const tagClass = isTransfer ? 'tag-transfer' : (isIncome ? 'tag-income' : 'tag-expense');
    const displayType = isTransfer ? 'Transfer' : (isIncome ? 'Income' : 'Expense');
    const formattedDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(t.date + 'T00:00:00'));

    return `
      <div class="transaction-row">
        <div class="tx-icon">${icons[t.type] || '◉'}</div>
        <div class="tx-copy">
          <strong>${esc(t.description)}</strong>
          <small>
            <span class="tag ${tagClass}">${displayType}</span>
            ${esc(t.category || 'General')} · ${formattedDate}
            ${t.necessity && t.necessity !== 'Unclear' ? `<span class="necessity-tag">${esc(t.necessity)}</span>` : ''}
          </small>
        </div>
        <div class="tx-amount" style="color:${isIncome ? 'var(--sage-dark)' : (isTransfer ? 'var(--ink)' : 'var(--rose)')}">
          ${sign}${money(t.amount)}
          <small>${esc(t.category || 'Record')}</small>
        </div>
        <div style="margin-left:8px;display:flex;gap:2px">
          <button class="tx-action-btn" title="Edit" onclick="editTransaction('${t.id}')">✎</button>
          <button class="tx-action-btn delete" title="Delete" onclick="deleteTransactionPrompt('${t.id}')">🗑</button>
        </div>
      </div>
    `;
  }).join('');
}

// Phase 3 Natural Language Transaction Interpreter (Quick Entry Modal)
async function handleParseNaturalLanguageEntry() {
  const input = document.querySelector('#nl-tx-input');
  const preview = document.querySelector('#nl-preview-container');
  const text = (input?.value || '').trim();
  if (!text) {
    toast('Please type what happened with your money.');
    return;
  }

  try {
    const parsed = await api('/ai/parse-transaction', {
      method: 'POST',
      body: JSON.stringify({ text })
    });

    if (!parsed.success) {
      toast(parsed.error || 'Could not interpret input.');
      return;
    }

    currentCandidateTx = parsed;
    renderNlConfirmationPreview(parsed);
  } catch (err) {
    toast(`Interpretation failed: ${err.message}`);
  }
}

function renderNlConfirmationPreview(parsed) {
  const container = document.querySelector('#nl-preview-container');
  if (!container) return;

  const isIncome = parsed.type === 'income';
  const isAction = parsed.isAction;

  if (isAction) {
    container.innerHTML = `
      <div class="preview-card">
        <div style="font-size:10px;font-weight:700;letter-spacing:.8px;color:var(--sage-dark)">MONEY MOVEMENT PROPOSED</div>
        <div class="amount">${money(parsed.amount)}</div>
        <p style="margin:4px 0 10px;font-size:12px;color:var(--ink)">${esc(parsed.fromBucketName)} → ${esc(parsed.toBucketName)}</p>
        <div class="ai-explanation">${esc(parsed.preview?.impactNote || 'Internal allocation with no spending impact.')}</div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button type="button" class="primary" onclick="confirmCandidateTransaction()">Confirm Allocation</button>
          <button type="button" class="outline-btn" onclick="cancelCandidateTransaction()">Cancel</button>
        </div>
      </div>
    `;
    return;
  }

  const categoryChoices = [
    'Food & Dining', 'Groceries', 'Education & Stationery', 'Travel & Commute',
    'Investments & SIP', 'Rent & Utilities', 'Shopping', 'Health & Medical', 'Salary & Income'
  ];

  container.innerHTML = `
    <div class="preview-card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="tag ${isIncome ? 'tag-income' : 'tag-expense'}">${isIncome ? 'Income' : 'Expense'}</span>
        <span class="necessity-tag">${esc(parsed.necessity)}</span>
      </div>
      <div class="amount">${money(parsed.amount)}</div>
      <div style="font-weight:600;font-size:13px;color:var(--ink)">${esc(parsed.description)}</div>

      ${parsed.isAmbiguous ? `
        <div style="margin:10px 0;background:#fbf3e2;padding:8px 10px;border-radius:6px;font-size:11px;color:#855e24">
          I understood ₹${parsed.amount}, but couldn't verify the category. Please pick below:
          <select id="candidate-category-override" style="width:100%;margin-top:5px;padding:6px;border:1px solid #d9ded4;border-radius:6px">
            ${categoryChoices.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
      ` : `
        <div class="preview-details">
          <div>Category: <strong>${esc(parsed.category)}</strong></div>
          <div>Bucket: <strong>${esc(parsed.bucketName)}</strong></div>
          <div>Account: <strong>${esc(parsed.accountName)}</strong></div>
          <div>Date: <strong>${esc(parsed.date)}</strong></div>
        </div>
      `}

      <div class="ai-explanation">
        ${esc(parsed.necessityExplanation || 'Classified using evidence-based heuristics.')}
      </div>

      <div style="display:flex;gap:8px;margin-top:14px">
        <button type="button" class="primary" onclick="confirmCandidateTransaction()">Confirm & Record</button>
        <button type="button" class="outline-btn" onclick="expandCandidateToManual()">Edit Details</button>
        <button type="button" class="outline-btn" onclick="cancelCandidateTransaction()">Cancel</button>
      </div>
    </div>
  `;
}

async function confirmCandidateTransaction() {
  if (!currentCandidateTx) return;

  try {
    if (currentCandidateTx.isAction) {
      await api('/ai/execute-action', {
        method: 'POST',
        body: JSON.stringify({
          actionType: currentCandidateTx.actionType,
          fromBucketId: currentCandidateTx.fromBucketId,
          toBucketId: currentCandidateTx.toBucketId,
          amount: currentCandidateTx.amount,
          description: currentCandidateTx.description
        })
      });
      toast(`Allocated ${money(currentCandidateTx.amount)} from ${currentCandidateTx.fromBucketName} to ${currentCandidateTx.toBucketName}`);
    } else {
      const catOverrideEl = document.querySelector('#candidate-category-override');
      const finalCategory = catOverrideEl ? catOverrideEl.value : currentCandidateTx.category;

      await api('/transactions', {
        method: 'POST',
        body: JSON.stringify({
          amount: currentCandidateTx.amount,
          type: currentCandidateTx.type,
          category: finalCategory,
          description: currentCandidateTx.description,
          account_id: currentCandidateTx.accountId,
          bucket_id: currentCandidateTx.bucketId,
          necessity: currentCandidateTx.necessity,
          date: currentCandidateTx.date
        })
      });
      toast(`Recorded ${currentCandidateTx.type}: ${money(currentCandidateTx.amount)}`);
    }

    cancelCandidateTransaction();
    document.querySelector('#tx-dialog')?.close();
    await refreshDashboard();
  } catch (err) {
    toast(`Failed to record: ${err.message}`);
  }
}

function cancelCandidateTransaction() {
  currentCandidateTx = null;
  const container = document.querySelector('#nl-preview-container');
  if (container) container.innerHTML = '';
  const input = document.querySelector('#nl-tx-input');
  if (input) input.value = '';
}

function expandCandidateToManual() {
  if (!currentCandidateTx) return;
  const wrapper = document.querySelector('#manual-entry-wrapper');
  if (wrapper) wrapper.style.display = 'block';

  currentTab = currentCandidateTx.type === 'income' ? 'income' : 'expense';
  document.querySelectorAll('#tx-dialog .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === currentTab);
  });

  renderTxFormFields(currentCandidateTx);
  const container = document.querySelector('#nl-preview-container');
  if (container) container.innerHTML = '';
}

// Phase 3 AI Command Center Queries
async function handleAIQuerySubmit(queryOverride = null) {
  const input = document.querySelector('#ai-query-input');
  const stream = document.querySelector('#ai-output-stream');
  const query = String(queryOverride || input?.value || '').trim();
  if (!query) {
    toast('Please enter a query or select a prompt.');
    return;
  }

  if (input) input.value = query;
  stream.innerHTML = '<div class="card-note" style="padding:14px">✦ Analyzing your financial records...</div>';

  try {
    const res = await api('/ai/query', {
      method: 'POST',
      body: JSON.stringify({ query })
    });

    renderAIResponse(res.result, query);
  } catch (err) {
    stream.innerHTML = `<div class="warning-box">Could not process query: ${esc(err.message)}</div>`;
  }
}

function renderAIResponse(result, originalQuery) {
  const stream = document.querySelector('#ai-output-stream');
  if (!stream || !result) return;

  // 1. Financial Action Proposal
  if (result.intent === 'action_proposal') {
    stream.innerHTML = `
      <div class="ai-response-card">
        <div class="ai-response-head">
          <strong style="color:var(--ink)">${esc(result.title)}</strong>
          <span class="verdict-pill gold">Requires Confirmation</span>
        </div>
        <p style="font-size:13px;margin:6px 0">${esc(result.message)}</p>
        <ul style="margin:10px 0;padding-left:18px;font-size:11px;color:var(--muted)">
          ${result.details.map(d => `<li>${esc(d)}</li>`).join('')}
        </ul>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="primary" onclick="executeConfirmedAction('${result.actionType}', '${result.fromBucketId}', '${result.toBucketId}', ${result.amount})">Confirm Transfer</button>
          <button class="outline-btn" onclick="document.querySelector('#ai-output-stream').innerHTML=''">Cancel</button>
        </div>
      </div>
    `;
    return;
  }

  // 2. Affordability Analysis
  if (result.type === 'affordability') {
    stream.innerHTML = `
      <div class="ai-response-card">
        <div class="ai-response-head">
          <strong style="font-size:14px">Affordability Analysis for ${money(result.amount)} (${esc(result.itemName)})</strong>
          <span class="verdict-pill ${result.badgeColor}">${result.verdict}</span>
        </div>
        <div class="ai-explanation" style="font-size:12px;font-weight:500;color:var(--ink)">
          ${esc(result.verdictTitle)}
        </div>
        <ul style="margin:12px 0;padding-left:18px;font-size:11px;color:#556157;line-height:1.6">
          ${result.observations.map(obs => `<li>${esc(obs)}</li>`).join('')}
        </ul>
        <div style="font-size:10px;color:var(--muted);border-top:1px solid #f1f0e9;padding-top:8px">
          ${esc(result.disclaimer)}
        </div>
      </div>
    `;
    return;
  }

  // 3. Opportunity Cost Projection
  if (result.type === 'opportunity_cost') {
    const opp = result.data;
    stream.innerHTML = `
      <div class="ai-response-card">
        <div class="ai-response-head">
          <strong style="font-size:14px">${esc(result.title)}</strong>
          <span class="verdict-pill green">Compound Model</span>
        </div>
        <p style="font-size:12px;color:var(--ink);margin:4px 0 12px">${esc(result.message)}</p>

        <table class="ai-table">
          <thead>
            <tr><th>Horizon</th><th>Conservative (8%)</th><th>Moderate (12%)</th><th>Growth (14%)</th></tr>
          </thead>
          <tbody>
            ${opp.projections.map(p => `
              <tr>
                <td><strong>${p.years} Years</strong></td>
                <td>${money(p.scenarios[0].lumpSumFV)}</td>
                <td style="font-weight:600;color:var(--sage-dark)">${money(p.scenarios[1].lumpSumFV)}</td>
                <td>${money(p.scenarios[2].lumpSumFV)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div style="font-size:10px;color:var(--muted);margin-top:10px;border-top:1px solid #f1f0e9;padding-top:8px">
          ${esc(opp.disclaimer)}
        </div>
      </div>
    `;
    return;
  }

  // 4. Category Spending
  if (result.type === 'category_spending') {
    stream.innerHTML = `
      <div class="ai-response-card">
        <div class="ai-response-head">
          <strong>${esc(result.category)} Spending</strong>
          <span class="verdict-pill green">${result.count} transactions</span>
        </div>
        <div style="font:700 22px Manrope;color:var(--ink);margin:4px 0">${money(result.total)}</div>
        <p style="font-size:11px;color:var(--muted);margin-bottom:10px">${esc(result.message)}</p>

        ${result.transactions?.length ? `
          <table class="ai-table">
            <thead>
              <tr><th>Date</th><th>Merchant / Description</th><th>Amount</th></tr>
            </thead>
            <tbody>
              ${result.transactions.map(t => `
                <tr>
                  <td>${esc(t.date)}</td>
                  <td>${esc(t.description)}</td>
                  <td style="font-weight:600">${money(t.amount)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}
      </div>
    `;
    return;
  }

  // 5. Money Leaks Analysis
  if (result.type === 'money_leaks') {
    const leakData = result.data;
    stream.innerHTML = `
      <div class="ai-response-card">
        <div class="ai-response-head">
          <strong>${esc(result.title)}</strong>
          <span class="verdict-pill gold">${leakData.detectedCount} Observations</span>
        </div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:12px">${esc(result.message)}</p>

        <div style="display:grid;gap:10px">
          ${leakData.leaks.map(l => `
            <div style="background:#fcfbf7;border:1px solid #f0eee6;padding:10px 12px;border-radius:7px">
              <strong style="font-size:12px;color:var(--ink)">${esc(l.title)}</strong>
              <p style="font-size:11px;color:#6b756c;margin:4px 0">${esc(l.message)}</p>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    return;
  }

  // 6. Monthly CFO Review
  if (result.type === 'monthly_review') {
    const rev = result.data;
    stream.innerHTML = `
      <div class="ai-response-card">
        <div class="ai-response-head">
          <strong>${esc(result.title)}</strong>
          <span class="verdict-pill green">CFO Executive Memo</span>
        </div>
        <div class="preview-details" style="margin:10px 0">
          <div>Income: <strong>${money(rev.cashFlow.income)}</strong></div>
          <div>Expenses: <strong>${money(rev.cashFlow.spending)}</strong></div>
          <div>Net Surplus: <strong>${money(rev.cashFlow.netSurplus)}</strong></div>
          <div>Emergency Runway: <strong>${rev.emergencyRunway} Months</strong></div>
        </div>

        <div class="eyebrow" style="margin-top:12px">KEY OBSERVATIONS</div>
        <ul style="margin:6px 0;padding-left:18px;font-size:11px;color:#556157;line-height:1.6">
          ${rev.observations.map(obs => `<li>${esc(obs)}</li>`).join('')}
        </ul>

        <div class="eyebrow" style="margin-top:12px">TOP CATEGORIES THIS MONTH</div>
        <table class="ai-table">
          <tbody>
            ${rev.topCategories.map(c => `
              <tr>
                <td>${esc(c.category)}</td>
                <td style="text-align:right;font-weight:600">${money(c.total)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    return;
  }

  // Default Fallback
  stream.innerHTML = `
    <div class="ai-response-card">
      <div class="ai-response-head">
        <strong>${esc(result.title || 'CFO Response')}</strong>
      </div>
      <p style="font-size:12px;line-height:1.6;color:var(--ink)">${esc(result.message)}</p>
    </div>
  `;
}

async function executeConfirmedAction(actionType, fromBucketId, toBucketId, amount) {
  try {
    await api('/ai/execute-action', {
      method: 'POST',
      body: JSON.stringify({ actionType, fromBucketId, toBucketId, amount })
    });
    toast(`Action executed: Moved ${money(amount)} between buckets`);
    document.querySelector('#ai-output-stream').innerHTML = '<div class="ai-response-card"><span class="tag tag-income">Action Completed</span><p style="margin:6px 0;font-size:12px">Transfer successfully recorded in the financial ledger.</p></div>';
    await refreshDashboard();
  } catch (err) {
    toast(`Action execution failed: ${err.message}`);
  }
}

// Transaction Modal Opening & Form Rendering
function openRecordModal(defaultTab = 'income', editTx = null) {
  currentTab = defaultTab;
  editingTxId = editTx ? editTx.id : null;
  currentCandidateTx = null;

  const dialog = document.querySelector('#tx-dialog');
  const title = document.querySelector('#tx-dialog-title');
  const nlSection = document.querySelector('#nl-entry-section');
  const manualWrapper = document.querySelector('#manual-entry-wrapper');
  const preview = document.querySelector('#nl-preview-container');
  if (!dialog) return;

  if (preview) preview.innerHTML = '';

  if (editTx) {
    title.textContent = 'Edit transaction';
    if (nlSection) nlSection.style.display = 'none';
    if (manualWrapper) manualWrapper.style.display = 'block';
  } else {
    title.textContent = 'Record money movement';
    if (nlSection) nlSection.style.display = 'block';
    if (manualWrapper) manualWrapper.style.display = 'none';
  }

  document.querySelectorAll('#tx-dialog .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === defaultTab);
  });

  renderTxFormFields(editTx);
  dialog.showModal();
}

function renderTxFormFields(editTx = null) {
  const container = document.querySelector('#tx-fields');
  const warnContainer = document.querySelector('#tx-warning-container');
  if (!container || !currentSummary) return;
  warnContainer.innerHTML = '';

  const todayStr = editTx?.date || new Date().toISOString().slice(0, 10);
  const accounts = currentSummary.accounts || [];
  const buckets = currentSummary.buckets || [];

  const accOptions = accounts.map(a => `<option value="${a.id}" ${editTx?.account_id === a.id ? 'selected' : ''}>${esc(a.name)} (${money(a.balance)})</option>`).join('');
  const bktOptions = buckets.map(b => `<option value="${b.id}" ${editTx?.bucket_id === b.id ? 'selected' : ''}>${esc(b.name)} (${money(b.balance)})</option>`).join('');

  if (currentTab === 'income' || currentTab === 'expense') {
    const isExpense = currentTab === 'expense';
    container.innerHTML = `
      <div class="form-grid">
        <div class="form-group">
          <label>Amount (₹)</label>
          <input type="number" id="form-amount" step="0.01" min="0.01" value="${editTx?.amount || ''}" placeholder="₹ Amount" required autofocus>
        </div>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="form-date" value="${todayStr}" required>
        </div>
        <div class="form-group">
          <label>Account</label>
          <select id="form-account">${accOptions}</select>
        </div>
        <div class="form-group">
          <label>Bucket Allocation</label>
          <select id="form-bucket">${bktOptions}</select>
        </div>
        <div class="form-group">
          <label>Category</label>
          <input type="text" id="form-category" value="${esc(editTx?.category || '')}" placeholder="${isExpense ? 'Food, Groceries, Rent...' : 'Salary, Freelance, Dividend...'}" list="cat-suggestions">
          <datalist id="cat-suggestions">
            <option value="Food & Dining"><option value="Groceries"><option value="Rent & Utilities">
            <option value="Investments & SIP"><option value="Shopping"><option value="Salary & Income"><option value="Education & Stationery">
          </datalist>
        </div>
        ${isExpense ? `
          <div class="form-group">
            <label>Necessity Classification</label>
            <select id="form-necessity">
              <option value="Necessary" ${editTx?.necessity === 'Necessary' ? 'selected' : ''}>Necessary (Essential survival/health)</option>
              <option value="Useful" ${editTx?.necessity === 'Useful' ? 'selected' : ''}>Useful (Productivity/wellbeing)</option>
              <option value="Planned" ${editTx?.necessity === 'Planned' ? 'selected' : ''}>Planned (Budgeted goal)</option>
              <option value="Optional" ${editTx?.necessity === 'Optional' ? 'selected' : ''}>Optional (Nice to have)</option>
              <option value="Avoidable" ${editTx?.necessity === 'Avoidable' ? 'selected' : ''}>Avoidable (Could have skipped)</option>
              <option value="Wasteful" ${editTx?.necessity === 'Wasteful' ? 'selected' : ''}>Wasteful (Regretted purchase)</option>
              <option value="Unclear" ${!editTx?.necessity || editTx?.necessity === 'Unclear' ? 'selected' : ''}>Unclear</option>
            </select>
          </div>
        ` : ''}
        <div class="form-group full-width">
          <label>Description / Merchant</label>
          <input type="text" id="form-desc" value="${esc(editTx?.description || '')}" placeholder="Zepto groceries, Acme salary..." required>
        </div>
      </div>
    `;
  } else if (currentTab === 'account-transfer') {
    container.innerHTML = `
      <div class="form-grid">
        <div class="form-group">
          <label>From Account</label>
          <select id="form-from-acc">${accOptions}</select>
        </div>
        <div class="form-group">
          <label>To Account</label>
          <select id="form-to-acc">${accOptions}</select>
        </div>
        <div class="form-group">
          <label>Amount (₹)</label>
          <input type="number" id="form-amount" step="0.01" min="0.01" placeholder="₹ Amount" required autofocus>
        </div>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="form-date" value="${todayStr}" required>
        </div>
        <div class="form-group full-width">
          <label>Note / Description</label>
          <input type="text" id="form-desc" placeholder="ATM Cash Withdrawal, Bank Transfer...">
        </div>
      </div>
    `;
  } else if (currentTab === 'bucket-transfer') {
    container.innerHTML = `
      <div class="form-grid">
        <div class="form-group">
          <label>From Bucket</label>
          <select id="form-from-bkt">${bktOptions}</select>
        </div>
        <div class="form-group">
          <label>To Bucket</label>
          <select id="form-to-bkt">${bktOptions}</select>
        </div>
        <div class="form-group">
          <label>Amount (₹)</label>
          <input type="number" id="form-amount" step="0.01" min="0.01" placeholder="₹ Amount" required autofocus>
        </div>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="form-date" value="${todayStr}" required>
        </div>
        <div class="form-group full-width">
          <label>Allocation Note</label>
          <input type="text" id="form-desc" placeholder="Move savings to investments, monthly allocation...">
        </div>
      </div>
      <p class="section-subtitle" style="margin-top:6px">Internal bucket transfers adjust purpose allocation without impacting net worth or recording spending.</p>
    `;

    const fromSelect = document.querySelector('#form-from-bkt');
    fromSelect?.addEventListener('change', () => {
      const selectedBkt = buckets.find(b => b.id === fromSelect.value);
      if (selectedBkt && selectedBkt.type === 'emergency') {
        warnContainer.innerHTML = '<div class="warning-box">⚠️ Warning: You are moving money OUT of your Emergency Fund. This will lower your runway coverage.</div>';
      } else {
        warnContainer.innerHTML = '';
      }
    });
  }
}

async function handleSaveTransaction(e) {
  e.preventDefault();
  const dialog = document.querySelector('#tx-dialog');

  try {
    const amount = Number(document.querySelector('#form-amount').value);
    const date = document.querySelector('#form-date').value;
    const desc = (document.querySelector('#form-desc').value || '').trim();

    if (!amount || amount <= 0) {
      toast('Please enter a valid positive amount');
      return;
    }

    if (editingTxId) {
      const accountId = document.querySelector('#form-account')?.value;
      const bucketId = document.querySelector('#form-bucket')?.value;
      const category = (document.querySelector('#form-category')?.value || 'General').trim();
      const necessityEl = document.querySelector('#form-necessity');
      const necessity = necessityEl ? necessityEl.value : 'Unclear';

      await api(`/transactions/${editingTxId}`, {
        method: 'PUT',
        body: JSON.stringify({
          account_id: accountId,
          bucket_id: bucketId,
          amount,
          date,
          description: desc,
          category,
          necessity
        })
      });
      toast('Transaction updated successfully');
      editingTxId = null;
    } else if (currentTab === 'income' || currentTab === 'expense') {
      const accountId = document.querySelector('#form-account').value;
      const bucketId = document.querySelector('#form-bucket').value;
      const category = (document.querySelector('#form-category').value || 'General').trim();
      const necessityEl = document.querySelector('#form-necessity');
      const necessity = necessityEl ? necessityEl.value : 'Unclear';

      await api('/transactions', {
        method: 'POST',
        body: JSON.stringify({
          account_id: accountId,
          bucket_id: bucketId,
          amount,
          type: currentTab,
          date,
          description: desc || (currentTab === 'income' ? 'Income' : 'Expense'),
          category,
          necessity
        })
      });
      toast(`Recorded ${currentTab}: ${money(amount)}`);
    } else if (currentTab === 'account-transfer') {
      const fromAcc = document.querySelector('#form-from-acc').value;
      const toAcc = document.querySelector('#form-to-acc').value;
      if (fromAcc === toAcc) {
        toast('Source and destination accounts must be different');
        return;
      }
      await api('/transfers/account', {
        method: 'POST',
        body: JSON.stringify({
          fromAccountId: fromAcc,
          toAccountId: toAcc,
          amount,
          date,
          description: desc
        })
      });
      toast(`Transferred ${money(amount)} between accounts`);
    } else if (currentTab === 'bucket-transfer') {
      const fromBkt = document.querySelector('#form-from-bkt').value;
      const toBkt = document.querySelector('#form-to-bkt').value;
      if (fromBkt === toBkt) {
        toast('Source and destination buckets must be different');
        return;
      }
      const res = await api('/transfers/bucket', {
        method: 'POST',
        body: JSON.stringify({
          fromBucketId: fromBkt,
          toBucketId: toBkt,
          amount,
          date,
          description: desc
        })
      });
      if (res.transfer?.warning) {
        toast(res.transfer.warning);
      } else {
        toast(`Allocated ${money(amount)} between buckets`);
      }
    }

    dialog.close();
    await refreshDashboard();
  } catch (err) {
    toast(`Failed to save: ${err.message}`);
  }
}

async function editTransaction(id) {
  try {
    const data = await api('/transactions?type=all');
    const tx = (data.transactions || []).find(t => t.id === id);
    if (!tx) return;
    openRecordModal(tx.type === 'income' ? 'income' : 'expense', tx);
  } catch (err) {
    toast(`Could not load transaction: ${err.message}`);
  }
}

async function deleteTransactionPrompt(id) {
  if (!confirm('Are you sure you want to delete this transaction? Balances and charts will automatically recalculate.')) {
    return;
  }
  try {
    await api(`/transactions/${id}`, { method: 'DELETE' });
    toast('Transaction deleted and balances recalculated');
    await refreshDashboard();
  } catch (err) {
    toast(`Delete failed: ${err.message}`);
  }
}

// Account & Bucket Creation
function openAccountModal() {
  const dialog = document.querySelector('#account-dialog');
  document.querySelector('#account-form').reset();
  dialog.showModal();
}

async function handleSaveAccount(e) {
  e.preventDefault();
  const name = document.querySelector('#acc-name-input').value.trim();
  const type = document.querySelector('#acc-type-input').value;
  const startingBalance = Number(document.querySelector('#acc-start-bal').value) || 0;

  try {
    await api('/accounts', {
      method: 'POST',
      body: JSON.stringify({ name, type, startingBalance })
    });
    toast(`Created account: ${name}`);
    document.querySelector('#account-dialog').close();
    await refreshDashboard();
  } catch (err) {
    toast(`Account creation failed: ${err.message}`);
  }
}

async function deactivateAccount(id) {
  if (!confirm('Are you sure you want to deactivate this account?')) return;
  try {
    await api(`/accounts/${id}`, { method: 'DELETE' });
    toast('Account deactivated');
    await refreshDashboard();
  } catch (err) {
    toast(`Failed to deactivate: ${err.message}`);
  }
}

function openBucketModal(bucketId = null) {
  const dialog = document.querySelector('#bucket-dialog');
  const title = document.querySelector('#bucket-dialog-title');
  const form = document.querySelector('#bucket-form');
  const idInput = document.querySelector('#edit-bucket-id');
  const typeWrap = document.querySelector('#bkt-type-wrap');
  form.reset();

  if (bucketId && currentSummary) {
    const bkt = (currentSummary.buckets || []).find(b => b.id === bucketId);
    if (bkt) {
      title.textContent = `Configure ${bkt.name}`;
      idInput.value = bkt.id;
      document.querySelector('#bkt-name-input').value = bkt.name;
      document.querySelector('#bkt-target-input').value = bkt.target_amount || '';
      document.querySelector('#bkt-date-input').value = bkt.target_date || '';
      document.querySelector('#bkt-monthly-target').value = bkt.monthly_target || '';
      typeWrap.style.display = 'none';
    }
  } else {
    title.textContent = 'Create New Bucket';
    idInput.value = '';
    typeWrap.style.display = 'grid';
  }

  dialog.showModal();
}

async function handleSaveBucket(e) {
  e.preventDefault();
  const bktId = document.querySelector('#edit-bucket-id').value;
  const name = document.querySelector('#bkt-name-input').value.trim();
  const targetAmount = Number(document.querySelector('#bkt-target-input').value) || 0;
  const targetDate = document.querySelector('#bkt-date-input').value;
  const monthlyTarget = Number(document.querySelector('#bkt-monthly-target').value) || 0;

  try {
    if (bktId) {
      await api(`/buckets/${bktId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, targetAmount, targetDate, monthlyTarget })
      });
      toast(`Updated bucket: ${name}`);
    } else {
      const type = document.querySelector('#bkt-type-input').value;
      await api('/buckets', {
        method: 'POST',
        body: JSON.stringify({ name, type, targetAmount })
      });
      toast(`Created bucket: ${name}`);
    }
    document.querySelector('#bucket-dialog').close();
    await refreshDashboard();
  } catch (err) {
    toast(`Failed to save bucket: ${err.message}`);
  }
}

// CSV Ingestion (Preserved)
function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(x => x.trim());
  if (lines.length < 2) return [];

  const split = line => {
    const out = [];
    let val = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && line[i + 1] === '"' && q) { val += '"'; i++; }
      else if (c === '"') q = !q;
      else if (c === ',' && !q) { out.push(val.trim()); val = ''; }
      else val += c;
    }
    out.push(val.trim());
    return out;
  };

  const rows = lines.map(split);
  const heads = rows.shift().map(x => x.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const find = names => heads.findIndex(h => names.some(n => h === n || h.includes(n)));

  const di = find(['date', 'transactiondate', 'valuedate']);
  const de = find(['description', 'narration', 'details', 'merchant', 'particulars', 'remark']);
  const ai = find(['amount', 'transactionamount', 'debitcredit']);
  const cr = find(['credit', 'deposit']);
  const dr = find(['debit', 'withdrawal']);

  if (di < 0 || de < 0 || (ai < 0 && cr < 0 && dr < 0)) return [];

  return rows.map(r => {
    const date = normalizeDate(r[di]);
    const description = r[de] || 'Imported transaction';
    let amount;
    if (ai >= 0) {
      amount = Number(String(r[ai]).replace(/[₹,\s]/g, '').replace(/[()]/g, '-'));
    } else {
      const c = Number(String(r[cr] || '0').replace(/[₹,\s]/g, '')) || 0;
      const d = Number(String(r[dr] || '0').replace(/[₹,\s]/g, '')) || 0;
      amount = c - d;
    }
    if (!date || !Number.isFinite(amount) || amount === 0) return null;
    return {
      date,
      description,
      amount: Math.abs(amount),
      type: amount > 0 ? 'income' : 'expense',
      category: 'Imported'
    };
  }).filter(Boolean);
}

function parsePortfolioCSV(text, file) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(x => x.trim());
  if (lines.length < 2) return [];

  const split = line => {
    const out = [];
    let v = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && line[i + 1] === '"' && q) { v += '"'; i++; }
      else if (c === '"') q = !q;
      else if (c === ',' && !q) { out.push(v.trim()); v = ''; }
      else v += c;
    }
    out.push(v.trim());
    return out;
  };

  const rows = lines.map(split);
  const heads = rows.shift().map(x => x.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const find = terms => heads.findIndex(h => terms.some(t => h === t || h.includes(t)));
  const name = find(['scheme', 'fundname', 'stockname', 'security', 'instrument', 'company', 'symbol']);
  const value = find(['currentvalue', 'marketvalue', 'currentamount', 'value', 'presentvalue', 'amount']);
  const date = find(['asof', 'date', 'valuationdate']);
  const kind = /sip|mutual|fund/i.test(file) ? 'Mutual funds' : 'Stocks';

  if (value < 0) return [];
  return rows.map(r => {
    const n = Number(String(r[value] || '').replace(/[₹,\s]/g, ''));
    const asOf = date >= 0 ? normalizeDate(r[date]) : new Date().toISOString().slice(0, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { kind, value: n, asOf, file: file + (name >= 0 && r[name] ? ` · ${r[name]}` : '') };
  }).filter(Boolean);
}

function normalizeDate(s) {
  s = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    let d, mo;
    if (a > 12) { d = a; mo = b; }
    else if (b > 12) { d = b; mo = a; }
    else { d = a; mo = b; }
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

async function readFiles(files, isPortfolio = false) {
  if (!files.length) return;
  if (!isPortfolio) {
    const file = files[0];
    if (files.length !== 1 || !file.name.toLowerCase().endsWith('.csv')) {
      toast('Choose one CSV statement file. PDF and image extraction is not supported.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) { toast('CSV files must be 2 MB or smaller.'); return; }
    await showTransactions(file);
    return;
  }
  let rows = [], names = [];

  for (const file of files) {
    names.push(file.name);
    if (file.name.toLowerCase().endsWith('.csv')) {
      const text = await file.text();
      rows.push(...(isPortfolio ? parsePortfolioCSV(text, file.name) : parseCSV(text).map(t => ({ ...t, source: file.name }))));
    } else if (isPortfolio) {
      rows.push({
        kind: /sip|mutual|fund/i.test(file.name) ? 'Mutual funds' : 'Stocks',
        file: file.name,
        value: 0,
        asOf: new Date().toISOString().slice(0, 10),
        manual: true
      });
    } else {
      rows.push({
        date: new Date().toISOString().slice(0, 10),
        description: `Review screenshot: ${file.name}`,
        category: 'Needs review',
        amount: 0,
        type: 'expense',
        source: file.name,
        manual: true
      });
    }
  }

  staged = rows;
  if (isPortfolio) {
    showPortfolio(names);
  } else {
    showTransactions(names);
  }
}

async function showTransactions(file) {
  const dialog = document.querySelector('#review-dialog');
  const content = document.querySelector('#review-content');
  const title = document.querySelector('#dialog-title');
  const desc = document.querySelector('#dialog-description');
  const accSelect = document.querySelector('#import-account-select');
  const bktSelect = document.querySelector('#import-bucket-select');
  const confirmBtn = document.querySelector('#confirm-import');
  title.textContent = 'Analyzing statement';
  desc.textContent = 'Reading and checking the statement locally before anything is saved.';
  content.innerHTML = '<div class="review-empty">Analyzing CSV rows…</div>';
  if (currentSummary) {
    accSelect.innerHTML = (currentSummary.accounts || []).map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    bktSelect.innerHTML = (currentSummary.buckets || []).map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  }
  confirmBtn.textContent = 'Confirm import';
  confirmBtn.disabled = true;
  dialog.showModal();
  try {
    const analyzed = await api('/import/preview', {
      method: 'POST',
      body: JSON.stringify({ csv: await file.text(), accountId: accSelect.value, bucketId: bktSelect.value })
    });
    staged = analyzed.rows || [];
    const summary = analyzed.summary || {};
    const investmentData = await api('/investments').catch(() => ({ investments: [] }));
    const investmentOptions = investmentData.investments || [];
    const lendingData = await api('/lending').catch(() => ({ records: [] }));
    const lendingOptions = lendingData.records || [];
    title.textContent = 'Review statement';
    desc.textContent = 'Resolve every unclear row before confirming. Exact duplicates are always skipped; likely matches need your decision.';
    content.innerHTML = `
      <div class="review-meta"><strong>${esc(file.name)}</strong><br>
        ${summary.totalRows} rows · ${summary.newCount} new · ${summary.exactDuplicateCount} exact duplicates · ${summary.likelyDuplicateCount} likely duplicates · ${summary.ambiguousCount} ambiguous · ${summary.invalidCount} invalid<br>
        Income ${money(summary.incomeTotal)} · Expenses ${money(summary.expenseTotal)} · Transfers detected ${money(summary.transferValue)} · Investment rows ${money(summary.investmentValue)} · Lending rows ${money(summary.lendingValue)}
      </div>
      <div style="max-height:380px;overflow:auto"><table class="review-table"><thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Type / category</th><th>Status</th></tr></thead><tbody>
      ${staged.map((r,i)=>`<tr data-import-row="${i}" class="${r.status==='duplicate'?'duplicate-row':''}">
        <td><input aria-label="Date" type="date" value="${esc(r.date)}" ${r.status==='invalid'?'':''}></td>
        <td><input aria-label="Description" value="${esc(r.description)}"></td>
        <td><input aria-label="Amount" type="number" min="0" step="0.01" value="${Number(r.amount)||''}"></td>
        <td><select aria-label="Transaction type" ${r.status==='duplicate'?'disabled':''}><option value="">Resolve…</option><option value="income" ${r.type==='income'?'selected':''}>Income</option><option value="expense" ${r.type==='expense'?'selected':''}>Expense</option><option value="transfer_account">Account transfer</option><option value="investment_contribution">Investment contribution</option><option value="lending_new">New lending / borrowing</option><option value="lending_repayment">Loan repayment</option><option value="skip">Skip row</option></select><input data-category aria-label="Category" placeholder="Category" value="${esc(r.category||'')}" ${r.status==='duplicate'?'disabled':''}><select data-transfer-direction aria-label="Transfer direction"><option value="">Transfer direction…</option><option value="out">Out of target account</option><option value="in">Into target account</option></select><select data-transfer-account aria-label="Counterpart account"><option value="">Choose counterpart…</option>${(currentSummary?.accounts||[]).filter(a=>a.id!==accSelect.value).map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select><select data-investment aria-label="Investment holding"><option value="">Choose holding…</option>${investmentOptions.map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select><select data-lending-direction aria-label="Lending direction"><option value="">Choose lend or borrow…</option><option value="lent">Money I lent</option><option value="borrowed">Money I borrowed</option></select><input data-lending-person aria-label="Person name" placeholder="Person name"><select data-lending-record aria-label="Existing loan"><option value="">Choose active loan…</option>${lendingOptions.filter(a=>a.status==='active').map(a=>`<option value="${esc(a.id)}">${esc(a.type==='lent'?'Lent to':'Borrowed from')} ${esc(a.person_name)} · ${money(a.outstanding_amount)}</option>`).join('')}</select></td>
        <td class="review-status ${r.status==='duplicate'||r.status==='likely_duplicate'?'duplicate':''}">${esc(r.status==='ambiguous'?`Needs resolution · ${r.reason||'choose a type and category'}`:r.status==='likely_duplicate'?'Likely duplicate · review':r.status==='duplicate'?'Exact match · review':r.status==='invalid'?`Invalid · ${r.reason}`:'New')}${r.status==='likely_duplicate'?'<label class="likely-include"><input type="checkbox"> Import if this is a legitimate repeat</label>':''}${r.status==='duplicate'?'<label class="likely-include"><input type="checkbox"> Import if this is a legitimate repeat</label>':''}</td>
      </tr>`).join('')}
      </tbody></table></div>`;
    content.querySelectorAll('[data-import-row]').forEach(tr=>{
      const typeSelect=tr.querySelector('[aria-label="Transaction type"]');
      const updateTypeFields=()=>{
        tr.querySelector('[data-category]').hidden=typeSelect.value==='transfer_account'||typeSelect.value==='investment_contribution'||typeSelect.value==='skip';
        tr.querySelector('[data-transfer-direction]').hidden=typeSelect.value!=='transfer_account';
        tr.querySelector('[data-transfer-account]').hidden=typeSelect.value!=='transfer_account';
        tr.querySelector('[data-investment]').hidden=typeSelect.value!=='investment_contribution';
        tr.querySelector('[data-lending-direction]').hidden=typeSelect.value!=='lending_new';
        tr.querySelector('[data-lending-person]').hidden=typeSelect.value!=='lending_new';
        tr.querySelector('[data-lending-record]').hidden=typeSelect.value!=='lending_repayment';
      };
      typeSelect.addEventListener('change',updateTypeFields); updateTypeFields();
    });
    confirmBtn.disabled = false;
    confirmBtn.onclick = async e => {
      e.preventDefault();
      const rows = [];
      let unresolved = false;
      content.querySelectorAll('[data-import-row]').forEach(tr => {
        const original = staged[Number(tr.dataset.importRow)];
        if (original.status === 'invalid') return;
        const [dateEl, descEl, amountEl, typeEl, categoryEl] = tr.querySelectorAll('input,select');
        const type = typeEl.value;
        if (type === 'skip') return;
        if (!type || !dateEl.value || !descEl.value.trim() || !(Number(amountEl.value)>0) || (['income','expense'].includes(type) && !categoryEl.value.trim()) || (type==='transfer_account' && (!tr.querySelector('[data-transfer-direction]').value || !tr.querySelector('[data-transfer-account]').value)) || (type==='investment_contribution' && !tr.querySelector('[data-investment]').value) || (type==='lending_new' && (!tr.querySelector('[data-lending-direction]').value || !tr.querySelector('[data-lending-person]').value.trim())) || (type==='lending_repayment' && !tr.querySelector('[data-lending-record]').value)) { unresolved = true; return; }
        const allowRepeat = original.status==='likely_duplicate' || original.status==='duplicate';
        if (allowRepeat && !tr.querySelector('input[type="checkbox"]')?.checked) return;
        rows.push({date:dateEl.value, description:descEl.value, amount:Number(amountEl.value), type, category:categoryEl.value.trim(), transferDirection:tr.querySelector('[data-transfer-direction]').value, transferAccountId:tr.querySelector('[data-transfer-account]').value, investmentId:tr.querySelector('[data-investment]').value, lendingDirection:tr.querySelector('[data-lending-direction]').value, personName:tr.querySelector('[data-lending-person]').value, lendingId:tr.querySelector('[data-lending-record]').value, allowLikelyDuplicate:original.status==='likely_duplicate' && allowRepeat, allowDuplicate:original.status==='duplicate' && allowRepeat});
      });
      if (unresolved) { toast('Resolve the type, category, date, description, and amount for each row you want to import.'); return; }
      if (!rows.length) { toast('No resolved rows selected for import. Nothing was added.'); dialog.close(); return; }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Importing…';
      try {
        const result = await api('/import/commit', {method:'POST', body:JSON.stringify({rows,accountId:accSelect.value,bucketId:bktSelect.value})});
        title.textContent = 'Import complete';
        confirmBtn.disabled = true;
        toast(`${result.imported} transactions imported; ${result.skipped} exact duplicates skipped.`);
        await refreshDashboard();
        dialog.close();
      } catch (err) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm import';
        toast(`Import failed: ${err.message}`);
      }
    };
  } catch (err) {
    title.textContent = 'Statement could not be analyzed';
    desc.textContent = err.message;
    content.innerHTML = '<div class="review-empty">Nothing has been saved. Choose a valid CSV statement to try again.</div>';
    confirmBtn.disabled = true;
  }
}

function showPortfolio(names) {
  const dialog = document.querySelector('#review-dialog');
  const content = document.querySelector('#review-content');
  const title = document.querySelector('#dialog-title');
  const desc = document.querySelector('#dialog-description');

  title.textContent = 'Update portfolio';
  desc.textContent = 'Add or verify current values for stocks or mutual funds. This records a dated snapshot.';

  content.innerHTML = `
    <div class="review-meta">${names.map(esc).join(' · ')} — portfolio valuation snapshot.</div>
    <div class="portfolio-form">
      ${staged.map((p, i) => `
        <label>Portfolio type
          <select data-kind="${i}">
            <option ${p.kind === 'Stocks' ? 'selected' : ''}>Stocks</option>
            <option ${p.kind === 'Mutual funds' ? 'selected' : ''}>Mutual funds</option>
            <option ${p.kind === 'Other' ? 'selected' : ''}>Other</option>
          </select>
        </label>
        <label>Current Value (₹)
          <input data-value="${i}" type="number" min="0" step="0.01" value="${p.value || ''}" placeholder="Enter current value">
        </label>
        <label>As of date
          <input data-asof="${i}" type="date" value="${esc(p.asOf)}">
        </label>
        <label>Upload Source
          <input value="${esc(p.file || 'CSV Portfolio')}" disabled>
        </label>
      `).join('')}
    </div>
  `;

  const confirmBtn = document.querySelector('#confirm-import');
  confirmBtn.textContent = 'Save portfolio snapshot';
  confirmBtn.onclick = async e => {
    e.preventDefault();
    let count = 0;
    for (let i = 0; i < staged.length; i++) {
      const val = Number(content.querySelector(`[data-value="${i}"]`).value);
      const kind = content.querySelector(`[data-kind="${i}"]`).value;
      const asOf = content.querySelector(`[data-asof="${i}"]`).value;
      if (val > 0 && asOf) {
        await api('/portfolio', {
          method: 'POST',
          body: JSON.stringify({ kind, value: val, asOf, source: staged[i].file || 'upload' })
        });
        count++;
      }
    }
    toast(`${count} portfolio snapshot${count === 1 ? '' : 's'} saved.`);
    dialog.close();
    await refreshDashboard();
  };

  dialog.showModal();
}

// Legacy LocalStorage Migration Flow
async function checkAndMigrateLegacyData() {
  if (localStorage.getItem(MIGRATED_KEY)) return;
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;

  let legacy;
  try {
    legacy = JSON.parse(raw);
  } catch {
    return;
  }

  if (!legacy || (!legacy.transactions?.length && !legacy.portfolio?.length)) return;

  try {
    const res = await api('/migrate', {
      method: 'POST',
      body: JSON.stringify(legacy)
    });

    if (res.success && (res.migratedTransactions > 0 || res.migratedPortfolio > 0)) {
      toast(`Migrated ${res.migratedTransactions} legacy transactions & ${res.migratedPortfolio} portfolio records!`);
      localStorage.setItem(MIGRATED_KEY, 'true');
      const refreshed = await api('/summary');
      renderSummary(refreshed);
    }
  } catch (err) {
    console.warn('Migration attempt postponed:', err);
  }
}

// Auth Dialog Logic
let isRegisterMode = false;
function openAuthDialog(forceRegister = false) {
  isRegisterMode = forceRegister;
  const dialog = document.querySelector('#auth-dialog');
  const userView = document.querySelector('#auth-user-view');
  const formView = document.querySelector('#auth-form-view');

  if (currentUser) {
    userView.style.display = 'block';
    formView.style.display = 'none';
    document.querySelector('#auth-title').textContent = 'Account Profile';
    document.querySelector('#auth-logged-in-msg').innerHTML = `
      Logged in as <strong>${esc(currentUser.name)}</strong> (${esc(currentUser.email)})<br>
      <span style="color:var(--muted);font-size:11px">Session is active on this device.</span>
    `;
  } else {
    userView.style.display = 'none';
    formView.style.display = 'block';
    toggleAuthMode(isRegisterMode);
  }

  dialog.showModal();
}

function toggleAuthMode(register) {
  isRegisterMode = register;
  const title = document.querySelector('#auth-title');
  const submitBtn = document.querySelector('#auth-submit-btn');
  const switchText = document.querySelector('#auth-switch-text');
  const toggleLink = document.querySelector('#auth-toggle-mode');
  const nameGroup = document.querySelector('#name-group');
  const mottoGroup = document.querySelector('#motto-group');

  if (isRegisterMode) {
    title.textContent = 'Create your WellnessCFO account';
    submitBtn.textContent = 'Create account';
    switchText.textContent = 'Already have an account?';
    toggleLink.textContent = 'Log in';
    nameGroup.style.display = 'grid';
    mottoGroup.style.display = 'grid';
    document.querySelector('#auth-name').required = true;
  } else {
    title.textContent = 'Log in to WellnessCFO';
    submitBtn.textContent = 'Log in';
    switchText.textContent = "Don't have an account?";
    toggleLink.textContent = 'Create account';
    nameGroup.style.display = 'none';
    mottoGroup.style.display = 'none';
    document.querySelector('#auth-name').required = false;
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.querySelector('#auth-email').value.trim();
  const password = document.querySelector('#auth-password').value;
  const name = document.querySelector('#auth-name').value.trim();
  const motto = document.querySelector('#auth-motto').value.trim();

  try {
    let res;
    if (isRegisterMode) {
      res = await api('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password, name, motto })
      });
    } else {
      res = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
    }

    localStorage.setItem(TOKEN_KEY, res.token);
    currentUser = res.user;
    updateAuthUI();
    document.querySelector('#auth-dialog').close();
    toast(`Welcome, ${currentUser.name}`);
    await refreshDashboard();
  } catch (err) {
    toast(`Authentication error: ${err.message}`);
  }
}

async function handleDemoLogin() {
  try {
    let res;
    try {
      res = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'demo@wellnesscfo.com', password: 'Password123!' })
      });
    } catch {
      res = await api('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          email: 'demo@wellnesscfo.com',
          password: 'Password123!',
          name: 'Personal CFO User',
          motto: 'Peace of mind with money'
        })
      });
    }

    localStorage.setItem(TOKEN_KEY, res.token);
    currentUser = res.user;
    updateAuthUI();
    document.querySelector('#auth-dialog').close();
    toast('Logged into Demo Account');
    await refreshDashboard();
  } catch (err) {
    toast(`Demo login failed: ${err.message}`);
  }
}

async function handleLogout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {}
  localStorage.removeItem(TOKEN_KEY);
  currentUser = null;
  updateAuthUI();
  document.querySelector('#auth-dialog').close();
  toast('Logged out successfully');
  await refreshDashboard();
}

// ==========================================
// Phase 4: Advanced Finance Layer Implementation
// ==========================================

let investmentHoldings = [];
let lendingRecords = [];
let splitExpenses = [];
let calendarEvents = [];
let recurringCommitments = [];

function populatePhase4Selectors() {
  if (!currentSummary) return;
  const accounts = currentSummary.accounts || [];
  const buckets = currentSummary.buckets || [];

  const accOptions = accounts.map(a => `<option value="${a.id}">${esc(a.name)} (${money(a.balance)})</option>`).join('');
  const bktOptions = buckets.map(b => `<option value="${b.id}">${esc(b.name)} (${money(b.balance)})</option>`).join('');

  ['#holding-account-select', '#htx-account-select', '#loan-account-select', '#repay-account-select', '#split-account-select', '#rec-account-select'].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) {
      const prev = el.value;
      el.innerHTML = `<option value="">Default / Cash Account</option>` + accOptions;
      if (prev) el.value = prev;
    }
  });

  const recBktEl = document.querySelector('#rec-bucket-select');
  if (recBktEl) {
    const prev = recBktEl.value;
    recBktEl.innerHTML = `<option value="">Default Bucket</option>` + bktOptions;
    if (prev) recBktEl.value = prev;
  }

  const htxHoldEl = document.querySelector('#htx-holding-select');
  if (htxHoldEl) {
    const prev = htxHoldEl.value;
    htxHoldEl.innerHTML = investmentHoldings.map(h => `<option value="${h.id}">${esc(h.name)} (${esc(h.symbol || h.asset_type)})</option>`).join('');
    if (prev) htxHoldEl.value = prev;
  }
}

// ------------------------------------------
// 1. Investments
// ------------------------------------------
async function loadInvestments() {
  if (!currentUser) return;
  try {
    const res = await api('/investments');
    investmentHoldings = res.holdings || [];
    renderInvestmentsList();
    populatePhase4Selectors();
  } catch (err) {
    console.warn('Investments load failed:', err);
  }
}

function renderInvestmentsList() {
  const container = document.querySelector('#holdings-container');
  if (!container) return;

  if (!investmentHoldings.length) {
    container.innerHTML = '<div class="empty-cfo-state"><span>◉</span>No investment holdings recorded yet. Add your stocks, mutual funds, or ETFs.</div>';
    return;
  }

  const rows = investmentHoldings.map(h => {
    const pl = (h.current_value || 0) - (h.invested_amount || 0);
    const plPct = h.invested_amount > 0 ? ((pl / h.invested_amount) * 100).toFixed(1) : '0.0';
    const plClass = pl >= 0 ? 'color:var(--sage-dark);font-weight:600' : 'color:var(--rose);font-weight:600';
    const sipBadge = h.is_sip ? `<span class="type-badge" style="background:#eaf2e8;color:#35673d" title="₹${h.sip_amount}/mo">SIP Active</span>` : '<span style="color:var(--muted);font-size:10px">—</span>';

    return `
      <tr>
        <td>
          <div style="font-weight:600;font-size:12px;color:var(--ink)">${esc(h.name)}</div>
          <small style="font-size:10px;color:var(--muted)">${esc(h.symbol || '—')}</small>
        </td>
        <td><span class="type-badge">${esc(h.asset_type.replace('_', ' '))}</span></td>
        <td style="font-size:11px">${Number(h.units || 0).toLocaleString('en-IN', { maximumFractionDigits: 4 })}</td>
        <td style="font-size:11px">${money(h.avg_buy_price || 0)}</td>
        <td style="font-size:11px">${money(h.invested_amount || 0)}</td>
        <td style="font-weight:600;font-size:12px">${money(h.current_value || 0)}</td>
        <td style="${plClass};font-size:11px">
          ${pl >= 0 ? '+' : ''}${money(pl)} <small style="font-size:9px">(${pl >= 0 ? '+' : ''}${plPct}%)</small>
        </td>
        <td>${sipBadge}</td>
        <td style="white-space:nowrap">
          <button class="tx-action-btn" title="Record Movement" onclick="openHoldingTxModal('${h.id}')">⇄</button>
          <button class="tx-action-btn" title="Edit" onclick="editHolding('${h.id}')">✎</button>
          <button class="tx-action-btn delete" title="Delete" onclick="deleteHolding('${h.id}')">✕</button>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="holdings-table" style="width:100%;border-collapse:collapse;font-size:11px">
      <thead>
        <tr>
          <th>Holding / Security</th>
          <th>Class</th>
          <th>Units</th>
          <th>Avg Buy</th>
          <th>Invested</th>
          <th>Current Value</th>
          <th>P&L (Return)</th>
          <th>SIP</th>
          <th style="text-align:right">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function openHoldingModal(id = null) {
  const dialog = document.querySelector('#holding-dialog');
  const form = document.querySelector('#holding-form');
  if (!dialog || !form) return;
  form.reset();

  const idInput = document.querySelector('#edit-holding-id');
  const title = document.querySelector('#holding-dialog-title');
  const sipGrp = document.querySelector('#holding-sip-group');
  if (sipGrp) sipGrp.style.display = 'none';

  if (id) {
    const h = investmentHoldings.find(x => x.id === id);
    if (!h) return;
    title.textContent = 'Edit Holding';
    idInput.value = h.id;
    document.querySelector('#holding-name-input').value = h.name || '';
    document.querySelector('#holding-symbol-input').value = h.symbol || '';
    document.querySelector('#holding-type-input').value = h.asset_type || 'mutual_fund';
    document.querySelector('#holding-qty-input').value = h.units || 0;
    document.querySelector('#holding-buy-price-input').value = h.avg_buy_price || 0;
    document.querySelector('#holding-curr-price-input').value = h.current_price || h.avg_buy_price || 0;
    document.querySelector('#holding-account-select').value = h.account_id || '';
    const sipChk = document.querySelector('#holding-is-sip-input');
    sipChk.checked = !!h.is_sip;
    if (sipGrp) sipGrp.style.display = sipChk.checked ? 'grid' : 'none';
    document.querySelector('#holding-sip-amount-input').value = h.sip_amount || '';
  } else {
    title.textContent = 'New Holding';
    idInput.value = '';
  }
  populatePhase4Selectors();
  dialog.showModal();
}

function openHoldingTxModal(holdingId = null) {
  const dialog = document.querySelector('#holding-tx-dialog');
  const form = document.querySelector('#holding-tx-form');
  if (!dialog || !form) return;
  form.reset();

  populatePhase4Selectors();
  if (holdingId) {
    document.querySelector('#htx-holding-select').value = holdingId;
  }
  document.querySelector('#htx-date-input').value = new Date().toISOString().slice(0, 10);
  dialog.showModal();
}

async function editHolding(id) {
  openHoldingModal(id);
}

async function deleteHolding(id) {
  if (!confirm('Are you sure you want to delete this holding?')) return;
  try {
    await api(`/investments/${id}`, { method: 'DELETE' });
    toast('Holding deleted');
    await refreshDashboard();
  } catch (err) {
    toast(err.message || 'Failed to delete holding');
  }
}

// ------------------------------------------
// 2. Lending & Borrowing
// ------------------------------------------
async function loadLending() {
  if (!currentUser) return;
  try {
    const res = await api('/lending');
    lendingRecords = res.records || [];
    renderLendingList(res.summary);
  } catch (err) {
    console.warn('Lending load failed:', err);
  }
}

function renderLendingList(summary = {}) {
  const container = document.querySelector('#lending-list');
  const statsEl = document.querySelector('#lending-stats-summary');
  if (statsEl) {
    statsEl.textContent = `Receivables: ${money(summary.totalLent || 0)} · Payables: ${money(summary.totalBorrowed || 0)}`;
  }
  if (!container) return;

  if (!lendingRecords.length) {
    container.innerHTML = '<div class="empty-cfo-state" style="grid-column:1/-1"><span>⇄</span>No active loans or advances. Record money lent to or borrowed from people.</div>';
    return;
  }

  container.innerHTML = lendingRecords.map(r => {
    const isLent = r.type === 'lent';
    const isSettled = r.status === 'settled';
    const badgeBg = isLent ? '#edf2e9' : '#faeceb';
    const badgeColor = isLent ? 'var(--sage-dark)' : 'var(--rose)';
    const typeLabel = isLent ? 'Lent (Receivable)' : 'Borrowed (Payable)';
    const originalAmount = Number(r.total_amount ?? r.amount) || 0;
    const repaid = originalAmount - (r.outstanding_amount || 0);

    return `
      <div class="lending-card ${isLent ? 'lent' : 'borrowed'}">
        <div class="lending-card-top">
          <div>
            <span class="type-badge" style="background:${badgeBg};color:${badgeColor}">${typeLabel}</span>
            <div class="lending-person" style="margin-top:6px">${esc(r.person_name)}</div>
          </div>
          <span class="type-badge" style="background:#f4f3ed;color:var(--muted)">${esc(r.status.toUpperCase())}</span>
        </div>
        <div class="lending-amount">${money(r.outstanding_amount)} <small style="font-size:11px;color:var(--muted);font-weight:400">outstanding of ${money(originalAmount)}</small></div>
        ${repaid > 0 ? `<div style="font-size:10px;color:var(--sage-dark)">Repaid so far: ${money(repaid)}</div>` : ''}
        <div class="lending-meta">
          <span>Date: ${esc(r.date)}</span>
          ${r.due_date ? `<span>Due: ${esc(r.due_date)}</span>` : '<span>No due date</span>'}
        </div>
        ${r.notes ? `<div style="font-size:10px;color:var(--muted);margin-top:4px;font-style:italic">"${esc(r.notes)}"</div>` : ''}
        <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px;padding-top:8px;border-top:1px solid #f2f1ea">
          ${!isSettled ? `
            <button class="outline-btn" style="padding:4px 8px;font-size:10px" onclick="openRepayModal('${r.id}')">Record Repayment</button>
          ` : '<span style="font-size:10px;color:var(--sage-dark);font-weight:600">Fully Settled ✓</span>'}
        </div>
      </div>
    `;
  }).join('');
}

function openLendingModal() {
  const dialog = document.querySelector('#lending-dialog');
  const form = document.querySelector('#lending-form');
  if (!dialog || !form) return;
  form.reset();
  populatePhase4Selectors();
  document.querySelector('#loan-date-input').value = new Date().toISOString().slice(0, 10);
  dialog.showModal();
}

function openRepayModal(loanId) {
  const dialog = document.querySelector('#repayment-dialog');
  const form = document.querySelector('#repayment-form');
  if (!dialog || !form) return;
  form.reset();

  const record = lendingRecords.find(r => r.id === loanId);
  if (!record) return;

  document.querySelector('#repay-loan-id').value = record.id;
  const isLent = record.type === 'lent';
  document.querySelector('#repay-loan-details').innerHTML = `
    <strong>${isLent ? 'Repayment from' : 'Repayment to'}: ${esc(record.person_name)}</strong><br>
    Outstanding: <strong>${money(record.outstanding_amount)}</strong> (Original: ${money(record.total_amount ?? record.amount)})
  `;
  document.querySelector('#repay-amount-input').value = record.outstanding_amount;
  document.querySelector('#repay-date-input').value = new Date().toISOString().slice(0, 10);
  populatePhase4Selectors();
  dialog.showModal();
}

// ------------------------------------------
// 3. Split Expenses
// ------------------------------------------
async function loadSplits() {
  if (!currentUser) return;
  try {
    const res = await api('/splits');
    splitExpenses = res.splits || [];
    renderSplitsList();
  } catch (err) {
    console.warn('Splits load failed:', err);
  }
}

function renderSplitsList() {
  const container = document.querySelector('#splits-list');
  if (!container) return;

  if (!splitExpenses.length) {
    container.innerHTML = '<div class="empty-cfo-state" style="grid-column:1/-1"><span>☲</span>No split expenses recorded yet.</div>';
    return;
  }

  container.innerHTML = splitExpenses.map(s => {
    const participants = s.participants || [];
    const partsHtml = participants.map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:11px">
        <span>${esc(p.name)}: <strong>${money(p.share_amount)}</strong></span>
        ${p.is_settled ? `
          <span class="type-badge" style="background:#e7f3e8;color:#35673d">Settled</span>
        ` : `
          <button class="outline-btn" style="padding:2px 6px;font-size:9px" onclick="settleParticipant('${s.id}', '${p.id}')">Settle</button>
        `}
      </div>
    `).join('');

    return `
      <div class="split-card">
        <div class="split-card-top">
          <div>
            <div style="font-weight:600;font-size:13px">${esc(s.description)}</div>
            <small style="font-size:10px;color:var(--muted)">${esc(s.date)} · ${esc(s.category)}</small>
          </div>
          <span class="type-badge">${esc(s.status.toUpperCase())}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin:10px 0 6px">
          <div><small style="color:var(--muted);font-size:10px">Total bill</small><div style="font:700 15px Manrope">${money(s.total_amount)}</div></div>
          <div style="text-align:right"><small style="color:var(--sage-dark);font-size:10px;font-weight:600">Your Share</small><div style="font:700 15px Manrope;color:var(--sage-dark)">${money(s.my_share)}</div></div>
        </div>
        <div style="margin-top:8px;border-top:1px solid #f2f1ea;padding-top:6px">
          <small style="font-size:10px;font-weight:600;color:var(--muted)">Participants (${participants.length})</small>
          <div style="margin-top:4px">${partsHtml}</div>
        </div>
      </div>
    `;
  }).join('');
}

function openSplitModal() {
  const dialog = document.querySelector('#split-dialog');
  const form = document.querySelector('#split-form');
  if (!dialog || !form) return;
  form.reset();
  populatePhase4Selectors();
  document.querySelector('#split-date-input').value = new Date().toISOString().slice(0, 10);
  dialog.showModal();
}

async function settleParticipant(splitId, participantId) {
  try {
    await api('/splits/settle', {
      method: 'POST',
      body: JSON.stringify({ split_expense_id: splitId, participant_id: participantId })
    });
    toast('Participant settled');
    await refreshDashboard();
  } catch (err) {
    toast(err.message || 'Settlement failed');
  }
}

// ------------------------------------------
// 4. Financial Calendar & Timeline
// ------------------------------------------
async function loadCalendar() {
  if (!currentUser) return;
  try {
    const res = await api('/calendar?days=45');
    calendarEvents = res.events || [];
    renderCalendarTimeline();
  } catch (err) {
    console.warn('Calendar load failed:', err);
  }
}

function renderCalendarTimeline() {
  const container = document.querySelector('#calendar-timeline');
  if (!container) return;

  if (!calendarEvents.length) {
    container.innerHTML = '<div class="empty-cfo-state"><span>◷</span>No upcoming commitments scheduled in the next 45 days.</div>';
    return;
  }

  container.innerHTML = calendarEvents.map(e => {
    const d = new Date(e.date + 'T00:00:00');
    const monthStr = isNaN(d.getTime()) ? 'DATE' : d.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase();
    const dayStr = isNaN(d.getTime()) ? '—' : d.getDate();

    let typeBadge = '';
    if (e.type === 'recurring') typeBadge = '<span class="type-badge">Recurring</span>';
    else if (e.type === 'loan_due') typeBadge = '<span class="type-badge" style="background:#faeceb;color:var(--rose)">Loan Due</span>';
    else if (e.type === 'goal_deadline') typeBadge = '<span class="type-badge" style="background:#fdf6e7;color:#855e24">Goal Target</span>';

    return `
      <div class="timeline-item">
        <div class="timeline-date-badge">
          <span>${monthStr}</span>
          <span style="font-size:14px">${dayStr}</span>
        </div>
        <div class="timeline-item-body">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="timeline-item-title">${esc(e.title)}</span>
            ${typeBadge}
          </div>
          <div class="timeline-item-sub">${esc(e.category)} · ${esc(e.date)}</div>
        </div>
        <div class="timeline-item-amount">${money(e.amount)}</div>
        ${e.type === 'recurring' && e.source_id ? `
          <button class="primary" style="padding:5px 9px;font-size:10px;white-space:nowrap" onclick="postRecurringOccurrence('${e.source_id}')">Post to Ledger</button>
        ` : ''}
      </div>
    `;
  }).join('');
}

async function postRecurringOccurrence(recurringId) {
  try {
    await api('/calendar/post-occurrence', {
      method: 'POST',
      body: JSON.stringify({ recurring_id: recurringId })
    });
    toast('Recorded in ledger and advanced next date');
    await refreshDashboard();
  } catch (err) {
    toast(err.message || 'Failed to post occurrence');
  }
}

// ------------------------------------------
// 5. Recurring Commitments Manager
// ------------------------------------------
async function loadRecurring() {
  if (!currentUser) return;
  try {
    const res = await api('/recurring');
    recurringCommitments = res.commitments || [];
    renderRecurringList();
  } catch (err) {
    console.warn('Recurring load failed:', err);
  }
}

function renderRecurringList() {
  const container = document.querySelector('#recurring-list');
  if (!container) return;

  if (!recurringCommitments.length) {
    container.innerHTML = '<div class="empty-cfo-state"><span>◷</span>No recurring rules configured.</div>';
    return;
  }

  container.innerHTML = recurringCommitments.map(c => `
    <div style="background:#fdfcf9;border:1px solid #e9ece4;border-radius:8px;padding:11px 13px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:600;font-size:12px;color:var(--ink)">${esc(c.name)}</div>
        <small style="font-size:10px;color:var(--muted)">${esc(c.frequency)} · Next: ${esc(c.next_expected_date)}</small>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <div style="font:700 13px Manrope;color:var(--ink)">${money(c.expected_amount)}</div>
        <button class="tx-action-btn ${c.is_active ? '' : 'delete'}" title="Toggle Active" onclick="toggleRecurringActive('${c.id}', ${c.is_active ? 0 : 1})">
          ${c.is_active ? '●' : '○'}
        </button>
        <button class="tx-action-btn delete" title="Delete" onclick="deleteRecurring('${c.id}')">✕</button>
      </div>
    </div>
  `).join('');
}

function openRecurringModal(id = null) {
  const dialog = document.querySelector('#recurring-dialog');
  const form = document.querySelector('#recurring-form');
  if (!dialog || !form) return;
  form.reset();

  const idInput = document.querySelector('#edit-recurring-id');
  const title = document.querySelector('#recurring-dialog-title');

  if (id) {
    const c = recurringCommitments.find(x => x.id === id);
    if (!c) return;
    title.textContent = 'Edit Recurring Commitment';
    idInput.value = c.id;
    document.querySelector('#rec-name-input').value = c.name || '';
    document.querySelector('#rec-type-select').value = c.type || 'expense';
    document.querySelector('#rec-category-input').value = c.category || '';
    document.querySelector('#rec-amount-input').value = c.expected_amount || '';
    document.querySelector('#rec-freq-select').value = c.frequency || 'monthly';
    document.querySelector('#rec-date-input').value = c.next_expected_date || '';
    document.querySelector('#rec-account-select').value = c.account_id || '';
    document.querySelector('#rec-bucket-select').value = c.bucket_id || '';
  } else {
    title.textContent = 'New Recurring Commitment';
    idInput.value = '';
    document.querySelector('#rec-date-input').value = new Date().toISOString().slice(0, 10);
  }
  populatePhase4Selectors();
  dialog.showModal();
}

async function toggleRecurringActive(id, newStatus) {
  try {
    await api(`/recurring/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_active: !!newStatus })
    });
    toast(newStatus ? 'Recurring rule activated' : 'Recurring rule paused');
    await refreshDashboard();
  } catch (err) {
    toast(err.message || 'Update failed');
  }
}

async function deleteRecurring(id) {
  if (!confirm('Delete this recurring commitment?')) return;
  try {
    await api(`/recurring/${id}`, { method: 'DELETE' });
    toast('Recurring commitment deleted');
    await refreshDashboard();
  } catch (err) {
    toast(err.message || 'Delete failed');
  }
}

// Initial Setup
function initApp() {
  // Modal buttons
  document.querySelector('#open-record-modal-btn')?.addEventListener('click', () => openRecordModal('income'));
  document.querySelector('#open-transfer-modal-btn')?.addEventListener('click', () => openRecordModal('account-transfer'));
  document.querySelector('#open-bucket-transfer-btn')?.addEventListener('click', () => openRecordModal('bucket-transfer'));
  document.querySelector('#open-acc-transfer-btn')?.addEventListener('click', () => openRecordModal('account-transfer'));
  document.querySelector('#add-account-btn')?.addEventListener('click', openAccountModal);
  document.querySelector('#add-bucket-btn')?.addEventListener('click', () => openBucketModal(null));

  // Forms
  document.querySelector('#tx-form')?.addEventListener('submit', handleSaveTransaction);
  document.querySelector('#account-form')?.addEventListener('submit', handleSaveAccount);
  document.querySelector('#bucket-form')?.addEventListener('submit', handleSaveBucket);

  // Phase 3 Natural Language in Modal
  document.querySelector('#parse-nl-btn')?.addEventListener('click', handleParseNaturalLanguageEntry);
  document.querySelector('#nl-tx-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleParseNaturalLanguageEntry();
    }
  });

  document.querySelector('#toggle-manual-entry')?.addEventListener('click', () => {
    const wrap = document.querySelector('#manual-entry-wrapper');
    if (!wrap) return;
    const isHidden = wrap.style.display === 'none';
    wrap.style.display = isHidden ? 'block' : 'none';
    document.querySelector('#toggle-manual-entry').textContent = isHidden ? 'Hide manual tabs ⌃' : 'Or switch to manual tabs ⌄';
  });

  // Phase 3 AI Command Center
  document.querySelector('#ai-query-btn')?.addEventListener('click', () => handleAIQuerySubmit());
  document.querySelector('#ai-query-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAIQuerySubmit();
    }
  });

  document.querySelectorAll('.ai-prompt-chips .chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.query;
      handleAIQuerySubmit(q);
    });
  });

  // Tab switching in tx modal
  document.querySelectorAll('#tx-tab-nav .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tx-tab-nav .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      renderTxFormFields();
    });
  });

  // Chart Controls
  document.querySelectorAll('.chart-view-btn[data-interval]').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.chart-view-btn[data-interval]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartInterval = btn.dataset.interval;
      await loadAndRenderCharts();
    });
  });

  document.querySelectorAll('.chart-view-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.chart-view-btn[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartView = btn.dataset.view;
      await loadAndRenderCharts();
    });
  });

  // File Inputs
  document.querySelector('#file-input')?.addEventListener('change', e => readFiles([...e.target.files]));
  document.querySelector('#portfolio-input')?.addEventListener('change', e => readFiles([...e.target.files], true));

  // Activity Filter Buttons
  document.querySelectorAll('.filter').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.filter').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter || 'all';
      await loadTransactions();
    });
  });

  document.querySelector('#category-filter')?.addEventListener('change', async e => {
    activeCategory = e.target.value;
    await loadTransactions();
  });

  // Auth Dialog triggers
  document.querySelector('#topbar-profile-btn')?.addEventListener('click', () => openAuthDialog(false));
  document.querySelector('#auth-btn')?.addEventListener('click', () => openAuthDialog(false));
  document.querySelector('#auth-toggle-mode')?.addEventListener('click', () => toggleAuthMode(!isRegisterMode));
  document.querySelector('#auth-form')?.addEventListener('submit', handleAuthSubmit);
  document.querySelector('#demo-login-btn')?.addEventListener('click', handleDemoLogin);
  document.querySelector('#logout-btn')?.addEventListener('click', handleLogout);

  // Phase 4 UI Triggers
  document.querySelector('#add-holding-btn')?.addEventListener('click', () => openHoldingModal());
  document.querySelector('#open-holding-tx-btn')?.addEventListener('click', () => openHoldingTxModal());
  document.querySelector('#holding-is-sip-input')?.addEventListener('change', e => {
    const grp = document.querySelector('#holding-sip-group');
    if (grp) grp.style.display = e.target.checked ? 'grid' : 'none';
  });
  document.querySelector('#holding-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.querySelector('#edit-holding-id').value;
    const body = {
      name: document.querySelector('#holding-name-input').value.trim(),
      symbol: document.querySelector('#holding-symbol-input').value.trim(),
      asset_type: document.querySelector('#holding-type-input').value,
      units: parseFloat(document.querySelector('#holding-qty-input').value) || 0,
      avg_buy_price: parseFloat(document.querySelector('#holding-buy-price-input').value) || 0,
      current_price: parseFloat(document.querySelector('#holding-curr-price-input').value) || parseFloat(document.querySelector('#holding-buy-price-input').value) || 0,
      account_id: document.querySelector('#holding-account-select').value || null,
      is_sip: document.querySelector('#holding-is-sip-input').checked,
      sip_amount: parseFloat(document.querySelector('#holding-sip-amount-input').value) || 0
    };
    try {
      if (id) {
        await api(`/investments/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('Holding updated');
      } else {
        await api('/investments', { method: 'POST', body: JSON.stringify(body) });
        toast('Holding added');
      }
      document.querySelector('#holding-dialog').close();
      await refreshDashboard();
    } catch (err) {
      toast(err.message || 'Failed to save holding');
    }
  });

  document.querySelector('#holding-tx-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      holding_id: document.querySelector('#htx-holding-select').value,
      type: document.querySelector('#htx-type-select').value,
      units: parseFloat(document.querySelector('#htx-qty-input').value) || 0,
      price: parseFloat(document.querySelector('#htx-price-input').value) || 0,
      account_id: document.querySelector('#htx-account-select').value || null,
      date: document.querySelector('#htx-date-input').value,
      notes: document.querySelector('#htx-notes-input').value.trim()
    };
    try {
      await api('/investments/transactions', { method: 'POST', body: JSON.stringify(body) });
      toast('Investment movement recorded');
      document.querySelector('#holding-tx-dialog').close();
      await refreshDashboard();
    } catch (err) {
      toast(err.message || 'Failed to record movement');
    }
  });

  document.querySelector('#open-lending-modal-btn')?.addEventListener('click', openLendingModal);
  document.querySelector('#lending-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      type: document.querySelector('#loan-type-select').value,
      person_name: document.querySelector('#loan-person-input').value.trim(),
      amount: parseFloat(document.querySelector('#loan-amount-input').value) || 0,
      date: document.querySelector('#loan-date-input').value,
      due_date: document.querySelector('#loan-due-date-input').value || null,
      account_id: document.querySelector('#loan-account-select').value || null,
      notes: document.querySelector('#loan-notes-input').value.trim()
    };
    try {
      await api('/lending', { method: 'POST', body: JSON.stringify(body) });
      toast('Loan record saved');
      document.querySelector('#lending-dialog').close();
      await refreshDashboard();
    } catch (err) {
      toast(err.message || 'Failed to record loan');
    }
  });

  document.querySelector('#repayment-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      lending_id: document.querySelector('#repay-loan-id').value,
      amount: parseFloat(document.querySelector('#repay-amount-input').value) || 0,
      date: document.querySelector('#repay-date-input').value,
      account_id: document.querySelector('#repay-account-select').value || null,
      notes: document.querySelector('#repay-notes-input').value.trim()
    };
    try {
      await api('/lending/repayments', { method: 'POST', body: JSON.stringify(body) });
      toast('Repayment recorded');
      document.querySelector('#repayment-dialog').close();
      await refreshDashboard();
    } catch (err) {
      toast(err.message || 'Failed to record repayment');
    }
  });

  document.querySelector('#open-split-modal-btn')?.addEventListener('click', openSplitModal);
  document.querySelector('#split-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const rawParts = document.querySelector('#split-participants-input').value.split(',');
    const participants = [];
    for (const item of rawParts) {
      const parts = item.split(':');
      if (parts.length >= 2) {
        participants.push({
          name: parts[0].trim(),
          share_amount: parseFloat(parts[1].trim()) || 0
        });
      }
    }
    const body = {
      description: document.querySelector('#split-desc-input').value.trim(),
      total_amount: parseFloat(document.querySelector('#split-total-input').value) || 0,
      my_share: parseFloat(document.querySelector('#split-my-share-input').value) || 0,
      account_id: document.querySelector('#split-account-select').value || null,
      date: document.querySelector('#split-date-input').value,
      participants
    };
    try {
      await api('/splits', { method: 'POST', body: JSON.stringify(body) });
      toast('Split expense recorded');
      document.querySelector('#split-dialog').close();
      await refreshDashboard();
    } catch (err) {
      toast(err.message || 'Failed to record split');
    }
  });

  document.querySelector('#add-recurring-btn')?.addEventListener('click', () => openRecurringModal());
  document.querySelector('#recurring-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.querySelector('#edit-recurring-id').value;
    const body = {
      name: document.querySelector('#rec-name-input').value.trim(),
      type: document.querySelector('#rec-type-select').value,
      category: document.querySelector('#rec-category-input').value.trim(),
      expected_amount: parseFloat(document.querySelector('#rec-amount-input').value) || 0,
      frequency: document.querySelector('#rec-freq-select').value,
      next_expected_date: document.querySelector('#rec-date-input').value,
      account_id: document.querySelector('#rec-account-select').value || null,
      bucket_id: document.querySelector('#rec-bucket-select').value || null
    };
    try {
      if (id) {
        await api(`/recurring/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('Recurring commitment updated');
      } else {
        await api('/recurring', { method: 'POST', body: JSON.stringify(body) });
        toast('Recurring commitment created');
      }
      document.querySelector('#recurring-dialog').close();
      await refreshDashboard();
    } catch (err) {
      toast(err.message || 'Failed to save recurring commitment');
    }
  });

  // Start app
  checkAuth().then(() => {
    refreshDashboard();
  });
}

document.addEventListener('DOMContentLoaded', initApp);

// Window exposure for inline onclicks
window.openBucketModal = openBucketModal;
window.deactivateAccount = deactivateAccount;
window.editTransaction = editTransaction;
window.deleteTransactionPrompt = deleteTransactionPrompt;
window.openRecordModal = openRecordModal;
window.confirmCandidateTransaction = confirmCandidateTransaction;
window.cancelCandidateTransaction = cancelCandidateTransaction;
window.expandCandidateToManual = expandCandidateToManual;
window.executeConfirmedAction = executeConfirmedAction;

// Phase 4 Window exposures
window.openHoldingModal = openHoldingModal;
window.openHoldingTxModal = openHoldingTxModal;
window.editHolding = editHolding;
window.deleteHolding = deleteHolding;
window.openRepayModal = openRepayModal;
window.openLendingModal = openLendingModal;
window.openSplitModal = openSplitModal;
window.settleParticipant = settleParticipant;
window.postRecurringOccurrence = postRecurringOccurrence;
window.openRecurringModal = openRecurringModal;
window.toggleRecurringActive = toggleRecurringActive;
window.deleteRecurring = deleteRecurring;
