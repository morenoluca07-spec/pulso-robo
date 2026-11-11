/**
 * Negociações declaradas por deputados dos EUA (STOCK Act): índice anual do House Clerk e leitura das PTRs.
 * Portado do trader-pelosi (ptr.py, Jakeschincariol/trader-skill, licença MIT).
 * Valores são FAIXAS (ex.: US$ 1.001 a 15.000) e chegam com até 45 dias de atraso legal.
 */
import { unzipSync } from 'fflate';
import { getBytes } from '../http';

export const LATE_DAYS = 45;
const INDEX_URL = (y: number) => `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${y}FD.zip`;
export const PTR_URL = (y: number, doc: string) => `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${y}/${doc}.pdf`;

export interface PtrFiling {
  docId: string;
  type: string;
  name: string;
  first: string;
  last: string;
  district: string;
  year: number;
  filed: string; // aaaa-mm-dd
  url: string;
}

const iso = (mdy: string) => {
  const m = mdy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};

export function parseIndexXml(xml: string, year: number): PtrFiling[] {
  const out: PtrFiling[] = [];
  for (const m of xml.match(/<Member>[\s\S]*?<\/Member>/g) ?? []) {
    const f = (t: string) => m.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1]?.trim() ?? '';
    const type = f('FilingType');
    const y = Number(f('Year')) || year;
    const doc = f('DocID');
    out.push({
      docId: doc,
      type,
      first: f('First'),
      last: f('Last'),
      name: [f('Prefix'), f('First'), f('Last'), f('Suffix')].filter(Boolean).join(' '),
      district: f('StateDst'),
      year: y,
      filed: iso(f('FilingDate')),
      url: type === 'P' ? PTR_URL(y, doc) : `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${y}/${doc}.pdf`,
    });
  }
  return out.sort((a, b) => (b.filed + b.docId).localeCompare(a.filed + a.docId));
}

export function indexFromZip(bytes: Uint8Array, year: number): PtrFiling[] {
  const files = unzipSync(bytes);
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith('.xml'));
  if (!name) throw new Error('Índice do House Clerk sem XML.');
  return parseIndexXml(new TextDecoder('utf-8').decode(files[name]), year);
}

export async function fetchPtrIndex(year = new Date().getFullYear()): Promise<PtrFiling[]> {
  const { bytes } = await getBytes(INDEX_URL(year));
  return indexFromZip(bytes, year).filter((f) => f.type === 'P');
}

/* ---------- leitura de uma PTR (texto em layout) ---------- */

export interface PtrRow {
  owner: string;
  ownerName: string;
  asset: string;
  ticker?: string;
  assetType?: string;
  type: string;
  typeName: string;
  date: string;
  notified: string;
  amount: string;
  amountLow?: number;
  amountHigh?: number;
  description?: string;
  option?: { contracts: number; kind: 'call' | 'put'; strike: number; expires: string };
  daysToDisclose?: number;
  late?: boolean;
}

