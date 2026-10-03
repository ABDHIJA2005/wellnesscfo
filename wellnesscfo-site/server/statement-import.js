'use strict';

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 10000;

function parseCsvRecords(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The selected CSV file is empty.');
  if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) throw new Error('CSV files must be 2 MB or smaller.');
  const source = text.replace(/^\uFEFF/, '');
  const delimiter = (() => {
    const first = source.split(/\r?\n/, 1)[0];
    const counts = [',', ';', '\t'].map(ch => {
      let quoted = false, count = 0;
      for (let i = 0; i < first.length; i++) {
        if (first[i] === '"' && quoted && first[i + 1] === '"') i++;
        else if (first[i] === '"') quoted = !quoted;
        else if (!quoted && first[i] === ch) count++;
      }
      return count;
    });
    const max = Math.max(...counts);
    if (!max) throw new Error('Could not find CSV columns. Check the delimiter and header row.');
    return [',', ';', '\t'][counts.indexOf(max)];
  })();
  const records = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') {
      if (field.length) throw new Error('Malformed CSV: quote found inside an unquoted field.');
      quoted = true;
    } else if (ch === delimiter) { row.push(field.trim()); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(v => v !== '')) records.push(row);
      row = [];
      if (records.length > MAX_ROWS + 1) throw new Error(`CSV files may contain at most ${MAX_ROWS} rows.`);
    } else field += ch;
  }
  if (quoted) throw new Error('Malformed CSV: a quoted field was not closed.');
  row.push(field.trim());
  if (row.some(v => v !== '')) records.push(row);
  if (records.length < 2) throw new Error('CSV needs a header row and at least one transaction row.');
  if (records.length > MAX_ROWS + 1) throw new Error(`CSV files may contain at most ${MAX_ROWS} rows.`);
  const headers = records.shift().map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const find = aliases => headers.findIndex(h => aliases.includes(h));
  const date = find(['date', 'transactiondate', 'txndate', 'valuedate']);
  const description = find(['description', 'narration', 'remarks', 'remark', 'details', 'particulars']);
  const debit = find(['debit', 'withdrawal', 'dr']);
  const credit = find(['credit', 'deposit', 'cr']);
  const amount = find(['amount', 'transactionamount']);
  const type = find(['type', 'transactiontype', 'drcr', 'direction']);
  const category = find(['category']);
  if (date < 0 || description < 0 || (amount < 0 && debit < 0 && credit < 0)) {
    throw new Error('Required columns are missing. Add a date, description/narration, and amount or debit/credit columns.');
  }
  return records.map((cells, index) => {
    const get = i => i < 0 ? '' : (cells[i] || '');
    const d = get(debit), c = get(credit), a = get(amount);
    const parsed = { date: get(date), description: get(description), category: get(category), type: get(type), _rowNumber: index + 2 };
    if (a !== '') parsed.amount = a;
    if (d !== '') parsed.debit = d;
    if (c !== '') parsed.credit = c;
    if (cells.length !== headers.length) parsed._rowError = 'Row has a different number of columns than the header.';
    return parsed;
  });
}

module.exports = { parseCsvRecords, MAX_CSV_BYTES, MAX_ROWS };
