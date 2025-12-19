import { TEAMS, FOUNDER_SHARE_PCT } from '../config.js';
import { getEntries } from '../entries-state.js';
import {
  fmtPct,
  fmtInt,
  fmtCurr2,
  fmtCurr0,
  formatDateForInput,
  parseAmountInput,
  escapeHtml,
} from '../utils/format.js';
import { getDockPhase } from '../utils/dock-helpers.js';
import { clampDockRewardFactor, DOCK_WEIGHTING_DEFAULT, getEntryRewardFactor } from './calculations.js';
import { showToast } from '../ui/feedback.js';
import { getAnalyticsData, setAnalyticsData, getTrendData, setTrendData } from '../state/analytics-state.js';
import { people } from './people.js';
import { getFrameworkVolume } from './dock-board.js';

const anaYear = document.getElementById('anaYear');
const anaStartDate = document.getElementById('anaStartDate');
const anaEndDate = document.getElementById('anaEndDate');
const btnAnaThisYear = document.getElementById('btnAnaThisYear');
const btnAnaLastYear = document.getElementById('btnAnaLastYear');
const btnAnaRangeRefresh = document.getElementById('btnAnaRangeRefresh');
const anaTogglePersonWeighting = document.getElementById('anaTogglePersonWeighting');
const anaToggleTeamWeighting = document.getElementById('anaToggleTeamWeighting');
const anaMarketTeamFilter = document.getElementById('anaMarketTeamFilter');
const btnAnaXlsx = document.getElementById('btnAnaXlsx');
const trendFromMonth = document.getElementById('trendFromMonth');
const trendToMonth = document.getElementById('trendToMonth');
const btnTrendThisYear = document.getElementById('btnTrendThisYear');
const btnTrendLast12 = document.getElementById('btnTrendLast12');
const btnTrendLoad = document.getElementById('btnTrendLoad');
const btnTrendCsv = document.getElementById('btnTrendCsv');
const btnTrendXlsx = document.getElementById('btnTrendXlsx');
const trendSummary = document.getElementById('trendSummary');
const trendRevenueChart = document.getElementById('trendRevenueChart');
const trendCumulativeChart = document.getElementById('trendCumulativeChart');

let anaPersonWeightingEnabled = false;
let anaTeamWeightingEnabled = false;
let anaMarketTeamOptions = [];

const closeMarketTeamPanel = () => {
  const panel = anaMarketTeamFilter?.querySelector('.multi-select-panel');
  const trigger = anaMarketTeamFilter?.querySelector('.multi-select-trigger');
  panel?.classList.remove('is-open');
  trigger?.classList.remove('is-open');
};

function updateMarketTeamLabel() {
  if (!anaMarketTeamFilter) return;
  const labelEl = anaMarketTeamFilter.querySelector('.multi-select-chip');
  if (!labelEl) return;
  const selected = getSelectedMarketTeams();
  if (!selected.length || selected.length === anaMarketTeamOptions.length) {
    labelEl.textContent = 'Alle Market Teams';
    return;
  }
  if (selected.length <= 2) {
    labelEl.textContent = selected.join(', ');
    return;
  }
  const head = selected.slice(0, 2).join(', ');
  labelEl.textContent = `${head} +${selected.length - 2}`;
}

function populateMarketTeamFilter() {
  if (!anaMarketTeamFilter) return;
  const teams = Array.isArray(TEAMS) ? TEAMS.filter(Boolean) : [];
  anaMarketTeamOptions = teams;
  anaMarketTeamFilter.innerHTML = '';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'multi-select-trigger';
  const label = document.createElement('span');
  label.className = 'multi-select-chip';
  label.textContent = 'Alle Market Teams';
  const caret = document.createElement('span');
  caret.className = 'multi-select-caret';
  trigger.append(label, caret);

  const panel = document.createElement('div');
  panel.className = 'multi-select-panel';

  teams.forEach((team) => {
    const opt = document.createElement('label');
    opt.className = 'multi-select-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = team;
    cb.checked = true;
    const text = document.createElement('span');
    text.textContent = team;
    opt.append(cb, text);
    panel.appendChild(opt);
  });

  trigger.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('is-open');
    trigger.classList.toggle('is-open', isOpen);
  });

  panel.addEventListener('change', (ev) => {
    if (ev.target && ev.target.matches('input[type="checkbox"]')) {
      updateMarketTeamLabel();
      renderContributionCharts();
    }
  });

  anaMarketTeamFilter.append(trigger, panel);
  updateMarketTeamLabel();
}

function getSelectedMarketTeams() {
  if (!anaMarketTeamFilter) return [];
  return Array.from(anaMarketTeamFilter.querySelectorAll('input[type="checkbox"]:checked') || [])
    .map((input) => input.value)
    .filter(Boolean);
}

function getTeamForPerson(person, dateTimestamp) {
  if (!person) return 'Unbekannt';
  const history = Array.isArray(person.teamHistory) ? person.teamHistory : null;
  const saleDate = new Date(dateTimestamp);
  const saleDateString = Number.isNaN(saleDate.getTime())
    ? null
    : saleDate.toISOString().slice(0, 10);

  if (history && saleDateString) {
    for (const entry of history) {
      if (!entry || !entry.until) continue;
      if (saleDateString <= entry.until) {
        return entry.team;
      }
    }
  }

  return person.team || 'Ohne Team';
}

export function initAnalytics() {
  const currentYear = new Date().getFullYear();
  anaYear.innerHTML = '';
  for (let y = 2022; y <= currentYear + 1; y++) {
    const o = document.createElement('option'); o.value = String(y); o.textContent = String(y); anaYear.appendChild(o);
  }
  anaYear.value = String(currentYear);

  populateMarketTeamFilter();
  anaPersonWeightingEnabled = Boolean(anaTogglePersonWeighting?.checked);
  anaTeamWeightingEnabled = Boolean(anaToggleTeamWeighting?.checked);

  setAnaDateRange('thisYear');
  renderAnalytics();
  renderActivityAnalytics();
  initTrendControls();
  renderTrendInsights();
}

function setAnaDateRange(rangeType) {
  const now = new Date();
  let start;
  let end;
  if (rangeType === 'thisYear') {
    start = new Date(now.getFullYear(), 0, 1);
    end = now;
  } else {
    const lastYear = now.getFullYear() - 1;
    start = new Date(lastYear, 0, 1);
    end = new Date(lastYear, 11, 31);
  }
  anaStartDate.value = formatDateForInput(start.getTime());
  anaEndDate.value = formatDateForInput(end.getTime());
}

if (btnAnaThisYear) {
  btnAnaThisYear.addEventListener('click', () => {
    setAnaDateRange('thisYear');
    renderActivityAnalytics();
  });
}
if (btnAnaLastYear) {
  btnAnaLastYear.addEventListener('click', () => {
    setAnaDateRange('lastYear');
    renderActivityAnalytics();
  });
}
btnAnaRangeRefresh?.addEventListener('click', renderActivityAnalytics);

if (anaTogglePersonWeighting) {
  anaTogglePersonWeighting.addEventListener('change', () => {
    anaPersonWeightingEnabled = anaTogglePersonWeighting.checked;
    renderContributionCharts();
  });
}

if (anaToggleTeamWeighting) {
  anaToggleTeamWeighting.addEventListener('change', () => {
    anaTeamWeightingEnabled = anaToggleTeamWeighting.checked;
    renderContributionCharts();
  });
}

