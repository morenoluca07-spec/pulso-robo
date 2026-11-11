import { getText } from '../http';
import { businessDays, isoFromBr } from './calendar';

/**
 * Tesouro Direto: arquivo público diário do Tesouro Transparente (14 MB com todo o histórico, do mais novo
 * para o mais antigo). Baixamos só o começo (~40 KB = últimos dias) com pedido parcial (Range).
 */
const URL_CSV = 'https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv';

export interface TdBond {
  type: string;
  maturity: string; // aaaa-mm-dd
  date: string; // data-base aaaa-mm-dd
  buyRate: number; // % a.a. (taxa de compra para o investidor)
  sellRate: number;
  buyPU: number;
  sellPU: number;
}

export interface TdOffer extends TdBond {
  /** Variação da taxa de compra contra a data-base anterior, em pontos percentuais. */
  rateChange?: number;
  /** Indexador para a curva e o comparador. */
  index: 'selic' | 'pre' | 'ipca' | 'igpm';
  coupons: boolean;
}

const n = (s: string) => Number(s.replace(',', '.'));

export function parseTdCsv(text: string): TdBond[] {
  const lines = text.split(/\r?\n/).slice(1);
  const out: TdBond[] = [];
  for (const l of lines) {
    const c = l.split(';');
    if (c.length < 8 || !/^\d{2}\/\d{2}\/\d{4}$/.test(c[2] ?? '')) continue; // a última linha do pedido parcial vem cortada
    out.push({ type: c[0], maturity: isoFromBr(c[1]), date: isoFromBr(c[2]), buyRate: n(c[3]), sellRate: n(c[4]), buyPU: n(c[5]), sellPU: n(c[6]) });
  }
  return out;
}

const indexOf = (t: string): TdOffer['index'] => (t.includes('Selic') ? 'selic' : t.includes('IPCA') || t.includes('Renda+') || t.includes('Educa+') ? 'ipca' : t.includes('IGPM') ? 'igpm' : 'pre');

/** Títulos da data-base mais recente, com a variação da taxa contra a data anterior. */
export function latestOffers(rows: TdBond[]): { date: string; offers: TdOffer[] } {
  const dates = [...new Set(rows.map((r) => r.date))].sort().reverse();
  const [last, prev] = dates;
  const prevMap = new Map(rows.filter((r) => r.date === prev).map((r) => [`${r.type}|${r.maturity}`, r.buyRate]));
  const offers = rows
    .filter((r) => r.date === last && r.maturity > last)
    .map((r) => {
      const p = prevMap.get(`${r.type}|${r.maturity}`);
      return { ...r, index: indexOf(r.type), coupons: r.type.includes('Juros Semestrais'), rateChange: p !== undefined ? +(r.buyRate - p).toFixed(4) : undefined };
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.maturity.localeCompare(b.maturity));
  return { date: last, offers };
}

/**
 * Preço unitário de um Tesouro Prefixado (LTN): 1000 / (1 + taxa)^(du/252).
 * `du` conta da data de liquidação até o vencimento.
 */
export function ltnPU(rate: number, settlement: string, maturity: string): number {
  return 1000 / (1 + rate / 100) ** (businessDays(settlement, maturity) / 252);
}

/** Curva de juros nominal (prefixados sem cupom) e real (IPCA+ sem cupom): prazo em anos × taxa. */
export function yieldCurves(offers: TdOffer[]): { nominal: { years: number; rate: number }[]; real: { years: number; rate: number }[] } {
  const yrs = (o: TdOffer) => (Date.parse(o.maturity) - Date.parse(o.date)) / (365.25 * 86_400_000);
  const pick = (idx: TdOffer['index']) =>
    offers
      .filter((o) => o.index === idx && !o.coupons && /^Tesouro (Prefixado|IPCA\+)$/.test(o.type))
      .map((o) => ({ years: +yrs(o).toFixed(2), rate: o.buyRate }))
      .sort((a, b) => a.years - b.years);
  return { nominal: pick('pre'), real: pick('ipca') };
}

export const tesouro = {
  source: 'Tesouro Transparente',
  url: URL_CSV,
  async latest(): Promise<{ date: string; offers: TdOffer[] }> {
    const text = await getText(URL_CSV, { headers: { Range: 'bytes=0-40000' } }, 30_000);
    return latestOffers(parseTdCsv(text));
  },
};
