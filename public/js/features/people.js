import { WORKER_BASE } from '../config.js';
import { fetchWithRetry } from '../api.js';
import { showLoader, hideLoader, showToast } from '../ui/feedback.js';

export let currentSession = { email: '', name: '', rawName: '', person: null };
export let people = [];

const peopleList = document.getElementById('peopleList');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

export function updateRecognizedPersonFromPeople() {
  if (!Array.isArray(people) || people.length === 0) {
    if (currentSession.person) {
      currentSession.person = null;
    }
    return;
  }
  const emailLower = normalizeEmail(currentSession.email);
  if (emailLower) {
    const matchedByEmail = people.find((person) => normalizeEmail(person?.email) === emailLower);
    if (matchedByEmail) {
      currentSession.person = matchedByEmail;
      currentSession.name = matchedByEmail.name || currentSession.name || '';
      return;
    }
  }
  const nameLower = normalizeName(currentSession.name);
  if (nameLower) {
    const matchedByName = people.find((person) => normalizeName(person?.name) === nameLower);
    if (matchedByName) {
      currentSession.person = matchedByName;
      currentSession.name = matchedByName.name || currentSession.name || '';
    }
  }
}

export async function loadSession() {
  try {
    const response = await fetchWithRetry(`${WORKER_BASE}/session`, { cache: 'no-store' });
    if (!response.ok) {
      if (response.status !== 404) {
        console.warn('Session konnte nicht geladen werden (Status):', response.status);
      }
      currentSession = { email: '', name: '', rawName: '', person: null };
      return;
    }
    const data = await response.json();
    currentSession.email = String(data?.email || '').trim();
    currentSession.rawName = String(data?.name || '').trim();
    currentSession.person = data?.person && typeof data.person === 'object' ? data.person : null;

    if (currentSession.person) {
      currentSession.name = String(currentSession.person.name || '').trim() || currentSession.rawName;
    } else {
      currentSession.name = String(data?.displayName || '').trim() || currentSession.rawName;
    }
  } catch (err) {
    console.warn('Session konnte nicht geladen werden:', err);
    currentSession = { email: '', name: '', rawName: '', person: null };
  }
  updateRecognizedPersonFromPeople();
}

function normalizePeopleList(list) {
  return Array.isArray(list)
    ? list.map((person) => {
        const normalized = { ...person };
        if (normalized.email && typeof normalized.email === 'string') {
          normalized.email = normalized.email.trim();
        }
        return normalized;
      })
    : [];
}

function renderPeopleDatalist() {
  if (!peopleList) return;
  peopleList.innerHTML = '';
  people.forEach((p) => {
    const option = document.createElement('option');
    option.value = p.name;
    peopleList.appendChild(option);
  });
}

export async function loadPeople() {
  showLoader();
  try {
    const response = await fetchWithRetry(`${WORKER_BASE}/people`, { cache: 'no-store' });
    people = response.ok ? await response.json() : [];
  } catch (err) {
    people = [];
    showToast('Personenliste konnte nicht geladen werden.', 'bad');
  } finally {
    hideLoader();
  }

  people = normalizePeopleList(people);
  people.sort((a, b) => {
    const lastA = (a.name || '').split(' ').pop();
    const lastB = (b.name || '').split(' ').pop();
    return lastA.localeCompare(lastB, 'de');
  });

  renderPeopleDatalist();
  updateRecognizedPersonFromPeople();
}

export function findPersonByName(name) {
  return people.find((p) => p.name && normalizeName(p.name) === normalizeName(name));
}

export function findPersonByEmail(email) {
  const target = normalizeEmail(email);
  if (!target) return undefined;
  return people.find((person) => normalizeEmail(person?.email) === target);
}