document.addEventListener('click', (ev) => {
  if (!anaMarketTeamFilter) return;
  if (anaMarketTeamFilter.contains(ev.target)) return;
  closeMarketTeamPanel();
});

document.getElementById('anaRefresh')?.addEventListener('click', renderAnalytics);

function capturePositions(host) {
  const map = new Map();
  if (!host) return map;
  host.querySelectorAll('[data-key]').forEach((el) => {
    const rect = el.getBoundingClientRect();
    map.set(el.dataset.key, rect);
  });
  return map;
}

function captureSegmentWidths(host) {
  const map = new Map();
  if (!host) return map;
  host.querySelectorAll('.weighted-row').forEach((row) => {
    const key = row.dataset.key;
    if (!key) return;
    const actual = row.querySelector('.weighted-actual');
    const delta = row.querySelector('.weighted-delta');
    const prev = {};
    if (actual && actual.style.width) prev.actual = parseFloat(actual.style.width) || 0;
    if (delta && delta.style.width) prev.delta = parseFloat(delta.style.width) || 0;
    if (delta && delta.style.left) prev.left = parseFloat(delta.style.left) || 0;
    if (Object.keys(prev).length) {
      map.set(key, prev);
    }
  });
  return map;
}

function animatePositionChanges(host, previousRects) {
  if (!host || !previousRects || previousRects.size === 0) return;
  requestAnimationFrame(() => {
    host.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const prev = previousRects.get(key);
      if (!prev) return;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (dx || dy) {
        el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: 'translate(0, 0)' },
          ],
          { duration: 350, easing: 'ease-out' }
        );
      }
    });
  });
}

function renderWeightedBars(hostOrId, items = [], options = {}) {
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  if (!host) return;
  const showWeighting = Boolean(options.showWeighting);
  const list = Array.isArray(items) ? items : [];
  const filtered = typeof options.filterFn === 'function' ? list.filter(options.filterFn) : list;
  const ranked = filtered
    .map((item, idx) => ({ ...item, __idx: idx }))
    .filter((item) => (item.actual || 0) > 0 || (item.weighted || 0) > 0)
    .sort((a, b) => (showWeighting ? (b.weighted || 0) - (a.weighted || 0) : (b.actual || 0) - (a.actual || 0)));

  const maxValue = ranked.reduce(
    (max, item) => Math.max(max, Number(item.actual) || 0, Number(item.weighted) || 0),
    0
  ) || 1;

  const prevRects = capturePositions(host);
  const prevWidths = captureSegmentWidths(host);
  host.innerHTML = '';
  if (!ranked.length) {
    const empty = document.createElement('div');
    empty.className = 'log-metrics-empty';
    empty.textContent = options.emptyMessage || 'Keine Daten verfügbar.';
    host.appendChild(empty);
    return;
  }

  ranked.forEach((item, index) => {
    const actual = Math.max(0, Number(item.actual) || 0);
    const weighted = Math.max(0, Number(item.weighted) || 0);
    const delta = weighted - actual;
    const baseValue = showWeighting && weighted < actual ? weighted : actual;
    const baseWidth = Math.max(6, (baseValue / maxValue) * 100);
    const deltaWidth = showWeighting ? Math.max(0, Math.min(100, (Math.abs(delta) / maxValue) * 100)) : 0;
    const totalValue = showWeighting ? weighted : actual;
    const targetBaseWidth = Math.min(baseWidth, 100);
    const targetDeltaLeft = Math.max(0, Math.min(baseWidth, 100));
    const targetDeltaWidth = showWeighting ? deltaWidth : 0;

    const prev = prevWidths.get(options.getKey ? options.getKey(item) : item.name || String(item.__idx));
    const initialBaseWidth = typeof prev?.actual === 'number' ? prev.actual : targetBaseWidth;
    const initialDeltaWidth = typeof prev?.delta === 'number' ? prev.delta : 0;
    const initialDeltaLeft = typeof prev?.left === 'number' ? prev.left : targetDeltaLeft;

    const row = document.createElement('div');
    row.className = 'weighted-row';
    row.dataset.key = options.getKey ? options.getKey(item) : item.name || String(item.__idx);

    const meta = document.createElement('div');
    meta.className = 'weighted-meta';
    const rank = document.createElement('span');
    rank.className = 'weighted-rank';
    rank.textContent = String(index + 1);
    const name = document.createElement('span');
    name.className = 'weighted-name';
    const label = options.getLabel ? options.getLabel(item) : item.name || '–';
    name.textContent = label;
    name.title = label;
    meta.append(rank, name);

    if (options.getBadge) {
      const badgeText = options.getBadge(item);
      if (badgeText) {
        const badge = document.createElement('span');
        badge.className = 'weighted-team';
        badge.textContent = badgeText;
        meta.appendChild(badge);
      }
    }

    const track = document.createElement('div');
    track.className = 'weighted-track';

    const actualFill = document.createElement('div');
    actualFill.className = 'weighted-segment weighted-actual';
    actualFill.style.width = `${initialBaseWidth}%`;
    const actualLabel = document.createElement('span');
    actualLabel.className = 'weighted-segment-label';
    actualLabel.textContent = fmtCurr0.format(actual);
    actualFill.appendChild(actualLabel);

    const deltaFill = document.createElement('div');
    deltaFill.className = `weighted-segment weighted-delta${delta < 0 ? ' negative' : ''}`;
    deltaFill.style.width = `${initialDeltaWidth}%`;
    deltaFill.style.left = `${initialDeltaLeft}%`;
    deltaFill.classList.toggle('collapsed', !showWeighting || targetDeltaWidth === 0);
    const deltaLabel = document.createElement('span');
    deltaLabel.className = 'weighted-segment-label';
    deltaFill.appendChild(deltaLabel);

    track.append(actualFill, deltaFill);

    const total = document.createElement('div');
    total.className = 'weighted-total';
    total.textContent = fmtCurr0.format(totalValue);

    row.append(meta, track, total);
    host.appendChild(row);

    const syncDeltaLabel = () => {
      const labelText = showWeighting && targetDeltaWidth > 0
        ? `${delta >= 0 ? '+' : '-'}${fmtCurr0.format(Math.abs(delta))}`
        : '';
      deltaLabel.textContent = labelText;
      deltaLabel.style.display = labelText ? 'inline-flex' : 'none';
      deltaFill.classList.remove('label-outside');
      deltaLabel.classList.remove('outside-left', 'outside-right');
      if (!labelText) return;

      const trackWidth = track.getBoundingClientRect().width;
      const targetDeltaPx = (targetDeltaWidth / 100) * trackWidth;
      const currentDeltaPx = deltaFill.getBoundingClientRect().width;
      const available = Math.max(currentDeltaPx, targetDeltaPx);
      const needed = deltaLabel.getBoundingClientRect().width + 10;
      const useOutside = available < needed;
      deltaFill.classList.toggle('label-outside', useOutside);
      if (useOutside) {
        if (delta >= 0) {
          deltaLabel.classList.add('outside-right');
        } else {
          deltaLabel.classList.add('outside-left');
        }
      }
    };

    requestAnimationFrame(() => {
      actualFill.style.width = `${targetBaseWidth}%`;
      const deltaLeft = Math.max(0, Math.min(targetDeltaLeft, 100));
      deltaFill.style.left = `${deltaLeft}%`;
      deltaFill.style.width = `${targetDeltaWidth}%`;
      deltaFill.classList.toggle('collapsed', !showWeighting || targetDeltaWidth === 0);
      syncDeltaLabel();
      requestAnimationFrame(syncDeltaLabel);
    });
  });

  animatePositionChanges(host, prevRects);
}

