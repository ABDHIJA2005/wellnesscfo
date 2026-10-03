export type ImportedRow = { id: string; date: string; merchant: string; amount: number; kind: 'expense'|'income'; category: string; selected: boolean; duplicate: boolean };

const categoryFor = (s: string) => /salary|stipend|refund|deposit|interest|credited/i.test(s) ? 'Income' : /food|cafe|restaurant|grocery|swiggy|zomato/i.test(s) ? 'Food' : /uber|ola|metro|fuel|petrol|transport/i.test(s) ? 'Transport' : /electric|water|rent|bill|airtel|jio/i.test(s) ? 'Bills' : /pharmacy|hospital|medical/i.test(s) ? 'Health' : /netflix|spotify|subscription/i.test(s) ? 'Subscriptions' : /amazon|flipkart|shopping/i.test(s) ? 'Shopping' : 'Other';
const safeText = (s: string) => s.replace(/\b\d{8,}\b/g, '••••').replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gi, '••••••••••').replace(/\s+/g, ' ').trim().slice(0, 72);
const dateIso = (s: string) => {
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/); if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/); if (m) { let y=Number(m[3]); if(y<100)y+=2000; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  const d=new Date(s); return Number.isNaN(d.getTime())?'':`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const amount = (s: string) => { const neg=/^\s*\(.*\)\s*$/.test(s)||/^\s*-/.test(s); const n=Number(s.replace(/[₹,\s()]/g,'').replace(/INR|Rs\.?/gi,'')); return Number.isFinite(n)?(neg?-Math.abs(n):n):0; };
const csvRows = (src: string) => { const rows:string[][]=[]; let row:string[]=[], cell='', quoted=false; for(let i=0;i<src.length;i++){const c=src[i];if(c==='"'){if(quoted&&src[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell.trim());cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&src[i+1]==='\n')i++;row.push(cell.trim());if(row.some(Boolean))rows.push(row);row=[];cell='';}else cell+=c;}row.push(cell.trim());if(row.some(Boolean))rows.push(row);return rows; };
const keyFor = (r: Pick<ImportedRow,'date'|'amount'|'kind'|'merchant'>) => `${r.date}|${r.amount.toFixed(2)}|${r.kind}|${r.merchant.toLowerCase().replace(/[^a-z0-9]/g,'')}`;
export function parseCsv(text:string, existing: Array<Pick<ImportedRow,'date'|'amount'|'kind'|'merchant'>> = []): ImportedRow[] {
  const rows=csvRows(text); if(rows.length<2)throw new Error('This CSV has no transaction rows.');
  const norm=(s:string)=>s.toLowerCase().replace(/[^a-z]/g,'');
  const head=rows[0].map(norm); const find=(tests:string[])=>head.findIndex(h=>tests.some(t=>h.includes(t)));
  const di=find(['transactiondate','valuedate','date','postingdate']), desc=find(['description','narration','remarks','details','merchant','particulars']);
  const debit=find(['debit','withdrawal','withdrawals','dr']), credit=find(['credit','deposit','deposits','cr']), amt=find(['amount','transactionamount']); const type=find(['type','drcr','transactiontype']);
  if(di<0||desc<0||(debit<0&&credit<0&&amt<0))throw new Error('Could not identify date, description and amount columns. Use a CSV with headers such as Date, Description, Debit and Credit.');
  const dup=new Set(existing.map(keyFor)); const parsed:ImportedRow[]=[];
  rows.slice(1).forEach((r,i)=>{ const date=dateIso(r[di]||''); const merchant=safeText(r[desc]||''); if(!date||!merchant)return;
    let value=0, kind:'expense'|'income'='expense';
    if(debit>=0||credit>=0){const d=amount(r[debit]||''),c=amount(r[credit]||''); if(Math.abs(c)>0){value=Math.abs(c);kind='income';}else if(Math.abs(d)>0){value=Math.abs(d);kind='expense';}}
    else {value=amount(r[amt]||''); const t=(r[type]||'').toLowerCase();kind=/cr|credit|deposit/.test(t)||value<0?'income':'expense';value=Math.abs(value);}
    if(!value)return; const base={date,merchant,amount:value,kind,category:categoryFor(merchant)}; const duplicate=dup.has(keyFor(base)); parsed.push({...base,id:`imp-${i}-${Date.now()}`,selected:!duplicate,duplicate});
  });
  if(!parsed.length)throw new Error('No readable transactions found. Check that the date and amount columns contain values.'); return parsed;
}
export function parsePdfText(text:string, existing: Array<Pick<ImportedRow,'date'|'amount'|'kind'|'merchant'>> = []): ImportedRow[] {
  if(text.trim().length<20)throw new Error('No selectable text found. Scanned/image-only PDFs are not supported yet. Try exporting a digital PDF or CSV from your bank.');
  const dup=new Set(existing.map(keyFor)), out:ImportedRow[]=[];
  const dateRe=/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/;
  for(const [i,line0] of text.split(/\r?\n/).entries()) { const line=line0.replace(/\s+/g,' ').trim(); const dm=line.match(dateRe); if(!dm)continue;const date=dateIso(dm[0]);if(!date)continue;const rest=line.slice((dm.index||0)+dm[0].length).trim(); const nums=[...rest.matchAll(/(?:₹|INR\s*)?\(?-?\d[\d,]*(?:\.\d{1,2})?\)?/gi)];if(!nums.length)continue;
    // Most statements end a transaction line with its amount and then a running balance.
    const marked=/\b(cr|credit|credited|deposit)\b/i.test(rest), debitMark=/\b(dr|debit|withdrawal|withdrawn)\b/i.test(rest); const candidates=nums.map(x=>amount(x[0])).filter(n=>Math.abs(n)>0);if(!candidates.length)continue;
    const val=Math.abs(candidates.length>1?candidates[candidates.length-2]:candidates[0]); if(!val)continue;const kind:'income'|'expense'=marked?'income':debitMark?'expense':(candidates[candidates.length-1]<0?'income':'expense');
    const lastNum=nums[nums.length-1];let merchant=rest.slice(0,lastNum.index).replace(/\b(cr|credit|credited|deposit|dr|debit|withdrawal|withdrawn)\b/ig,'').replace(/[|*]+/g,' ').trim();merchant=safeText(merchant);if(merchant.length<2)continue;const base={date,merchant,amount:val,kind,category:categoryFor(merchant)},duplicate=dup.has(keyFor(base));out.push({...base,id:`pdf-${i}-${Date.now()}`,selected:!duplicate,duplicate});
  }
  if(!out.length)throw new Error('Could not find transaction rows in this PDF. Try your bank’s CSV export; PDF layouts vary between banks.'); return out;
}

