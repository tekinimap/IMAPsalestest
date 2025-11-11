export const EMAIL_SUGGESTION_SKIP_PATTERN = /(mitarbeiter|team|lead|\(|\)|\+|\/|\.)/i;

const UMLAUT_REPLACEMENTS = Object.freeze({
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  Ä: 'ae',
  Ö: 'oe',
  Ü: 'ue',
});

export function normalizeEmailComponent(value) {
  return String(value || '')
    .replace(/[äöüßÄÖÜ]/g, (ch) => UMLAUT_REPLACEMENTS[ch] || ch)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

export function shouldSkipEmailSuggestion(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return true;
  return EMAIL_SUGGESTION_SKIP_PATTERN.test(trimmed);
}

export function suggestEmailForName(name) {
  if (shouldSkipEmailSuggestion(name)) return '';
  const trimmed = String(name || '').trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return '';
  const localPart = parts
    .slice(1)
    .map(normalizeEmailComponent)
    .filter(Boolean)
    .join('');
  if (!localPart) return '';
  return `${localPart}@imap-institut.de`;
}
