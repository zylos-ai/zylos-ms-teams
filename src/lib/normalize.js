export function normalize(value) {
  return String(value || '').trim();
}

export function normalizeName(value) {
  return normalize(value).toLowerCase();
}
