/**
 * Formulário 13F da SEC: carteira de fim de trimestre de gestoras dos EUA (divulgada até 45 dias depois).
 * Portado do trader-copycat (edgar13f.py, Jakeschincariol/trader-skill, licença MIT).
 * O 13F é da GESTORA, não da pessoa, e só mostra posições compradas em ações listadas nos EUA.
 * A SEC exige User-Agent com nome e e-mail reais: o app pede ao usuário, nunca inventa.
 */
import { getJson, getText } from '../http';

export const SEC = {
  submissions: (cik: string) => `https://data.sec.gov/submissions/CIK${cik10(cik)}.json`,
  archive: (cik: string, acc: string) => `https://www.sec.gov/Archives/edgar/data/${Number(cik10(cik))}/${acc.replace(/-/g, '')}/`,
  tickers: 'https://www.sec.gov/files/company_tickers.json',
  figi: 'https://api.openfigi.com/v3/mapping',
};

export const cik10 = (v: string | number) => String(v).replace(/\D/g, '').padStart(10, '0');

export interface Filing {
  form: string;
  accession: string;
  filed: string;
  period: string;
}

export function listFilings(sub: { filings?: { recent?: Record<string, string[]> } }): Filing[] {
  const r = sub.filings?.recent ?? {};
  const out: Filing[] = [];
  (r.form ?? []).forEach((form, i) => {
    if (form !== '13F-HR' && form !== '13F-HR/A') return;
    out.push({ form, accession: r.accessionNumber[i], filed: r.filingDate[i], period: r.reportDate?.[i] ?? '' });
  });
  return out.sort((a, b) => (b.filed + b.accession).localeCompare(a.filed + a.accession));
}

/** O 13F-HR original mais recente (ou o anterior a `before`). Emendas não substituem o original aqui. */
export function pickFiling(fs: Filing[], before?: string): Filing | undefined {
  return fs.filter((f) => f.form === '13F-HR' && (!before || f.period < before)).sort((a, b) => (b.period + b.filed).localeCompare(a.period + a.filed))[0];
}

export function infoTableName(index: { directory?: { item?: { name: string }[] } }): string {
  const names = (index.directory?.item ?? []).map((i) => i.name);
  const xmls = names.filter((n) => n.toLowerCase().endsWith('.xml') && !['primary_doc.xml', 'filingsummary.xml'].includes(n.toLowerCase()));
  if (!xmls.length) throw new Error(`13F sem tabela XML (arquivos: ${names.join(', ')}). Antes de 2013 o formato era texto e não é suportado.`);
  return xmls.find((n) => /info|table|13f/i.test(n)) ?? xmls[0];
}

/** Valores em dólares a partir de 03/01/2023; antes, em milhares. */
export const valueMultiplier = (filed: string) => (filed >= '2023-01-03' ? 1 : 1000);

export interface Row13F {
  issuer: string;
  title: string;
  cusip: string;
  value: number;
  shares: number;
  shareType: string;
  putCall: string;
}

const tag = (block: string, name: string) => block.match(new RegExp(`<(?:\\w+:)?${name}>\\s*([^<]*?)\\s*</(?:\\w+:)?${name}>`))?.[1] ?? '';

export function parseInfoTable(xml: string, mult = 1): Row13F[] {
  const blocks = xml.match(/<(?:\w+:)?infoTable>[\s\S]*?<\/(?:\w+:)?infoTable>/g) ?? [];
  if (!blocks.length) throw new Error('Tabela do 13F sem linhas.');
  return blocks.map((b) => ({
    issuer: tag(b, 'nameOfIssuer').replace(/&amp;/g, '&'),
    title: tag(b, 'titleOfClass'),
    cusip: tag(b, 'cusip').toUpperCase(),
    value: Number(tag(b, 'value').replace(/,/g, '') || 0) * mult,
    shares: Number(tag(b, 'sshPrnamt').replace(/,/g, '') || 0),
    shareType: (tag(b, 'sshPrnamtType') || 'SH').toUpperCase(),
    putCall: tag(b, 'putCall').toUpperCase(),
  }));
}

