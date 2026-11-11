/**
 * Carteiras de fundos brasileiros pelos dados abertos da CVM (CDA, composição mensal).
 * Defasagem legal: o mês sai cerca de 40 dias depois; posições podem ficar confidenciais por até 90 dias.
 * Arquivo grande (≈ 15 MB por mês): processado só no PC.
 */
import { unzipSync } from 'fflate';
import { getBytes } from '../http';

export interface FundHolding {
  ticker: string;
  qty: number;
  value: number;
  /** Peso nas ações do fundo (fração). */
  weight: number;
}

export interface FundPortfolio {
  cnpj: string;
  name: string;
  date: string; // aaaa-mm-dd (data de competência)
  equityBRL: number;
  netAssetsBRL?: number;
  holdings: FundHolding[];
}

const rows = (t: string) => t.split(/\r?\n/).filter(Boolean).map((l) => l.split(';'));

/** Ações (bloco 4 da CDA) agrupadas por fundo. Só fundos com pelo menos `minEquity` em ações. */
export function parseCdaStocks(blc4: string, pl?: string, minEquity = 0): Map<string, FundPortfolio> {
  const r = rows(blc4);
  const h = r[0];
  const i = (n: string) => h.indexOf(n);
  const [iC, iN, iD, iQ, iV, iT] = [i('CNPJ_FUNDO_CLASSE'), i('DENOM_SOCIAL'), i('DT_COMPTC'), i('QT_POS_FINAL'), i('VL_MERC_POS_FINAL'), i('CD_ATIVO')];
  const out = new Map<string, FundPortfolio>();
  for (const c of r.slice(1)) {
    const ticker = c[iT];
    const value = Number(c[iV]);
    if (!ticker || !(value > 0)) continue; // posição zerada no fim do mês não entra
    let f = out.get(c[iC]);
    if (!f) out.set(c[iC], (f = { cnpj: c[iC], name: c[iN], date: c[iD], equityBRL: 0, holdings: [] }));
    const ex = f.holdings.find((x) => x.ticker === ticker);
    if (ex) {
      ex.qty += Number(c[iQ]);
      ex.value += value;
    } else f.holdings.push({ ticker, qty: Number(c[iQ]), value, weight: 0 });
    f.equityBRL += value;
  }
  if (pl) {
    const p = rows(pl);
    const ph = p[0];
    for (const c of p.slice(1)) {
      const f = out.get(c[ph.indexOf('CNPJ_FUNDO_CLASSE')]);
      if (f) f.netAssetsBRL = Number(c[ph.indexOf('VL_PATRIM_LIQ')]);
    }
  }
  for (const [k, f] of out) {
    if (f.equityBRL < minEquity) {
      out.delete(k);
      continue;
    }
    for (const h2 of f.holdings) h2.weight = h2.value / f.equityBRL;
    f.holdings.sort((a, b) => b.value - a.value);
  }
  return out;
}

export function fundDiff(now: FundPortfolio, before?: FundPortfolio): { ticker: string; status: 'NOVA' | 'ZEROU' | 'AUMENTOU' | 'REDUZIU' | 'IGUAL'; qtyBefore: number; qtyAfter: number }[] {
  const b = new Map((before?.holdings ?? []).map((h) => [h.ticker, h]));
  const n = new Map(now.holdings.map((h) => [h.ticker, h]));
  const out: { ticker: string; status: 'NOVA' | 'ZEROU' | 'AUMENTOU' | 'REDUZIU' | 'IGUAL'; qtyBefore: number; qtyAfter: number }[] = [];
  if (!before) return out;
  for (const [t, h] of n) {
    const q = b.get(t);
    out.push({ ticker: t, status: !q ? 'NOVA' : h.qty > q.qty ? 'AUMENTOU' : h.qty < q.qty ? 'REDUZIU' : 'IGUAL', qtyBefore: q?.qty ?? 0, qtyAfter: h.qty });
  }
  for (const [t, q] of b) if (!n.has(t)) out.push({ ticker: t, status: 'ZEROU', qtyBefore: q.qty, qtyAfter: 0 });
  return out;
}

const ym = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** Último mês publicado (tenta os 4 meses anteriores) e o mês anterior a ele, para comparar. */
export async function fetchCdaMonth(monthsBack: number): Promise<{ month: string; blc4: string; pl: string } | null> {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  const month = ym(d);
  try {
    const { bytes } = await getBytes(`https://dados.cvm.gov.br/dados/FI/DOC/CDA/DADOS/cda_fi_${month}.zip`, 180_000);
    const files = unzipSync(bytes, { filter: (f) => /BLC_4|_PL_/.test(f.name) });
    const dec = new TextDecoder('latin1');
    const b = Object.keys(files).find((n) => n.includes('BLC_4'));
    const p = Object.keys(files).find((n) => n.includes('_PL_'));
    if (!b) return null;
    return { month, blc4: dec.decode(files[b]), pl: p ? dec.decode(files[p]) : '' };
  } catch {
    return null;
  }
}
