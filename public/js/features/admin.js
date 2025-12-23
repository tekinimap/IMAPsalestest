import { WORKER_BASE, TEAMS } from '../config.js';
import { fetchWithRetry } from '../api.js';
import { showLoader, hideLoader, showToast } from '../ui/feedback.js';
import { escapeHtml } from '../utils/format.js';
import { people, loadPeople } from './people.js';

let admName;
let admTeam;
let admBody;
let adminSearch;
let adminInitialized = false;
let archiveYearSelect;
let archiveButton;

function getElements() {
  admName = document.getElementById('adm_name');
  admTeam = document.getElementById('adm_team');
  admBody = document.getElementById('adm_body');
  adminSearch = document.getElementById('adminSearch');
  return Boolean(admName && admTeam && admBody && adminSearch);
}

function createArchiveSection() {
  const adminCardBody = document.querySelector('#viewAdmin .ct');
  if (!adminCardBody || document.getElementById('archiveSection')) return;

  const section = document.createElement('div');
  section.id = 'archiveSection';
  section.innerHTML = `
    <div class="hr"></div>
    <div class="card" style="box-shadow:none;padding:0;">
      <div class="hd" style="padding:0 0 8px 0;">
        <h3>Daten-Archivierung</h3>
        <p class="note" style="margin-bottom:0;">Verschiebt abgeschlossene Fixaufträge ins Archiv. Rahmenverträge bleiben erhalten.</p>
      </div>
      <div class="ct" style="padding:0;">
        <div class="grid-admin" style="align-items:flex-end;">
          <div>
            <label for="archiveYear">Jahr wählen</label>
            <select id="archiveYear" class="ipt"></select>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-end;">
            <button class="btn warn" id="archiveSubmit">Jahr abschließen & archivieren</button>
          </div>
        </div>
      </div>
    </div>
  `;

  adminCardBody.appendChild(section);
  archiveYearSelect = section.querySelector('#archiveYear');
  archiveButton = section.querySelector('#archiveSubmit');

  populateArchiveYears();
  archiveButton?.addEventListener('click', handleArchiveSubmit);
}

function populateArchiveYears() {
  if (!archiveYearSelect) return;
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, idx) => currentYear - 1 - idx);

  archiveYearSelect.innerHTML = '';
  years.forEach((year, index) => {
    const option = document.createElement('option');
    option.value = String(year);
    option.textContent = String(year);
    if (index === 0) option.selected = true;
    archiveYearSelect.appendChild(option);
  });
}

async function handleArchiveSubmit() {
  if (!archiveYearSelect || !archiveButton) return;
  const year = archiveYearSelect.value;
  if (!year) {
    showToast('Bitte ein Jahr auswählen.', 'bad');
    return;
  }

  const confirmArchive = window.confirm('Wirklich archivieren?');
  if (!confirmArchive) return;

  const originalText = archiveButton.textContent;
  archiveButton.disabled = true;
  archiveButton.textContent = 'Archivierung läuft...';
  showLoader();

  try {
    const r = await fetchWithRetry('/api/entries/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: Number(year) }),
    });

    if (!r.ok) throw new Error(await r.text());
    showToast('Erfolgreich archiviert', 'ok');
    window.location.reload();
  } catch (err) {
    console.error('Archive request failed', err);
    showToast('Archivierung fehlgeschlagen.', 'bad');
  } finally {
    archiveButton.disabled = false;
    archiveButton.textContent = originalText;
    hideLoader();
  }
}

export function populateAdminTeamOptions() {
  if (!admTeam) return;
  const previousValue = admTeam.value;
  const placeholderText = admTeam.getAttribute('data-placeholder') || '— bitte wählen —';
  const fragment = document.createDocumentFragment();

  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = placeholderText;
  fragment.appendChild(placeholderOption);

  (TEAMS || []).forEach((teamName) => {
    const option = document.createElement('option');
    option.value = teamName;
    option.textContent = teamName;
    fragment.appendChild(option);
  });

  admTeam.innerHTML = '';
  admTeam.appendChild(fragment);

  if (previousValue && (TEAMS || []).includes(previousValue)) {
    admTeam.value = previousValue;
  } else {
    admTeam.value = '';
  }
}