export interface Position13F {
  issuer: string;
  title: string;
  cusip: string;
  cusips: string[];
  value: number;
  shares: number;
  shareType: string;
  putCall: string;
  /** Peso no 13F (%). */
  pct: number;
  ticker?: string;
  name: string;
  /** Ticker achado por aproximação de nome: conferir. */
  check?: boolean;
}

export const isStock = (p: { shareType: string; putCall: string }) => p.shareType === 'SH' && !p.putCall;

/** Uma posição por CUSIP (e por PUT/CALL), somando as linhas divididas por gestor; classes do mesmo emissor juntas. */
export function aggregate13F(rows: Row13F[]): { positions: Position13F[]; total: number } {
  const total = rows.reduce((a, r) => a + r.value, 0);
  const g = new Map<string, Position13F>();
  for (const r of rows) {
    const k = `${r.cusip}|${r.putCall}|${r.shareType}`;
    const cur = g.get(k);
    if (cur) {
      cur.value += r.value;
      cur.shares += r.shares;
    } else g.set(k, { ...r, cusips: [r.cusip], pct: 0, name: r.issuer });
  }
  // Classes do mesmo emissor (6 primeiros caracteres do CUSIP), só ações.
  const out: Position13F[] = [];
  const byIssuer = new Map<string, Position13F>();
  for (const p of [...g.values()].sort((a, b) => b.value - a.value)) {
    if (!isStock(p)) {
      out.push(p);
      continue;
    }
    const k = p.cusip.slice(0, 6);
    const q = byIssuer.get(k);
    if (!q) {
      byIssuer.set(k, p);
      out.push(p);
    } else {
      q.value += p.value;
      q.shares += p.shares;
      q.cusips.push(p.cusip);
    }
  }
  for (const p of out) p.pct = total ? +((100 * p.value) / total).toFixed(2) : 0;
  return { positions: out.sort((a, b) => b.value - a.value), total };
}

/* ---------- tickers ---------- */

const ABBREV: Record<string, string> = { AMER: 'AMERICA', AMERN: 'AMERICAN', FINL: 'FINANCIAL', FIN: 'FINANCIAL', PETE: 'PETROLEUM', HLDGS: 'HOLDINGS', HLDG: 'HOLDING', INTL: 'INTERNATIONAL', GRP: 'GROUP', SVCS: 'SERVICES', SYS: 'SYSTEMS', MGMT: 'MANAGEMENT', INDS: 'INDUSTRIES', NATL: 'NATIONAL', ENTMT: 'ENTERTAINMENT', LABS: 'LABORATORIES', TECH: 'TECHNOLOGY', TECHS: 'TECHNOLOGIES', COMMNS: 'COMMUNICATIONS', ELEC: 'ELECTRIC', PHARMS: 'PHARMACEUTICALS', RES: 'RESOURCES', MTRS: 'MOTORS', AIRLS: 'AIRLINES', CHEM: 'CHEMICAL' };
const DROP = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC', 'LLC', 'LP', 'SA', 'NV', 'AG', 'SE', 'THE', 'AND', 'OF']);
const NONCOMMON = /-P[A-Z]*$|-WT[A-Z]*$|-WS$|-U$|-UN$|-R$|-RT$/;

