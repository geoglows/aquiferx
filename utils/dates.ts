// A stored measurement date as YYYY-MM-DD. Imports store ISO dates; the
// sample regions store MM/DD/YYYY. Neither goes through new Date(), which
// reads "2003-02-24" as UTC midnight, the evening before in the Americas.
export function isoDate(date: string): string {
  const s = (date || '').trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