function getTimestamp(dateStr) {
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  } catch { return 0; }
}

function renderAnalytics() {
  const year = Number(anaYear.value);
  const startOfYear = getTimestamp(`${year}-01-01`);
  const endOfYear = getTimestamp(`${year}-12-31T23:59:59.999`);

  const personMap = new Map((Array.isArray(people) ? people : []).map((p) => [p.name, p]));
  const personStats = new Map();
  const teamStats = new Map();
  const entryBreakdown = [];
  let fixTotal = 0;
  let fixWeightedTotal = 0;
  let rahmenTotal = 0;
  let rahmenWeightedTotal = 0;

  const addPersonStat = (rawName, amount, factor, dateTimestamp) => {
    const money = Number(amount) || 0;
    if (money <= 0) return;
    const ratio = clampDockRewardFactor(factor);
    const name = rawName || 'Unbekannt';
    const weighted = money * ratio;
    const personObj = personMap.get(name);
    const teamName = getTeamForPerson(personObj, dateTimestamp) || 'Ohne Team';
    const person = personStats.get(name) || { name, team: teamName, actual: 0, weighted: 0 };
    person.actual += money;
    person.weighted += weighted;
    person.team = teamName || person.team;
    personStats.set(name, person);
    const team = teamStats.get(teamName) || { name: teamName, actual: 0, weighted: 0 };
    team.actual += money;
    team.weighted += weighted;
    teamStats.set(teamName, team);
  };

  const eligibleEntries = getEntries().filter((entry) => {
    const finalAssignment = String(entry?.dockFinalAssignment || '').toLowerCase();
    const hasDockProcess = entry?.dockPhase != null || Boolean(finalAssignment);
    if (!hasDockProcess) return true;

    const phase = getDockPhase(entry);
    const isFinal = ['fix', 'rahmen', 'abruf'].includes(finalAssignment);
    return phase === 3 && isFinal;
  });

  eligibleEntries.forEach((entry) => {
    const datum = entry.freigabedatum || entry.ts || 0;
    const factor = getEntryRewardFactor(entry);
    if (entry.projectType === 'fix') {
      if (!(datum >= startOfYear && datum <= endOfYear)) return;
      const actualAmount = Number(entry.amount) || 0;
      if (actualAmount <= 0) return;
      const weightedAmount = actualAmount * factor;
      fixTotal += actualAmount;
      fixWeightedTotal += weightedAmount;
      entryBreakdown.push({
        id: entry.id,
        type: 'fix',
        title: entry.title || '–',
        actual: actualAmount,
        weighted: weightedAmount,
      });
      if (Array.isArray(entry.list)) {
        entry.list.forEach((contributor) => {
          addPersonStat(contributor?.name || 'Unbekannt', contributor?.money || 0, factor, datum);
        });
      }
    } else if (entry.projectType === 'rahmen') {
      const transactions = (entry.transactions || []).filter((trans) => {
        const d = trans.freigabedatum || trans.ts || 0;
        return d >= startOfYear && d <= endOfYear;
      });

      transactions.forEach((trans) => {
        const transDate = trans.freigabedatum || trans.ts || 0;
        const amount = Number(trans.amount) || 0;
        if (amount <= 0) return;
        const transactionFactor = clampDockRewardFactor(
          trans?.dockRewardFactor ?? entry?.dockRewardFactor ?? DOCK_WEIGHTING_DEFAULT
        );
        const weightedAmount = amount * transactionFactor;

        rahmenTotal += amount;
        rahmenWeightedTotal += weightedAmount;
        entryBreakdown.push({
          id: trans.id,
          parentId: entry.id,
          type: 'abruf',
          title: trans.title || entry.title || '–',
          actual: amount,
          weighted: weightedAmount,
        });

        if (trans.type === 'founder') {
          (entry.list || []).forEach((founder) => {
            const pct = Number(founder?.pct) || 0;
            const money = amount * (pct / 100);
            addPersonStat(founder?.name || 'Unbekannt', money, transactionFactor, transDate);
          });
        } else if (trans.type === 'hunter') {
          const founderShareAmount = amount * (FOUNDER_SHARE_PCT / 100);
          (entry.list || []).forEach((founder) => {
            const pct = Number(founder?.pct) || 0;
            const money = founderShareAmount * (pct / 100);
            addPersonStat(founder?.name || 'Unbekannt', money, transactionFactor, transDate);
          });
          (trans.list || []).forEach((hunter) => {
            addPersonStat(hunter?.name || 'Unbekannt', hunter?.money || 0, transactionFactor, transDate);
          });
        }
      });
    }
  });

  const personList = Array.from(personStats.values())
    .map((item) => ({
      ...item,
      factor: item.actual > 0 ? item.weighted / item.actual : 0,
    }))
    .filter((item) => item.actual > 0)
    .sort((a, b) => b.weighted - a.weighted);

  const teamList = Array.from(teamStats.values())
    .filter((item) => item.actual > 0)
    .map((item) => ({
      ...item,
      factor: item.actual > 0 ? item.weighted / item.actual : 0,
    }))
    .sort((a, b) => b.weighted - a.weighted);

  const totalArr = [
    { name: 'Fixaufträge', actual: fixTotal, weighted: fixWeightedTotal },
    { name: 'Rahmenverträge', actual: rahmenTotal, weighted: rahmenWeightedTotal },
    { name: 'Gesamt', actual: fixTotal + rahmenTotal, weighted: fixWeightedTotal + rahmenWeightedTotal },
  ].filter((item) => item.actual > 0 || item.weighted > 0);
  setAnalyticsData({
    persons: personList,
    teams: teamList,
    totals: totalArr,
    salesSummary: {
      persons: personList,
      totals: {
        actual: fixTotal + rahmenTotal,
        weighted: fixWeightedTotal + rahmenWeightedTotal,
      },
    },
    entryBreakdown,
  });

  renderContributionCharts();
}

function renderContributionCharts() {
  const analytics = getAnalyticsData();
  const selectedTeams = getSelectedMarketTeams();

  renderWeightedBars('salesContributionSummary', analytics.persons, {
    showWeighting: anaPersonWeightingEnabled,
    filterFn: (p) => !selectedTeams.length || selectedTeams.includes(p.team || ''),
  });

  renderWeightedBars('chartTeams', analytics.teams, {
    showWeighting: anaTeamWeightingEnabled,
    getLabel: (item) => item.name,
    getKey: (item) => item.name,
    emptyMessage: 'Keine Team-Daten verfügbar.',
  });

  renderTotalsActual(analytics.totals);
}

function renderTotalsActual(totals = []) {
  const list = Array.isArray(totals)
    ? totals
        .map((t) => ({ name: t.name, val: Math.max(0, Number(t.actual) || 0) }))
        .filter((t) => t.val > 0)
    : [];
  drawBars('chartTotals', list, false, { formatter: fmtCurr0, emptyMessage: 'Keine Daten verfügbar.' });
}

