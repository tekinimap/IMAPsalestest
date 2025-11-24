import { findPersonByName } from './people.js';
import { fmtCurr0, fmtInt } from '../utils/format.js';

// State
let state = {
    dealValue: 0,
    globalWeights: { cs: 50, konzept: 30, pitch: 20 },
    persons: [], // { id, name, team, shares: { cs: 0, konzept: 0, pitch: 0 } }
    stratFactor: 1.0
};

const CATEGORIES = ['cs', 'konzept', 'pitch'];
const CAT_LABELS = { cs: 'Consultative Selling', konzept: 'Konzept', pitch: 'Pitch' };

// DOM Elements
let modal, dealValueInput, personListContainer, globalSliders = {};

export function initDealArchitect() {
    modal = document.getElementById('dealArchitectModal');
    if (!modal) return;

    // Bind Global Inputs
    dealValueInput = document.getElementById('da-deal-value');
    dealValueInput.addEventListener('input', handleDealValueChange);

    document.getElementById('da-strat-slider').addEventListener('input', handleStratFactorChange);

    // Bind Global Sliders
    CATEGORIES.forEach(cat => {
        const el = document.getElementById(`da-global-${cat}`);
        el.addEventListener('input', (e) => handleGlobalWeightChange(cat, parseInt(e.target.value)));
        globalSliders[cat] = el;
    });

    // Bind Add Person
    const addPersonInput = document.getElementById('da-add-person');
    // Simple mock search for now, ideally use a proper autocomplete
    addPersonInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            addPerson(e.target.value);
            e.target.value = '';
        }
    });

    render();
}

export function openDealArchitect(initialData = {}) {
    // Reset or Load Data
    state.dealValue = initialData.amount || 0;
    state.persons = initialData.persons || [];
    // ... load other data

    if (modal) modal.showModal();
    render();
}

function handleDealValueChange(e) {
    // Simple formatter
    let val = e.target.value.replace(/[^0-9]/g, '');
    state.dealValue = parseInt(val) || 0;
    e.target.value = new Intl.NumberFormat('de-DE').format(state.dealValue);
    updateCalculations();
}

function handleStratFactorChange(e) {
    state.stratFactor = parseFloat(e.target.value);
    document.getElementById('da-strat-val').textContent = state.stratFactor.toFixed(1) + 'x';
}

function handleGlobalWeightChange(changedCat, newVal) {
    // Snappy: Round to nearest 10
    newVal = Math.round(newVal / 10) * 10;

    // Constraint: Sum = 100
    // Simple approach: Adjust the next category
    let diff = newVal - state.globalWeights[changedCat];
    if (diff === 0) return;

    let remaining = 100 - newVal;

    // Distribute remaining to other categories
    // This is a simplified logic, a full 3-way slider logic is complex
    // For now, let's just update state and force sum=100 in render or validation
    // Better: Block change if it violates?

    // Let's try to adjust the others proportionally
    let others = CATEGORIES.filter(c => c !== changedCat);
    let sumOthers = others.reduce((acc, c) => acc + state.globalWeights[c], 0);

    if (sumOthers === 0) {
        // Can't adjust others, so can't change this one unless we decrease it?
        // If we decrease, we need to increase others.
        if (remaining > 0) {
            // Distribute evenly
            others.forEach(c => state.globalWeights[c] = remaining / others.length);
        }
    } else {
        others.forEach(c => {
            let ratio = state.globalWeights[c] / sumOthers;
            state.globalWeights[c] = Math.round((remaining * ratio) / 10) * 10;
        });
    }

    state.globalWeights[changedCat] = newVal;

    // Final fix to ensure 100 due to rounding
    let currentSum = CATEGORIES.reduce((acc, c) => acc + state.globalWeights[c], 0);
    if (currentSum !== 100) {
        let gap = 100 - currentSum;
        // Add gap to the largest other
        let target = others.sort((a, b) => state.globalWeights[b] - state.globalWeights[a])[0];
        state.globalWeights[target] += gap;
    }

    renderGlobalSliders();
    updateCalculations();
}