const OWNERS: Record<string, string> = { '': 'próprio', SP: 'cônjuge', JT: 'conjunta', DC: 'filho(a) dependente' };
const TYPES: Record<string, string> = { P: 'compra', S: 'venda', 'S (partial)': 'venda parcial', E: 'troca' };
const TXN = /^\s*(?:(SP|JT|DC)\s+)?(.*?)\s+(S \(partial\)|P|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\S.*?)\s*$/;
const PAGE_HEADER = /^\s*(ID\s+Owner\s+Asset|Type\s+Date\b|Type$|Date$|Gains >$|\$200\?$)/i;
const END = /^\s*(\* For the complete|I CERTIFY|Digitally Signed|Filing ID #)/i;
const LABELS: [string, RegExp][] = [
  ['status', /^\s*F(?:ILING)?\s+S(?:TATUS)?\s*:\s*(.*)$/i],
  ['description', /^\s*D(?:ESCRIPTION)?\s*:\s*(.*)$/i],
  ['account', /^\s*S(?:UBHOLDING)?\s+O(?:F)?\s*:\s*(.*)$/i],
  ['location', /^\s*L(?:OCATION)?\s*:\s*(.*)$/i],
];

export function parsePtrText(text: string, filed?: string): { name?: string; docId?: string; filed?: string; rows: PtrRow[] } {
  const head: { name?: string; docId?: string; filed?: string } = { filed };
  type Cur = PtrRow & { _asset: string };
  const rows: Cur[] = [];
  let cur: Cur | null = null;
  let mode: 'asset' | 'labels' | 'description' | null = null;
  let amountOpen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const s = line.trim();
    let m = s.match(/^Name:\s+(.*)$/);
    if (m && !head.name) {
      head.name = m[1].trim();
      continue;
    }
    m = s.match(/Filing ID #(\d+)/);
    if (m) {
      head.docId = m[1];
      continue;
    }
    m = s.match(/^Digitally Signed:.*?,\s*(\d{2}\/\d{2}\/\d{4})/);
    if (m) {
      head.filed ||= iso(m[1]);
      continue;
    }
    const t = line.match(TXN);
    if (t && iso(t[4])) {
      if (cur) rows.push(cur);
      cur = { owner: t[1] ?? '', ownerName: OWNERS[t[1] ?? ''] ?? t[1], _asset: t[2], asset: '', type: t[3], typeName: TYPES[t[3]] ?? t[3], date: iso(t[4]), notified: iso(t[5]), amount: t[6] };
      amountOpen = cur.amount.endsWith('-');
      mode = 'asset';
      continue;
    }
    if (!cur) continue;
    if (!s) {
      if (mode === 'description' || (mode === 'asset' && cur._asset.includes('['))) mode = 'labels';
      continue;
    }
    if (PAGE_HEADER.test(s)) continue;
    if (END.test(s)) {
      mode = 'labels';
      continue;
    }
    const lab = LABELS.find(([, rx]) => rx.test(line));
    if (lab) {
      const v = line.match(lab[1])![1].trim();
      if (lab[0] === 'description') {
        cur.description = v;
        mode = 'description';
      } else mode = 'labels';
      continue;
    }
    if (mode === 'asset') {
      const parts = s.split(/\s{2,}/);
      if (amountOpen && /^\$[\d,]+$/.test(parts[parts.length - 1])) {
        cur.amount += ' ' + parts.pop();
        amountOpen = false;
      }
      if (parts.length && parts[0]) cur._asset += ' ' + parts.join(' ');
    } else if (mode === 'description') cur.description = `${cur.description ?? ''} ${s}`;
  }
  if (cur) rows.push(cur);
  return {
    ...head,
    rows: rows.map((r) => {
      const asset = r._asset.split(/\s+/).join(' ');
      const tick = [...asset.matchAll(/\(([A-Z][A-Z0-9.\-/]{0,9})\)/g)].map((x) => x[1]);
      const code = [...asset.matchAll(/\[([A-Z]{2})\]/g)].map((x) => x[1]);
      let name = asset.replace(/\s*\[[A-Z]{2}\]/g, '');
      if (tick.length) name = name.replace(`(${tick[tick.length - 1]})`, '');
      const nums = [...r.amount.matchAll(/\$([\d,]+)/g)].map((x) => Number(x[1].replace(/,/g, '')));
      const desc = r.description?.split(/\s+/).join(' ').trim() || undefined;
      const opt = desc?.match(/([\d,]+)\s+(call|put)\s+options?\b.*?strike price of \$([\d,.]+).*?expiration date of (\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      const out: PtrRow = {
        owner: r.owner,
        ownerName: r.ownerName,
        asset: name.trim().replace(/^[\s-]+|[\s-]+$/g, ''),
        ticker: tick[tick.length - 1],
        assetType: code[code.length - 1],
        type: r.type,
        typeName: r.typeName,
        date: r.date,
        notified: r.notified,
        amount: r.amount.split(/\s+/).join(' '),
        amountLow: nums[0],
        amountHigh: nums[1],
        description: desc,
        option: opt ? { contracts: Number(opt[1].replace(/,/g, '')), kind: opt[2].toLowerCase() as 'call' | 'put', strike: Number(opt[3].replace(/,/g, '')), expires: iso(opt[4]) || opt[4] } : undefined,
      };
      if (head.filed && out.date) {
        out.daysToDisclose = Math.round((Date.parse(head.filed) - Date.parse(out.date)) / 86_400_000);
        out.late = out.daysToDisclose > LATE_DAYS;
      }
      return out;
    }),
  };
}

/**
 * Reconstrói linhas "em layout" a partir dos pedaços de texto de um PDF (pdf.js): agrupa por altura e
 * insere 2+ espaços onde há vão horizontal, imitando `pdftotext -layout`, que o parser espera.
 */
export function layoutFromItems(items: { str: string; x: number; y: number; w: number }[], charW = 4.5): string {
  // Agrupa pedaços cuja altura difere até 2 pontos (o PDF desloca um pouco letras de colunas diferentes).
  // Letras em versalete ("FILING STATUS") chegam como caractere nulo: viram espaço, como no pdftotext.
  const clean = items.map((it) => ({ ...it, str: it.str.replace(/\u0000/g, ' ') }));
  const sorted = clean.filter((it) => it.str.trim()).sort((a, b) => b.y - a.y);
  const groups: { y: number; its: typeof items }[] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.y - it.y) <= 2) g.its.push(it);
    else groups.push({ y: it.y, its: [it] });
  }
  return groups
    .map(({ its }) => {
      its.sort((a, b) => a.x - b.x);
      let s = '';
      let prevEnd = 0;
      for (const it of its) {
        const col = Math.round(it.x / charW);
        if (!s) s = ' '.repeat(Math.max(0, col));
        else {
          const gap = it.x - prevEnd;
          const need = gap > charW * 1.5 ? 2 : gap > charW * 0.3 ? 1 : 0; // vão grande = troca de coluna
          s += ' '.repeat(Math.max(need, col - s.length));
        }
        s += it.str;
        prevEnd = it.x + it.w;
      }
      return s;
    })
    .join('\n');
}
