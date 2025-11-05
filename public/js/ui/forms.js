import { clamp01, toInt0 } from '../utils/format.js';
import { setHasUnsavedChanges } from '../state.js';

export function createRowTemplate() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="name" placeholder="Namen eintippen oder auswählen..." list="peopleList"></td>
    <td><input type="number" class="cs" min="0" max="100" step="1" value="0"></td>
    <td><input type="number" class="konzept" min="0" max="100" step="1" value="0"></td>
    <td><input type="number" class="pitch" min="0" max="100" step="1" value="0"></td>
    <td><div class="live-result"><span class="pct">- %</span><span class="money">- €</span></div></td>
    <td><button class="delrow">Entfernen</button></td>`;
  return tr;
}

export function setupRow(tr, { saveCurrentInputState, recalc, findPersonByName }) {
  tr.addEventListener('input', (ev) => {
    setHasUnsavedChanges(true);
    if (ev.target.matches('input[type="number"]')) {
      ev.target.value = String(clamp01(toInt0(ev.target.value)));
    }
    if (ev.target.classList.contains('name')) {
      const person = findPersonByName(ev.target.value);
      if (person) {
        ev.target.dataset.personId = person.id;
      } else {
        delete ev.target.dataset.personId;
      }
    }
    saveCurrentInputState();
    recalc();
  });

  tr.querySelector('.delrow')?.addEventListener('click', () => {
    tr.remove();
    setHasUnsavedChanges(true);
    saveCurrentInputState();
    recalc();
  });
}

export function appendRow({
  tbody,
  focus = false,
  saveCurrentInputState,
  recalc,
  findPersonByName,
}) {
  const tr = createRowTemplate();
  tbody.appendChild(tr);
  setupRow(tr, { saveCurrentInputState, recalc, findPersonByName });
  if (focus) {
    tr.querySelector('.name')?.focus();
  }
  saveCurrentInputState();
  recalc();
  return tr;
}

export function readRows(tbodySelector = '#tbody') {
  const rows = [];
  document
    .querySelector(tbodySelector)
    .querySelectorAll('tr')
    .forEach((tr) => {
      rows.push({
        personId: tr.querySelector('.name').dataset.personId || null,
        name: (tr.querySelector('.name').value || '').trim(),
        cs: toInt0(tr.querySelector('.cs').value),
        konzept: toInt0(tr.querySelector('.konzept').value),
        pitch: toInt0(tr.querySelector('.pitch').value),
      });
    });
  return rows;
}