function addPerson(name) {
    const person = findPersonByName(name); // Assumes this is available
    if (!person) return; // Or create dummy

    state.persons.push({
        id: person.id || Date.now(),
        name: person.name || name,
        team: person.team || 'Unknown',
        shares: { cs: 0, konzept: 0, pitch: 0 }
    });
    renderPersonList();
}

function removePerson(index) {
    state.persons.splice(index, 1);
    renderPersonList();
}

function handlePersonShareChange(personIndex, cat, val) {
    // Snappy 10
    val = Math.round(val / 10) * 10;

    // Interdependency: Sum of this cat across all persons <= 100
    let currentSum = state.persons.reduce((acc, p, idx) => idx === personIndex ? acc : acc + p.shares[cat], 0);
    let maxAllowed = 100 - currentSum;

    if (val > maxAllowed) val = maxAllowed;

    state.persons[personIndex].shares[cat] = val;
    renderPersonList(); // Re-render to update other sliders' max/locked state
}

function updateCalculations() {
    // Update UI for money values
    state.persons.forEach((p, idx) => {
        let totalShare = 0;
        CATEGORIES.forEach(cat => {
            totalShare += (p.shares[cat] / 100) * (state.globalWeights[cat] / 100);
        });
        let money = state.dealValue * totalShare * state.stratFactor; // Apply strat factor? User said "Strategischer Faktor... Metadaten". Maybe it affects commission, not deal value distribution?
        // Usually deal value distribution sums to deal value. Strat factor might be for internal scoring.
        // Let's assume it just affects the "Value" displayed if requested, or maybe it's just metadata.
        // For now, let's calculate raw share of deal value.
        money = state.dealValue * totalShare;

        const el = document.getElementById(`da-money-${idx}`);
        if (el) el.textContent = fmtCurr0.format(money);
    });
}

function render() {
    renderGlobalSliders();
    renderPersonList();
}

function renderGlobalSliders() {
    CATEGORIES.forEach(cat => {
        const el = globalSliders[cat];
        if (el) {
            el.value = state.globalWeights[cat];
            document.getElementById(`da-global-val-${cat}`).textContent = state.globalWeights[cat] + '%';
        }
    });
}

function renderPersonList() {
    const container = document.getElementById('da-person-list');
    if (!container) return;
    container.innerHTML = '';

    state.persons.forEach((p, idx) => {
        const card = document.createElement('div');
        card.className = 'da-person-card';

        // Calculate total money for this person
        let totalShare = 0;
        CATEGORIES.forEach(cat => totalShare += (p.shares[cat] / 100) * (state.globalWeights[cat] / 100));
        let money = state.dealValue * totalShare;

        let slidersHtml = CATEGORIES.map(cat => {
            // Calculate max for this person in this category
            let otherSum = state.persons.reduce((acc, per, i) => i === idx ? acc : acc + per.shares[cat], 0);
            let max = 100 - otherSum;
            let isLocked = (otherSum + p.shares[cat]) === 100;

            return `
        <div class="da-mini-slider-row">
          <label>${CAT_LABELS[cat]}</label>
          <input type="range" min="0" max="100" step="10" value="${p.shares[cat]}" 
            oninput="window.daHandlePersonShare(${idx}, '${cat}', this.value)"
            class="da-slider ${isLocked ? 'locked' : ''}">
          <span>${p.shares[cat]}%</span>
        </div>
      `;
        }).join('');

        card.innerHTML = `
      <div class="da-card-header">
        <div class="da-person-info">
          <h3>${p.name}</h3>
          <span>${p.team}</span>
        </div>
        <div class="da-card-actions">
          <button class="da-remove-btn" onclick="window.daRemovePerson(${idx})">×</button>
          <span class="da-live-money" id="da-money-${idx}">${fmtCurr0.format(money)}</span>
        </div>
      </div>
      <div class="da-card-sliders">
        ${slidersHtml}
      </div>
    `;
        container.appendChild(card);
    });

    // Expose helpers to window for inline events (simplest for now)
    window.daHandlePersonShare = (idx, cat, val) => handlePersonShareChange(idx, cat, parseInt(val));
    window.daRemovePerson = (idx) => removePerson(idx);
}
