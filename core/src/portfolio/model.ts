/** Carteira: posições em bolsa/cripto (cotadas pelas fontes) e renda fixa (valor estimado ou informado). */

export type HoldingClass = 'br' | 'fii' | 'us' | 'crypto' | 'meme' | 'fixed' | 'cash';
export type FixedProduct = 'cdb' | 'lci' | 'lca' | 'lc' | 'tesouro-selic' | 'tesouro-pre' | 'tesouro-ipca' | 'poupanca' | 'debenture' | 'cri-cra' | 'outro';

export interface FixedInfo {
  product: FixedProduct;
  /** cdi/selic: % do índice (100 = 100%). pre: % a.a. ipca: taxa real % a.a. */
  index: 'cdi' | 'selic' | 'pre' | 'ipca' | 'poupanca';
  rate: number;
  appliedBRL: number;
  appliedAt: string; // aaaa-mm-dd
  maturity?: string;
  /** Liquidez diária (conta para a reserva de emergência). */
  daily: boolean;
  /** Valor atual informado por você (extrato). Se vazio, o app estima. */
  currentBRL?: number;
}

export interface Holding {
  id: string;
  cls: HoldingClass;
  label: string;
  /** Ativo cotado (b3:PETR4, us:AAPL, crypto:BTCUSDT…). Ausente em renda fixa e caixa. */
  assetId?: string;
  qty: number;
  /** Preço médio de compra, na moeda do ativo. */
  avgPrice: number;
  currency: string;
  institution: string;
  sector?: string;
  /** Conta no exterior (corretora fora do Brasil). */
  abroad: boolean;
  fixed?: FixedInfo;
  /** Caixa: valor em reais. */
  cashBRL?: number;
}

export interface Valued extends Holding {
  valueBRL: number;
  costBRL: number;
  /** Valor estimado (renda fixa sem extrato) em vez de cotado. */
  estimated: boolean;
  /** Sem cotação nem câmbio: fica fora dos totais. */
  missing: boolean;
}

export const CLASS_LABEL: Record<HoldingClass, string> = { br: 'Ações Brasil', fii: 'FIIs', us: 'Exterior', crypto: 'Cripto', meme: 'Memecoins', fixed: 'Renda fixa', cash: 'Caixa' };

export const FGC_COVERED: FixedProduct[] = ['cdb', 'lci', 'lca', 'lc', 'poupanca'];

/** Estima o valor de renda fixa pela taxa contratada e o CDI/Selic/IPCA atuais (premissa constante). */
export function estimateFixed(f: FixedInfo, today: string, m: { cdi: number; selic: number; ipca: number }): number {
  if (f.currentBRL !== undefined) return f.currentBRL;
  const days = Math.max(0, (Date.parse(today) - Date.parse(f.appliedAt)) / 86_400_000);
  const du = (days * 252) / 365;
  let factor = 1;
  if (f.index === 'cdi' || f.index === 'selic') {
    const base = f.index === 'cdi' ? m.cdi : m.selic;
    factor = (1 + ((1 + base) ** (1 / 252) - 1) * (f.rate / 100)) ** du;
  } else if (f.index === 'pre') factor = (1 + f.rate / 100) ** (du / 252);
  else if (f.index === 'ipca') factor = ((1 + f.rate / 100) * (1 + m.ipca)) ** (du / 252);
  else if (f.index === 'poupanca') factor = 1.005 ** Math.floor(days / 30);
  return f.appliedBRL * factor;
}

export function valueHoldings(
  hs: Holding[],
  price: (assetId: string) => number | undefined,
  fx: (currency: string) => number | undefined,
  market: { cdi: number; selic: number; ipca: number } | null,
  today = new Date().toISOString().slice(0, 10),
): Valued[] {
  return hs.map((h) => {
    if (h.cls === 'cash') return { ...h, valueBRL: h.cashBRL ?? 0, costBRL: h.cashBRL ?? 0, estimated: false, missing: false };
    if (h.cls === 'fixed' && h.fixed) {
      if (h.fixed.currentBRL === undefined && !market) return { ...h, valueBRL: 0, costBRL: h.fixed.appliedBRL, estimated: true, missing: true };
      return { ...h, valueBRL: estimateFixed(h.fixed, today, market ?? { cdi: 0, selic: 0, ipca: 0 }), costBRL: h.fixed.appliedBRL, estimated: h.fixed.currentBRL === undefined, missing: false };
    }
    const p = h.assetId ? price(h.assetId) : undefined;
    const r = fx(h.currency);
    if (p === undefined || r === undefined) return { ...h, valueBRL: 0, costBRL: h.qty * h.avgPrice * (r ?? 0), estimated: false, missing: true };
    return { ...h, valueBRL: h.qty * p * r, costBRL: h.qty * h.avgPrice * r, estimated: false, missing: false };
  });
}

export function groupBy(vs: Valued[], key: (v: Valued) => string): { key: string; valueBRL: number; pct: number }[] {
  const total = vs.reduce((a, v) => a + v.valueBRL, 0) || 1;
  const m = new Map<string, number>();
  for (const v of vs) if (!v.missing) m.set(key(v), (m.get(key(v)) ?? 0) + v.valueBRL);
  return [...m.entries()].map(([k, val]) => ({ key: k, valueBRL: val, pct: val / total })).sort((a, b) => b.valueBRL - a.valueBRL);
}

/** Índice de concentração (Herfindahl): 1/n = espalhado; 1 = tudo num ativo. */
export function hhi(vs: Valued[]): number {
  const total = vs.reduce((a, v) => a + v.valueBRL, 0);
  if (!total) return 0;
  return vs.reduce((a, v) => a + (v.valueBRL / total) ** 2, 0);
}