function renderActivityAnalytics() {
  const start = getTimestamp(anaStartDate.value);
  const end = getTimestamp(`${anaEndDate.value}T23:59:59.999`);
  const titleEl = document.getElementById('chartActivityTitle');

  if (!start || !end || end < start) {
    showToast('Ungültiger Datumsbereich', 'bad');
    if (titleEl) {
      titleEl.textContent = 'Rahmenvertragsnutzung & Hunter/Founder-Anteile (ungültiger Zeitraum)';
    }
    renderFrameworkActivityChart('chartActivity', []);
    return;
  }

  const frameworks = getEntries().filter((entry) => entry.projectType === 'rahmen');
  const aggregated = [];

  frameworks.forEach((entry) => {
    let total = 0;
    let founderTotal = 0;
    let hunterTotal = 0;
    let otherTotal = 0;
    let count = 0;

    (entry.transactions || []).forEach((transaction) => {
      const date = Number(transaction?.freigabedatum ?? transaction?.ts ?? 0);
      if (!Number.isFinite(date) || date < start || date > end) {
        return;
      }

      const amountRaw = transaction?.amount;
      const amount =
        typeof amountRaw === 'string'
          ? parseAmountInput(amountRaw)
          : Number(amountRaw ?? 0);
      if (!Number.isFinite(amount)) {
        return;
      }

      total += amount;
      const type = String(transaction?.type || '').toLowerCase();
      if (type === 'founder') {
        founderTotal += amount;
      } else if (type === 'hunter') {
        hunterTotal += amount;
      } else {
        otherTotal += amount;
      }
      count += 1;
    });

    if (count === 0) {
      return;
    }

    const volume = getFrameworkVolume(entry);
    const utilizationPct = volume != null && volume > 0 ? (total / volume) * 100 : null;

    aggregated.push({
      id: entry.id,
      name: entry.title || '–',
      client: entry.client || '',
      projectNumber: entry.projectNumber || '',
      total,
      founder: founderTotal,
      hunter: hunterTotal,
      other: otherTotal,
      count,
      volume,
      utilizationPct,
    });
  });

  const topFrameworks = aggregated
    .filter((item) => item.total > 0 || (item.volume && item.utilizationPct != null))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const startLabel = new Date(start).toLocaleDateString('de-DE');
  const endLabel = new Date(end).toLocaleDateString('de-DE');
  if (titleEl) {
    titleEl.textContent = `Rahmenvertragsnutzung & Hunter/Founder-Anteile (${startLabel} – ${endLabel})`;
  }
  renderFrameworkActivityChart('chartActivity', topFrameworks);
}

