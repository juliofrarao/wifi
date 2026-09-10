/** Minimal RFC 4180 CSV reader/writer (`;` separated, UTF-8 with or without BOM). */

export function parseCsv(input: string | Buffer, delimiter = ';'): string[][] {
  let text = typeof input === 'string' ? input : input.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully empty trailing rows.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Cells starting with = + - @ or a tab/CR are formulas for Excel/LibreOffice: neutralize them. */
const FORMULA_START = /^[\s]*[=+\-@\t\r]/;

export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  const prefixed = typeof value === 'string' && FORMULA_START.test(s);
  if (prefixed) s = `'${s}`;
  return prefixed || /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text with BOM, `;` and CRLF (the format the spec mandates). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return `\uFEFF${rows.map((r) => r.map(csvEscape).join(';')).join('\r\n')}\r\n`;
}
