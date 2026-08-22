const NEEDS_QUOTING = /[",\n\r]/;

export function csvEscape(field: string): string {
  if (!NEEDS_QUOTING.test(field)) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

export function csvRow(fields: string[]): string {
  return fields.map(csvEscape).join(',') + '\n';
}