export function renderPeopleAdmin() {
  if (!admBody || !adminSearch) return;
  admBody.innerHTML = '';
  const query = adminSearch.value.toLowerCase();
  const filteredPeople = people.filter((p) => {
    const nameMatch = (p.name || '').toLowerCase().includes(query);
    const teamMatch = (p.team || '').toLowerCase().includes(query);
    return nameMatch || teamMatch;
  });

  filteredPeople.forEach((p) => {
    const tr = document.createElement('tr');
    const safeName = escapeHtml(p.name || '');
    tr.innerHTML = `
      <td><input type="text" value="${safeName}"></td>
      <td><select>${TEAMS.map((t) => `<option value="${escapeHtml(t)}" ${p.team === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select></td>
      <td style="display:flex;gap:8px">
        <button class="iconbtn" data-act="save" data-id="${p.id}" title="Speichern"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></button>
        <button class="iconbtn" data-act="del" data-id="${p.id}" title="Löschen"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d=\"M3 6h18\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/></svg></button>
      </td>`;
    admBody.appendChild(tr);
  });
}

async function adminCreate() {
  if (!admName || !admTeam) return;
  const name = admName.value.trim();
  const team = admTeam.value;
  if (!name || !team) {
    showToast('Bitte Name und Team ausfüllen.', 'bad');
    return;
  }
  showLoader();
  try {
    const payload = { id: `p_${Date.now()}`, name, team };
    const r = await fetchWithRetry(`${WORKER_BASE}/people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast('Person angelegt.', 'ok');
    admName.value = '';
    admTeam.value = '';
    await loadPeople();
    renderPeopleAdmin();
  } catch (err) {
    showToast('Anlegen fehlgeschlagen.', 'bad');
    console.error('Network error', err);
  } finally {
    hideLoader();
  }
}

async function handleAdminAction(ev) {
  const btn = ev.target.closest('button[data-act]');
  if (!btn || !admBody) return;
  const id = btn.getAttribute('data-id');
  const act = btn.getAttribute('data-act');
  const tr = btn.closest('tr');
  showLoader();
  try {
    if (act === 'save') {
      const name = tr.querySelector('td:nth-child(1) input').value.trim();
      const team = tr.querySelector('td:nth-child(2) select').value;
      if (!name) {
        showToast('Name darf nicht leer sein.', 'bad');
        return;
      }
      const existingPerson = people.find((person) => person.id === id);
      const payload = { ...(existingPerson || {}), id, name, team };
      const r = await fetchWithRetry(`${WORKER_BASE}/people`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await r.text());
      showToast('Person gespeichert.', 'ok');
      await loadPeople();
      renderPeopleAdmin();
    } else if (act === 'del') {
      const r = await fetchWithRetry(`${WORKER_BASE}/people`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, _delete: true }),
      });
      if (!r.ok) throw new Error(await r.text());
      showToast('Person gelöscht.', 'ok');
      await loadPeople();
      renderPeopleAdmin();
    }
  } catch (e) {
    showToast('Aktion fehlgeschlagen.', 'bad');
    console.error(e);
  } finally {
    hideLoader();
  }
}

export function initAdminModule() {
  if (adminInitialized) return;
  if (!getElements()) return;

  const addButton = document.getElementById('adm_add');
  addButton?.addEventListener('click', () => adminCreate());
  admName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') adminCreate();
  });
  adminSearch?.addEventListener('input', renderPeopleAdmin);
  admBody?.addEventListener('click', handleAdminAction);
  populateAdminTeamOptions();
  createArchiveSection();
  adminInitialized = true;
}

export async function handleAdminClick() {
  if (!adminInitialized) {
    initAdminModule();
  }
  if (!adminInitialized) {
    console.warn('Admin-Module konnte nicht initialisiert werden – fehlen DOM-Elemente?');
    return;
  }
  try {
    showLoader();
    await loadPeople();
    populateAdminTeamOptions();
    renderPeopleAdmin();
  } catch (e) {
    console.error('Admin init failed', e);
    showToast('Konnte Admin-Daten nicht laden.', 'bad');
  } finally {
    hideLoader();
  }
}
