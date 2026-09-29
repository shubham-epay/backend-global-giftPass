/**
 * Minimal RFC 4180 CSV parser (no dependencies).
 * Handles quoted fields, escaped quotes (""), commas / newlines inside quotes, CRLF and a UTF-8 BOM.
 * Auto-detects the delimiter (comma, semicolon or tab) from the header line.
 * Returns an array of rows, each an array of strings.
 */
function detectDelimiter(text) {
  const firstLine = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

function parseCsv(input, { delimiter } = {}) {
  const text = String(input).replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === d) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop fully blank lines (e.g. trailing newline, spacer rows).
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const escapeCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(escapeCell).join(',')).join('\r\n');

module.exports = { parseCsv, toCsv };