function normName(n: string): string[] {
  let s = (n || '').toUpperCase().replace(/&/g, ' AND ');
  for (let i = 0; i < 2; i++) s = s.replace(/\s*\/\s*[A-Z]{2,5}\s*\/?\s*$/, '');
  s = s.replace(/['’]/g, '').replace(/[^A-Z0-9 ]+/g, ' ');
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBREV[w] ?? w)
    .filter((w) => !DROP.has(w));
}
const normTicker = (t: string) => (NONCOMMON.test(t) ? t : t.trim().toUpperCase().replace(/[-/ ]([A-Z]{1,2})$/, '.$1'));

export class TickerIndex {
  private byCik = new Map<string, string[]>();
  private spaceless = new Map<string, Set<string>>();
  private sorted = new Map<string, Set<string>>();
  constructor(data: Record<string, { cik_str: number; ticker: string; title: string }>) {
    for (const v of Object.values(data)) {
      const cik = cik10(v.cik_str);
      const first = !this.byCik.has(cik);
      this.byCik.set(cik, [...(this.byCik.get(cik) ?? []), v.ticker]);
      if (!first) continue;
      const w = normName(v.title);
      const a = w.join('');
      const b = [...w].sort().join(' ');
      if (a) {
        if (!this.spaceless.has(a)) this.spaceless.set(a, new Set());
        this.spaceless.get(a)!.add(cik);
        if (!this.sorted.has(b)) this.sorted.set(b, new Set());
        this.sorted.get(b)!.add(cik);
      }
    }
  }
  match(issuer: string): { cik: string; prefix: boolean } | null {
    const w = normName(issuer);
    const a = w.join('');
    if (!a) return null;
    for (const hits of [this.spaceless.get(a), this.sorted.get([...w].sort().join(' '))]) if (hits?.size === 1) return { cik: [...hits][0], prefix: false };
    const best: [number, string][] = [];
    for (const [k, ciks] of this.spaceless) if (k.length >= 8 && ciks.size === 1 && (a.startsWith(k) || k.startsWith(a))) best.push([k.length, [...ciks][0]]);
    best.sort((x, y) => y[0] - x[0]);
    if (best.length === 1 || (best.length > 1 && best[0][0] > best[1][0])) return { cik: best[0][1], prefix: true };
    return null;
  }
  ticker(cik: string, title: string): { ticker?: string; check: boolean } {
    const ts = this.byCik.get(cik) ?? [];
    const c = ts.filter((t) => !NONCOMMON.test(t));
    const cands = c.length ? c : ts;
    if (!cands.length) return { check: true };
    if (cands.length === 1 || cands.slice(1).every((t) => t.startsWith(cands[0]))) return { ticker: normTicker(cands[0]), check: false };
    const letter = (title || '').toUpperCase().match(/\b(?:CL|CLASS|SER|SERIES)\s*([A-Z])\b/)?.[1];
    if (letter) {
      const hit = cands.find((t) => /[-./]/.test(t.slice(-2, -1)) && t.toUpperCase().endsWith(letter));
      if (hit) return { ticker: normTicker(hit), check: false };
    }
    return { ticker: normTicker(cands[0]), check: true };
  }
}

export function parseFigi(cusips: string[], answer: { data?: { ticker?: string; marketSector?: string }[] }[]): Record<string, string> {
  const out: Record<string, string> = {};
  cusips.forEach((c, i) => {
    const d = answer[i]?.data ?? [];
    const eq = d.filter((x) => x.marketSector === 'Equity');
    const t = (eq.length ? eq : d)[0]?.ticker;
    if (t) out[c] = normTicker(t);
  });
  return out;
}

const prettyName = (n: string) =>
  n
    .replace(/\s*\/\s*[A-Z]{2,5}\s*\/?\s*$/, '')
    .replace(/,?\s+(INC|CORP|CO|LTD|PLC|LLC)\.?$/i, '')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

export function resolveTickers(ps: Position13F[], idx: TickerIndex | null, figi: Record<string, string> = {}): Position13F[] {
  for (const p of ps) {
    const f = figi[p.cusip];
    if (f) {
      p.ticker = f;
      p.check = false;
    } else if (idx) {
      const m = idx.match(p.issuer);
      if (m) {
        const t = idx.ticker(m.cik, p.title);
        p.ticker = t.ticker;
        p.check = t.check || m.prefix;
      }
    }
    p.name = prettyName(p.issuer);
  }
  return ps;
}

/* ---------- comparação entre trimestres ---------- */

export type Change = 'NOVA' | 'ZEROU' | 'AUMENTOU' | 'REDUZIU' | 'IGUAL';
export interface Diff {
  status: Change;
  cusip: string;
  name: string;
  ticker?: string;
  putCall: string;
  sharesBefore: number;
  sharesAfter: number;
  changePct?: number;
  valueAfter: number;
  valueBefore: number;
}

export function diff13f(now: Position13F[], before: Position13F[]): Diff[] {
  const key = (p: Position13F) => `${p.cusip}|${p.putCall}`;
  const b = new Map(before.map((p) => [key(p), p]));
  const n = new Map(now.map((p) => [key(p), p]));
  const out: Diff[] = [];
  for (const [k, p] of n) {
    const q = b.get(k);
    const status: Change = !q ? 'NOVA' : p.shares > q.shares ? 'AUMENTOU' : p.shares < q.shares ? 'REDUZIU' : 'IGUAL';
    out.push({ status, cusip: p.cusip, name: p.name, ticker: p.ticker, putCall: p.putCall, sharesBefore: q?.shares ?? 0, sharesAfter: p.shares, changePct: q?.shares ? (100 * (p.shares - q.shares)) / q.shares : undefined, valueAfter: p.value, valueBefore: q?.value ?? 0 });
  }
  for (const [k, q] of b) if (!n.has(k)) out.push({ status: 'ZEROU', cusip: q.cusip, name: q.name, ticker: q.ticker, putCall: q.putCall, sharesBefore: q.shares, sharesAfter: 0, changePct: -100, valueAfter: 0, valueBefore: q.value });
  const rank: Record<Change, number> = { NOVA: 0, ZEROU: 1, AUMENTOU: 2, REDUZIU: 3, IGUAL: 4 };
  return out.sort((a, c) => rank[a.status] - rank[c.status] || Math.max(c.valueAfter, c.valueBefore) - Math.max(a.valueAfter, a.valueBefore));
}

/* ---------- busca na SEC ---------- */

export interface Report13F {
  filer: string;
  cik: string;
  period: string;
  filed: string;
  total: number;
  positions: Position13F[];
  diff: Diff[];
  previous?: { period: string; filed: string };
}

export async function fetch13F(cik: string, userAgent: string, tickersCache?: Record<string, { cik_str: number; ticker: string; title: string }>): Promise<Report13F> {
  if (!/@/.test(userAgent)) throw new Error('A SEC exige nome e e-mail reais no User-Agent. Preencha em Configurações.');
  const h = { headers: { 'User-Agent': userAgent, Accept: 'application/json' } };
  const pause = () => new Promise((r) => setTimeout(r, 150)); // bem abaixo do limite de 10 pedidos/s da SEC
  const sub = await getJson<{ name: string; filings: { recent: Record<string, string[]> } }>(SEC.submissions(cik), h);
  const fs = listFilings(sub);
  const cur = pickFiling(fs);
  if (!cur) throw new Error('Esta gestora não tem 13F-HR na lista recente da SEC.');
  const prev = pickFiling(fs, cur.period);
  const load = async (f: Filing) => {
    await pause();
    const idx = await getJson<{ directory: { item: { name: string }[] } }>(`${SEC.archive(cik, f.accession)}index.json`, h);
    await pause();
    const xml = await getText(SEC.archive(cik, f.accession) + infoTableName(idx), { headers: { 'User-Agent': userAgent } });
    return aggregate13F(parseInfoTable(xml, valueMultiplier(f.filed)));
  };
  const now = await load(cur);
  const before = prev ? await load(prev) : null;
  let idx: TickerIndex | null = null;
  try {
    idx = new TickerIndex(tickersCache ?? (await getJson(SEC.tickers, h)));
  } catch {
    idx = null;
  }
  resolveTickers(now.positions, idx);
  if (before) resolveTickers(before.positions, idx);
  return {
    filer: sub.name,
    cik: cik10(cik),
    period: cur.period,
    filed: cur.filed,
    total: now.total,
    positions: now.positions,
    diff: before ? diff13f(now.positions, before.positions) : [],
    previous: prev && { period: prev.period, filed: prev.filed },
  };
}