function drawLineChart(hostOrId, points, options = {}) {
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  if (!host) return;
  host.innerHTML = '';
  const list = Array.isArray(points) ? points : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'log-metrics-empty';
    empty.textContent = options.emptyMessage || 'Keine Daten verfügbar.';
    host.appendChild(empty);
    return;
  }

  const formatter = options.formatter || ((value) => String(value));
  const color = options.color || '#3b82f6';
  const width = options.width || 1060;
  const height = options.height || 260;
  const padding = { top: 20, right: 24, bottom: 46, left: 80 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const coords = list.map((point, idx) => ({
    label: point.label,
    value: Number(point.value) || 0,
    raw: point,
    index: idx,
  }));

  let minVal = coords.reduce((min, p) => Math.min(min, p.value), Number.POSITIVE_INFINITY);
  let maxVal = coords.reduce((max, p) => Math.max(max, p.value), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(minVal)) minVal = 0;
  if (!Number.isFinite(maxVal)) maxVal = 0;
  if (typeof options.minValue === 'number') minVal = options.minValue;
  if (typeof options.maxValue === 'number') maxVal = options.maxValue;
  if (options.zeroBased) {
    if (minVal > 0) minVal = 0;
    if (maxVal < 0) maxVal = 0;
  }
  if (maxVal === minVal) {
    const adjust = Math.abs(maxVal || 1);
    maxVal += adjust;
    minVal -= adjust;
  }
  const range = maxVal - minVal || 1;
  const denom = Math.max(1, coords.length - 1);

  const positioned = coords.map((point) => {
    const ratio = coords.length === 1 ? 0.5 : point.index / denom;
    const x = padding.left + ratio * chartWidth;
    const y = padding.top + ((maxVal - point.value) / range) * chartHeight;
    return { ...point, x, y };
  });

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  const yAxis = document.createElementNS(svgNS, 'line');
  yAxis.setAttribute('x1', padding.left);
  yAxis.setAttribute('x2', padding.left);
  yAxis.setAttribute('y1', padding.top);
  yAxis.setAttribute('y2', height - padding.bottom);
  yAxis.setAttribute('stroke', '#1f2937');
  yAxis.setAttribute('stroke-width', '1');
  svg.appendChild(yAxis);

  const xAxis = document.createElementNS(svgNS, 'line');
  xAxis.setAttribute('x1', padding.left);
  xAxis.setAttribute('x2', width - padding.right);
  xAxis.setAttribute('y1', height - padding.bottom);
  xAxis.setAttribute('y2', height - padding.bottom);
  xAxis.setAttribute('stroke', '#1f2937');
  xAxis.setAttribute('stroke-width', '1');
  svg.appendChild(xAxis);

  const linePath = positioned
    .map((point, idx) => `${idx === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
    .join(' ');

  const area = document.createElementNS(svgNS, 'path');
  const first = positioned[0];
  const last = positioned[positioned.length - 1];
  const baselineY = height - padding.bottom;
  const areaPath = `${linePath} L${last.x} ${baselineY} L${first.x} ${baselineY} Z`;
  area.setAttribute('d', areaPath);
  area.setAttribute('fill', 'rgba(59,130,246,0.18)');
  svg.appendChild(area);

  const line = document.createElementNS(svgNS, 'path');
  line.setAttribute('d', linePath);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '2');
  svg.appendChild(line);

  positioned.forEach((point) => {
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', String(point.x));
    circle.setAttribute('cy', String(point.y));
    circle.setAttribute('r', '4');
    circle.setAttribute('fill', color);
    const title = document.createElementNS(svgNS, 'title');
    const formatted = formatter(point.value, point.raw);
    title.textContent = `${point.label}: ${formatted}`;
    circle.appendChild(title);
    svg.appendChild(circle);

    const valueLabel = document.createElementNS(svgNS, 'text');
    valueLabel.setAttribute('x', String(point.x));
    valueLabel.setAttribute('y', String(point.y - 10));
    valueLabel.setAttribute('fill', '#cbd5e1');
    valueLabel.setAttribute('font-size', '12');
    valueLabel.setAttribute('text-anchor', 'middle');
    valueLabel.textContent = formatted;
    svg.appendChild(valueLabel);

    const xLabel = document.createElementNS(svgNS, 'text');
    xLabel.setAttribute('x', String(point.x));
    xLabel.setAttribute('y', String(baselineY + 18));
    xLabel.setAttribute('fill', '#94a3b8');
    xLabel.setAttribute('font-size', '12');
    xLabel.setAttribute('text-anchor', 'middle');
    xLabel.textContent = point.label;
    svg.appendChild(xLabel);
  });

  const maxLabel = document.createElementNS(svgNS, 'text');
  maxLabel.setAttribute('x', String(padding.left - 12));
  maxLabel.setAttribute('y', String(padding.top + 4));
  maxLabel.setAttribute('fill', '#94a3b8');
  maxLabel.setAttribute('font-size', '12');
  maxLabel.setAttribute('text-anchor', 'end');
  maxLabel.textContent = formatter(maxVal, { label: 'max' });
  svg.appendChild(maxLabel);

  const minLabel = document.createElementNS(svgNS, 'text');
  minLabel.setAttribute('x', String(padding.left - 12));
  minLabel.setAttribute('y', String(baselineY));
  minLabel.setAttribute('fill', '#94a3b8');
  minLabel.setAttribute('font-size', '12');
  minLabel.setAttribute('text-anchor', 'end');
  minLabel.textContent = formatter(minVal, { label: 'min' });
  svg.appendChild(minLabel);

  host.appendChild(svg);
}

function drawComparisonBars(hostOrId, items, options = {}) {
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  if (!host) return;
  host.innerHTML = '';
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'log-metrics-empty';
    empty.textContent = options.emptyMessage || 'Keine Daten verfügbar.';
    host.appendChild(empty);
    return;
  }

  const formatter = options.formatter || fmtCurr0;
  const max = list.reduce(
    (m, item) => Math.max(m, Number(item.actual) || 0, Number(item.weighted) || 0),
    0
  );
  const barH = 30;
  const gap = 8;
  const w = 1060;
  const h = list.length > 0 ? list.length * (barH + gap) + 10 : 50;
  const textWidth = 240;
  const barStartX = textWidth;
  const valueOffset = 120;
  const availableWidth = w - barStartX - valueOffset;

  const legend = document.createElement('div');
  legend.className = 'compare-bar-legend';
  legend.innerHTML = `
    <span><span class="legend-dot legend-actual"></span>Ist</span>
    <span><span class="legend-dot legend-weighted"></span>Gewichtet</span>
  `;
  host.appendChild(legend);

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  let y = 10;
  list.forEach((item) => {
    const actual = Math.max(0, Number(item.actual) || 0);
    const weighted = Math.max(0, Number(item.weighted) || 0);
    const actualLen = max > 0 ? Math.round((actual / max) * availableWidth) : 0;
    const weightedLen = max > 0 ? Math.round((weighted / max) * availableWidth) : 0;
    const g = document.createElementNS(svgNS, 'g');

    const title = document.createElementNS(svgNS, 'title');
    const delta = weighted - actual;
    const deltaText = delta ? ` (${delta > 0 ? '+' : ''}${formatter.format(delta)})` : '';
    title.textContent = `${item.name}: ${formatter.format(actual)} → ${formatter.format(weighted)}${deltaText}`;
    g.appendChild(title);

    if (actualLen > 0) {
      const actualRect = document.createElementNS(svgNS, 'rect');
      actualRect.setAttribute('x', String(barStartX));
      actualRect.setAttribute('y', String(y));
      actualRect.setAttribute('rx', '6');
      actualRect.setAttribute('ry', '6');
      actualRect.setAttribute('width', String(actualLen));
      actualRect.setAttribute('height', String(barH));
      actualRect.setAttribute('fill', '#1f2937');
      actualRect.setAttribute('opacity', '0.65');
      g.appendChild(actualRect);
    }

    if (weightedLen > 0) {
      const weightedRect = document.createElementNS(svgNS, 'rect');
      weightedRect.setAttribute('x', String(barStartX));
      weightedRect.setAttribute('y', String(y));
      weightedRect.setAttribute('rx', '6');
      weightedRect.setAttribute('ry', '6');
      weightedRect.setAttribute('width', String(Math.max(weightedLen, 4)));
      weightedRect.setAttribute('height', String(barH));
      weightedRect.setAttribute('fill', '#3b82f6');
      g.appendChild(weightedRect);
    }

    const labelL = document.createElementNS(svgNS, 'text');
    labelL.setAttribute('x', '10');
    labelL.setAttribute('y', String(y + barH * 0.68));
    labelL.setAttribute('fill', '#cbd5e1');
    labelL.setAttribute('font-size', '14');
    labelL.textContent =
      item.name && item.name.length > 30 ? `${item.name.substring(0, 28)}.` : item.name || '-';
    g.appendChild(labelL);

    const valueText = `${formatter.format(actual)} → ${formatter.format(weighted)}`;
    const labelV = document.createElementNS(svgNS, 'text');
    labelV.setAttribute('y', String(y + barH * 0.68));
    labelV.setAttribute('font-weight', '700');
    labelV.setAttribute('font-size', '14');
    labelV.textContent = valueText;
    const textWidthEstimate = valueText.length * 8;
    if (weightedLen < textWidthEstimate + 10) {
      labelV.setAttribute('x', String(barStartX + weightedLen + 8));
      labelV.setAttribute('fill', '#cbd5e1');
    } else {
      labelV.setAttribute('x', String(barStartX + 10));
      labelV.setAttribute('fill', '#0a0f16');
    }
    g.appendChild(labelV);

    y += barH + gap;
    svg.appendChild(g);
  });

  host.appendChild(svg);
}

function drawBars(hostOrId, items, showCount = false, options = {}) {
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  if (!host) return;
  host.innerHTML = '';
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'log-metrics-empty';
    empty.textContent = options.emptyMessage || 'Keine Daten verfügbar.';
    host.appendChild(empty);
    return;
  }

  const formatter = options.formatter || fmtCurr0;
  const valueFormatter = options.valueFormatter;
  const titleFormatter = options.titleFormatter;
  const barColor = options.barColor || '#3b82f6';
  const suffix = options.suffix || '';

  const max = list.reduce((m, x) => Math.max(m, Number(x.val) || 0), 0) || 1;
  const barH = 30;
  const gap = 8;
  const w = 1060;
  const h = list.length > 0 ? list.length * (barH + gap) + 10 : 50;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  let y = 10;
  const textWidth = 240;
  const barStartX = textWidth;
  const valueOffset = 120;

  list.forEach((item) => {
    const value = Number(item.val) || 0;
    const len = Math.max(4, Math.round((value / max) * (w - barStartX - valueOffset)));
    const g = document.createElementNS(svgNS, 'g');

    const formattedValue = valueFormatter ? valueFormatter(item) : `${formatter.format(value)}${suffix}`;
    const countText = showCount && item.count ? ` (${item.count})` : '';
    const titleText = titleFormatter
      ? titleFormatter(item, formattedValue)
      : `${item.name}: ${formattedValue}${countText}`;
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = titleText;
    g.appendChild(title);

    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', String(barStartX));
    rect.setAttribute('y', String(y));
    rect.setAttribute('rx', '6');
    rect.setAttribute('ry', '6');
    rect.setAttribute('width', String(len));
    rect.setAttribute('height', String(barH));
    rect.setAttribute('fill', barColor);

    const labelL = document.createElementNS(svgNS, 'text');
    labelL.setAttribute('x', '10');
    labelL.setAttribute('y', String(y + barH * 0.68));
    labelL.setAttribute('fill', '#cbd5e1');
    labelL.setAttribute('font-size', '14');
    labelL.textContent = item.name && item.name.length > 30 ? `${item.name.substring(0, 28)}…` : (item.name || '–');

    const labelV = document.createElementNS(svgNS, 'text');
    labelV.setAttribute('y', String(y + barH * 0.68));
    labelV.setAttribute('font-weight', '700');
    labelV.setAttribute('font-size', '14');
    const valueText = `${formattedValue}${countText}`;
    labelV.textContent = valueText;

    const valueTextLengthEstimate = valueText.length * 8;
    if (len < valueTextLengthEstimate + 10) {
      labelV.setAttribute('x', String(barStartX + len + 8));
      labelV.setAttribute('fill', '#cbd5e1');
    } else {
      labelV.setAttribute('x', String(barStartX + 10));
      labelV.setAttribute('fill', '#0a0f16');
    }

    g.appendChild(rect);
    g.appendChild(labelL);
    g.appendChild(labelV);
    svg.appendChild(g);
    y += barH + gap;
  });

  host.appendChild(svg);
}

function createActivityMetricCell(primaryText, secondaryLines = []) {
  const cell = document.createElement('td');
  cell.style.textAlign = 'right';
  cell.style.whiteSpace = 'nowrap';

  const main = document.createElement('div');
  main.textContent = primaryText;
  main.style.fontWeight = '600';
  cell.appendChild(main);

  secondaryLines.forEach((line) => {
    if (!line) return;
    const detail = document.createElement('div');
    detail.className = 'small';
    if (typeof line === 'string') {
      detail.style.color = 'var(--muted)';
      detail.textContent = line;
    } else if (typeof line === 'object') {
      detail.style.color = line.color || 'var(--muted)';
      detail.textContent = line.text || '';
    }
    cell.appendChild(detail);
  });

  return cell;
}

function renderFrameworkActivityChart(hostOrId, items) {
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  if (!host) return;
  host.innerHTML = '';

  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'log-metrics-empty';
    empty.textContent = 'Keine Rahmenvertragsabrufe im Zeitraum.';
    host.appendChild(empty);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrapper';

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th style="text-align:left">Rahmenvertrag</th>
      <th>Founder-Umsatz</th>
      <th>Hunter-Umsatz</th>
      <th>Summe Zeitraum</th>
      <th>Rahmenvolumen</th>
      <th>Ausnutzung</th>
    </tr>
  `;

  const tbody = document.createElement('tbody');
  list.forEach((item) => {
    const tr = document.createElement('tr');

    const metaParts = [];
    if (item.client) metaParts.push(item.client);
    if (item.projectNumber) metaParts.push(item.projectNumber);

    const nameCell = document.createElement('td');
    nameCell.style.textAlign = 'left';
    const title = document.createElement('div');
    title.textContent = item.name || '–';
    title.style.fontWeight = '600';
    nameCell.appendChild(title);
    if (metaParts.length) {
      const meta = document.createElement('div');
      meta.className = 'small';
      meta.style.color = 'var(--muted)';
      meta.textContent = metaParts.join(' • ');
      nameCell.appendChild(meta);
    }
    tr.appendChild(nameCell);

    const total = Number.isFinite(item.total) ? item.total : 0;
    const founder = Number.isFinite(item.founder) ? item.founder : 0;
    const hunter = Number.isFinite(item.hunter) ? item.hunter : 0;
    const other = Number.isFinite(item.other) ? item.other : 0;
    const hasShareBase = Math.abs(total) > 0.0001;
    const founderShare = hasShareBase ? (founder / total) * 100 : null;
    const hunterShare = hasShareBase ? (hunter / total) * 100 : null;

    tr.appendChild(
      createActivityMetricCell(fmtCurr0.format(founder),
        founderShare != null ? [`${fmtPct.format(founderShare)} % Anteil`] : [])
    );
    tr.appendChild(
      createActivityMetricCell(fmtCurr0.format(hunter),
        hunterShare != null ? [`${fmtPct.format(hunterShare)} % Anteil`] : [])
    );

    const sumDetails = [`Abrufe: ${fmtInt.format(item.count || 0)}`];
    if (Math.abs(other) > 0.01) {
      sumDetails.push(`Sonstige: ${fmtCurr0.format(other)}`);
    }
    tr.appendChild(createActivityMetricCell(fmtCurr0.format(total), sumDetails));

    const normalizedVolume = Number.isFinite(item.volume) ? item.volume : null;
    if (normalizedVolume != null) {
      const remaining = normalizedVolume - total;
      const secondary = [];
      if (Math.abs(remaining) > 0.01) {
        secondary.push(
          remaining >= 0
            ? `Rest: ${fmtCurr0.format(remaining)}`
            : { text: `Überzogen: ${fmtCurr0.format(Math.abs(remaining))}`, color: 'var(--warn)' }
        );
      }
      tr.appendChild(createActivityMetricCell(fmtCurr0.format(normalizedVolume), secondary));
    } else {
      tr.appendChild(createActivityMetricCell('–'));
    }

    const utilization = Number.isFinite(item.utilizationPct) ? item.utilizationPct : null;
    if (utilization != null) {
      tr.appendChild(createActivityMetricCell(`${fmtPct.format(utilization)} %`));
    } else {
      tr.appendChild(createActivityMetricCell('–'));
    }

    const tooltipParts = [
      `Summe: ${fmtCurr0.format(total)}`,
      `Founder: ${fmtCurr0.format(founder)}`,
      `Hunter: ${fmtCurr0.format(hunter)}`,
      `Abrufe: ${fmtInt.format(item.count || 0)}`,
    ];
    if (Math.abs(other) > 0.01) {
      tooltipParts.push(`Sonstige: ${fmtCurr0.format(other)}`);
    }
    if (normalizedVolume != null) {
      tooltipParts.push(`Volumen: ${fmtCurr0.format(normalizedVolume)}`);
    }
    if (utilization != null) {
      tooltipParts.push(`Ausnutzung: ${fmtPct.format(utilization)} %`);
    }
    tr.title = `${escapeHtml(item.name)}${item.client ? ` (${escapeHtml(item.client)})` : ''} • ${tooltipParts.join(' • ')}`;

    tbody.appendChild(tr);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  wrapper.appendChild(table);
  host.appendChild(wrapper);
}

const trendMonthFormatter = new Intl.DateTimeFormat('de-DE', { month: 'short', year: 'numeric' });
const trendAverageFormatter = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function initTrendControls() {
  if (!trendFromMonth || !trendToMonth) {
    return;
  }
  if (!trendFromMonth.value || !trendToMonth.value) {
    setTrendRange('last12');
  }
  btnTrendThisYear?.addEventListener('click', () => {
    setTrendRange('thisYear');
    renderTrendInsights();
  });
  btnTrendLast12?.addEventListener('click', () => {
    setTrendRange('last12');
    renderTrendInsights();
  });
  btnTrendLoad?.addEventListener('click', () => renderTrendInsights());
  btnTrendCsv?.addEventListener('click', exportTrendCsv);
  btnTrendXlsx?.addEventListener('click', exportTrendXlsx);
}

function setTrendRange(rangeType) {
  if (!trendFromMonth || !trendToMonth) return;
  const now = new Date();
  let start;
  let end;
  if (rangeType === 'thisYear') {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    end = new Date(now.getFullYear(), now.getMonth(), 1);
    start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
  }
  trendFromMonth.value = formatMonthInputValue(start);
  trendToMonth.value = formatMonthInputValue(end);
}

function formatMonthInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function parseMonthValue(value) {
  if (!value || typeof value !== 'string') return null;
  const [yearStr, monthStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  const date = new Date(year, month - 1, 1);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getEndOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function normalizeTrendTimestamp(value) {
  if (value == null) return Number.NaN;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return Number.NaN;
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return Number.NaN;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return Number.NaN;
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? Number.NaN : time;
  }
  return Number.NaN;
}

function normalizeTrendAmount(value) {
  if (value == null) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const parsed = parseAmountInput(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function collectTrendItems(entry) {
  const items = [];
  if (!entry || typeof entry !== 'object') return items;

  const transactionItems = Array.isArray(entry.transactions)
    ? entry.transactions
      .map((tx) => {
        const ts = normalizeTrendTimestamp(tx?.freigabedatum ?? tx?.ts ?? tx?.date);
        const amount = normalizeTrendAmount(tx?.amount ?? tx?.value);
        if (!Number.isFinite(ts) || !(amount > 0)) {
          return null;
        }
        return { timestamp: ts, amount };
      })
      .filter(Boolean)
    : [];

  if (transactionItems.length) {
    items.push(...transactionItems);
    return items;
  }

  const baseTimestamp = normalizeTrendTimestamp(
    entry.freigabedatum ?? entry.ts ?? entry.abschlussdatum ?? entry.closeDate ?? entry.date
  );
  const baseAmount = normalizeTrendAmount(entry.amount ?? entry.value ?? entry.auftragswert);
  if (!Number.isFinite(baseTimestamp) || !(baseAmount > 0)) {
    return items;
  }

  const projectType = String(entry.projectType || '').toLowerCase();
  if (projectType === 'rahmen' && Array.isArray(entry.transactions) && entry.transactions.length > 0) {
    return items;
  }

  items.push({ timestamp: baseTimestamp, amount: baseAmount });
  return items;
}

function computeTrendData(fromDate, toDate) {
  const startMs = fromDate.getTime();
  const endMs = getEndOfMonth(toDate).getTime();
  const monthsMap = new Map();

  getEntries().forEach((entry) => {
    collectTrendItems(entry).forEach((item) => {
      if (!Number.isFinite(item.timestamp) || item.timestamp < startMs || item.timestamp > endMs) {
        return;
      }
      const date = new Date(item.timestamp);
      const year = date.getFullYear();
      const monthIndex = date.getMonth();
      const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
      let bucket = monthsMap.get(key);
      if (!bucket) {
        bucket = {
          year,
          monthIndex,
          amount: 0,
          count: 0,
          label: trendMonthFormatter.format(new Date(year, monthIndex, 1)),
        };
        monthsMap.set(key, bucket);
      }
      bucket.amount += item.amount;
      bucket.count += 1;
    });
  });

  const sortedKeys = Array.from(monthsMap.keys()).sort();
  const months = sortedKeys.map((key) => {
    const bucket = monthsMap.get(key);
    return {
      key,
      label: bucket.label,
      amount: bucket.amount,
      count: bucket.count,
      year: bucket.year,
      monthIndex: bucket.monthIndex,
    };
  });

  let cumulative = 0;
  months.forEach((month) => {
    cumulative += month.amount;
    month.cumulativeAmount = cumulative;
  });

  const totalAmount = months.reduce((sum, month) => sum + month.amount, 0);
  const totalDeals = months.reduce((sum, month) => sum + month.count, 0);
  const averageAmount = months.length ? totalAmount / months.length : 0;
  const averageDeals = months.length ? totalDeals / months.length : 0;
  const bestMonth = months.reduce((best, month) => {
    if (!best || month.amount > best.amount) {
      return month;
    }
    return best;
  }, null);

  const revenueSeries = months.map((month) => ({
    label: month.label,
    value: Number(month.amount.toFixed(2)),
    count: month.count,
  }));
  const cumulativeSeries = months.map((month) => ({
    label: month.label,
    value: Number(month.cumulativeAmount.toFixed(2)),
  }));

  return {
    period: {
      from: formatMonthInputValue(fromDate),
      to: formatMonthInputValue(toDate),
      label: `${trendMonthFormatter.format(fromDate)} – ${trendMonthFormatter.format(toDate)}`,
    },
    months,
    totals: {
      amount: totalAmount,
      deals: totalDeals,
      averageAmount,
      averageDeals,
      bestMonth,
    },
    series: {
      revenue: revenueSeries,
      cumulative: cumulativeSeries,
    },
  };
}

function renderTrendSummary(data) {
  if (!trendSummary) return;
  if (!data || data.months.length === 0) {
    trendSummary.innerHTML = '<div class="log-metrics-empty">Keine Daten im gewählten Zeitraum.</div>';
    return;
  }

  const monthsCount = data.months.length;
  const totals = data.totals;
  const bestMonth = totals.bestMonth;
  const monthsLabel = monthsCount === 1 ? '1 Monat analysiert' : `${monthsCount} Monate analysiert`;
  const totalAmountText = fmtCurr2.format(totals.amount || 0);
  const avgAmountText = fmtCurr2.format(totals.averageAmount || 0);
  const totalDealsText = fmtInt.format(totals.deals || 0);
  const avgDealsText = trendAverageFormatter.format(totals.averageDeals || 0);
  const bestLabel = bestMonth ? bestMonth.label : '–';
  const bestSub = bestMonth
    ? `${fmtCurr2.format(bestMonth.amount || 0)} • ${fmtInt.format(bestMonth.count || 0)} Deals`
    : 'Noch keine Umsätze';

  trendSummary.innerHTML = `
    <div class="metric-card">
      <div class="label">Zeitraum</div>
      <div class="value">${data.period.label}</div>
      <div class="sub">${monthsLabel}</div>
    </div>
    <div class="metric-card">
      <div class="label">Gesamtumsatz</div>
      <div class="value">${totalAmountText}</div>
      <div class="sub">Ø ${avgAmountText} pro Monat</div>
    </div>
    <div class="metric-card">
      <div class="label">Deals</div>
      <div class="value">${totalDealsText}</div>
      <div class="sub">Ø ${avgDealsText} Deals pro Monat</div>
    </div>
    <div class="metric-card">
      <div class="label">Bester Monat</div>
      <div class="value">${bestLabel}</div>
      <div class="sub">${bestSub}</div>
    </div>
  `;
}

function renderTrendInsights() {
  if (!trendFromMonth || !trendToMonth) return;
  const from = parseMonthValue(trendFromMonth.value);
  const to = parseMonthValue(trendToMonth.value);
  if (!from || !to) {
    if (trendSummary) {
      trendSummary.innerHTML = '<div class="log-metrics-empty">Bitte gültige Monate auswählen.</div>';
    }
    showToast('Bitte wählen Sie einen gültigen Zeitraum.', 'warn');
    return;
  }
  if (from > to) {
    showToast('Der Startmonat darf nicht nach dem Endmonat liegen.', 'warn');
    return;
  }

  const computedTrend = computeTrendData(from, to);
  setTrendData(computedTrend);
  renderTrendSummary(computedTrend);

  const revenueSeries = computedTrend.series?.revenue || [];
  const cumulativeSeries = computedTrend.series?.cumulative || [];

  drawLineChart(trendRevenueChart, revenueSeries, {
    formatter: (value) => fmtCurr2.format(value),
    emptyMessage: 'Keine Umsätze im Zeitraum.',
    color: '#3b82f6',
  });

  drawLineChart(trendCumulativeChart, cumulativeSeries, {
    formatter: (value) => fmtCurr2.format(value),
    emptyMessage: 'Keine Umsätze im Zeitraum.',
    color: '#22c55e',
  });
}

function buildTrendExportFilename(extension) {
  const trendData = getTrendData();
  const from = trendData?.period?.from || 'start';
  const to = trendData?.period?.to || 'ende';
  const suffix = `${from}_${to}`.replace(/[^0-9A-Za-z_-]+/g, '_');
  return `umsatz_trends_${suffix}.${extension}`;
}

function downloadBlob(content, mimeType, filename) {
  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 0);
  } catch (err) {
    console.error('Download fehlgeschlagen:', err);
    showToast('Download konnte nicht gestartet werden.', 'bad');
  }
}

function exportTrendCsv() {
  const trendData = getTrendData();
  if (!trendData) {
    showToast('Keine Trenddaten zum Exportieren vorhanden.', 'warn');
    return;
  }

  const { period, totals, months } = trendData;
  const lines = [];
  lines.push('Abschnitt;Feld;Wert');
  lines.push(`Zeitraum;Von;${period.from || ''}`);
  lines.push(`Zeitraum;Bis;${period.to || ''}`);
  lines.push(`Zeitraum;Monate;${months.length}`);
  lines.push(
    `Gesamt;Umsatz_EUR;${(totals.amount || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  );
  lines.push(`Gesamt;Deals;${totals.deals || 0}`);
  lines.push(
    `Gesamt;Ø_Monatsumsatz_EUR;${(totals.averageAmount || 0).toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  );
  lines.push(
    `Gesamt;Ø_Deals_pro_Monat;${(totals.averageDeals || 0).toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  );
  if (totals.bestMonth) {
    lines.push(`Gesamt;Bester_Monat;${totals.bestMonth.label}`);
    lines.push(
      `Gesamt;Bester_Monat_Umsatz_EUR;${(totals.bestMonth.amount || 0).toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    );
    lines.push(`Gesamt;Bester_Monat_Deals;${totals.bestMonth.count || 0}`);
  }
  lines.push('');
  lines.push('Monate;Monat;Umsatz_EUR;Deals;Kumuliert_EUR');
  months.forEach((month) => {
    lines.push(
      `Monat;${month.label};${(month.amount || 0).toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })};${month.count || 0};${(month.cumulativeAmount || 0).toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    );
  });

  const csvContent = '\ufeff' + lines.join('\n');
  downloadBlob(csvContent, 'text/csv;charset=utf-8;', buildTrendExportFilename('csv'));
}

function exportTrendXlsx() {
  const trendData = getTrendData();
  if (!trendData) {
    showToast('Keine Trenddaten zum Exportieren vorhanden.', 'warn');
    return;
  }
  if (typeof XLSX === 'undefined') {
    showToast('XLSX-Bibliothek nicht verfügbar.', 'bad');
    return;
  }

  const wb = XLSX.utils.book_new();
  const { period, totals, months } = trendData;

  const summarySheet = [
    { Kennzahl: 'Von', Wert: period.from || '' },
    { Kennzahl: 'Bis', Wert: period.to || '' },
    { Kennzahl: 'Monate', Wert: months.length },
    { Kennzahl: 'Gesamtumsatz EUR', Wert: Number((totals.amount || 0).toFixed(2)) },
    { Kennzahl: 'Ø Monatsumsatz EUR', Wert: Number((totals.averageAmount || 0).toFixed(2)) },
    { Kennzahl: 'Deals gesamt', Wert: totals.deals || 0 },
    { Kennzahl: 'Ø Deals pro Monat', Wert: Number((totals.averageDeals || 0).toFixed(2)) },
  ];

  if (totals.bestMonth) {
    summarySheet.push({ Kennzahl: 'Bester Monat', Wert: totals.bestMonth.label });
    summarySheet.push({ Kennzahl: 'Bester Monat Umsatz EUR', Wert: Number((totals.bestMonth.amount || 0).toFixed(2)) });
    summarySheet.push({ Kennzahl: 'Deals im besten Monat', Wert: totals.bestMonth.count || 0 });
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summarySheet), 'Übersicht');

  const monthSheet = months.map((month) => ({
    Monat: month.label,
    Umsatz_EUR: Number((month.amount || 0).toFixed(2)),
    Deals: month.count || 0,
    Kumuliert_EUR: Number((month.cumulativeAmount || 0).toFixed(2)),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(monthSheet), 'Monate');

  XLSX.writeFile(wb, buildTrendExportFilename('xlsx'));
}

if (btnAnaXlsx) {
  btnAnaXlsx.addEventListener('click', () => {
    const year = anaYear.value;
    const wb = XLSX.utils.book_new();
    const analyticsData = getAnalyticsData();

    if (analyticsData.persons && analyticsData.persons.length > 0) {
      const ws1Arr = analyticsData.persons.map(p => ({
        Name: p.name,
        Team: p.team,
        Beitrag_Ist_EUR: Number((p.actual || 0).toFixed(2)),
        Beitrag_Gewichtet_EUR: Number((p.weighted || 0).toFixed(2)),
        Faktor: p.actual > 0 ? Number((p.weighted / p.actual).toFixed(2)) : '',
        Delta_EUR: Number(((p.weighted || 0) - (p.actual || 0)).toFixed(2)),
      }));
      const ws1 = XLSX.utils.json_to_sheet(ws1Arr);
      XLSX.utils.book_append_sheet(wb, ws1, "Salesbeiträge Personen");
    }
    if (analyticsData.teams && analyticsData.teams.length > 0) {
      const ws2Arr = analyticsData.teams.map(t => ({
        Team: t.name,
        Beitrag_Ist_EUR: Number((t.actual || 0).toFixed(2)),
        Beitrag_Gewichtet_EUR: Number((t.weighted || 0).toFixed(2)),
        Faktor: t.actual > 0 ? Number((t.weighted / t.actual).toFixed(2)) : '',
        Delta_EUR: Number(((t.weighted || 0) - (t.actual || 0)).toFixed(2)),
      }));
      const ws2 = XLSX.utils.json_to_sheet(ws2Arr);
      XLSX.utils.book_append_sheet(wb, ws2, "Salesbeiträge Teams");
    }
    if (analyticsData.totals && analyticsData.totals.length > 0) {
      const ws3Arr = analyticsData.totals.map(t => ({
        Typ: t.name,
        Betrag_Ist_EUR: Number((t.actual || 0).toFixed(2)),
        Betrag_Gewichtet_EUR: Number((t.weighted || 0).toFixed(2)),
        Delta_EUR: Number(((t.weighted || 0) - (t.actual || 0)).toFixed(2)),
      }));
      const ws3 = XLSX.utils.json_to_sheet(ws3Arr);
      XLSX.utils.book_append_sheet(wb, ws3, "Gesamt");
    }

    const activityChart = document.getElementById('chartActivity');
    if (activityChart && activityChart.innerHTML !== '') {
      const start = anaStartDate.value;
      const end = anaEndDate.value;
      const activityItems = Array.from(document.querySelectorAll('#chartActivity g')).map(g => {
        const name = g.querySelector('text[x="10"]').textContent;
        const valueText = g.querySelector('text[font-weight="700"]').textContent;
        const amountMatch = valueText.match(/([\d.]+,\d+)\s€/);
        const amount = amountMatch ? parseAmountInput(amountMatch[1]) : 0;
        const countMatch = valueText.match(/\((\d+)\)/);
        const count = countMatch ? parseInt(countMatch[1]) : null;
        return { Rahmenvertrag: name, Betrag_EUR: amount, Abrufe: count };
      });
      if (activityItems.length > 0) {
        const ws4 = XLSX.utils.json_to_sheet(activityItems);
        XLSX.utils.book_append_sheet(wb, ws4, `Aktivität ${start}-${end}`);
      }
    }

    if (wb.SheetNames.length > 0) {
      XLSX.writeFile(wb, `auswertung_${year}_export.xlsx`);
    } else {
      showToast('Keine Daten zum Exportieren vorhanden.', 'warn');
    }
  });
}
