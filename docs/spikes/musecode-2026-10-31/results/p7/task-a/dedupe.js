'use strict';

const fs = require('fs');

function parseLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function escapeField(v) {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function dedupeCsv(csvText, emailColumn = 'email') {
  const lines = csvText.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return '';
  const header = parseLine(lines[0]);
  const idx = header.findIndex((h) => h.trim().toLowerCase() === emailColumn.trim().toLowerCase());
  if (idx === -1) throw new Error(`email column "${emailColumn}" not found`);
  const seen = new Set();
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    const fields = parseLine(lines[i]);
    const key = normalizeEmail(fields[idx] ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fields.map(escapeField).join(','));
  }
  return out.join('\n') + '\n';
}

function main() {
  const [input, output, emailColumn] = process.argv.slice(2);
  if (!input) {
    console.error('Usage: node dedupe.js <input.csv> [output.csv] [email-column]');
    process.exit(1);
  }
  const text = fs.readFileSync(input, 'utf8');
  const result = dedupeCsv(text, emailColumn || 'email');
  if (output) fs.writeFileSync(output, result, 'utf8');
  else process.stdout.write(result);
}

if (require.main === module) main();

module.exports = { dedupeCsv, normalizeEmail };
