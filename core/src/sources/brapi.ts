import { holidays } from '../br/calendar';
import { getJson } from '../http';
import type { Asset, Quote } from '../types';

/**
 * brapi.dev, plano gratuito sem token. `quote/list` traz a B3 inteira em 2 páginas (Fase 0: 2.357 ativos).
 * Limite medido: 20 req/min por IP. A lista não informa o horário do preço: o selo usa o horário da
 * consulta e o atraso declarado do plano grátis (~30 min).
 */
const API = 'https://brapi.dev/api';
const SOURCE = 'brapi';
export const BRAPI_FREE_DELAY_MIN = 30;

interface Row {
  stock: string;
  name: string;
  close: number | null;
  change: number | null;
  volume: number | null;
  market_cap: number | null;
  sector: string | null;
  subsector?: string | null;
  type: string;
  subType?: string | null;
}
interface ListResp {
  stocks: Row[];
  totalCount?: number;
  totalPages?: number;
  hasNextPage?: boolean;
}

/** Classe do Pulso para cada subtipo da brapi. FIIs, Fiagro e FI-Infra vão para a aba FIIs. */
export function classify(r: Row): { cls: Asset['cls']; kind: string } | null {
  if (r.type === 'stock') return { cls: 'br', kind: 'ação' };
  if (r.type === 'bdr') return { cls: 'br', kind: 'bdr' };
  if (r.type === 'fund') {
    if (r.subType === 'fii') return { cls: 'fii', kind: 'fii' };
    if (r.subType === 'fi-agro') return { cls: 'fii', kind: 'fiagro' };
    if (r.subType === 'fi-infra') return { cls: 'fii', kind: 'fi-infra' };
    if (r.subType === 'etf') return { cls: 'br', kind: 'etf' };
    return { cls: 'br', kind: r.subType ?? 'fundo' };
  }
  return null;
}

export const b3Id = (ticker: string) => `b3:${ticker}`;

export function parseList(j: ListResp, fetchedAt: number): { assets: Asset[]; quotes: Quote[] } {
  const assets: Asset[] = [];
  const quotes: Quote[] = [];
  for (const r of j.stocks) {
    // Mercado fracionário (PETR4F) é o mesmo papel em lote menor: não vira ativo separado.
    if (/\dF$/.test(r.stock)) continue;
    const c = classify(r);
    if (!c) continue;
    const id = b3Id(r.stock);
    assets.push({ id, symbol: r.stock, name: r.name, cls: c.cls, kind: c.kind, quote: 'BRL', ref: `${r.stock}.SA`, meta: { sector: r.subsector ?? r.sector ?? undefined, marketCap: r.market_cap ?? undefined } });
    if (r.close != null && r.close > 0)
      quotes.push({
        assetId: id,
        price: r.close,
        changePct: r.change ?? undefined,
        volume: r.volume ?? undefined,
        sourceTime: fetchedAt,
        receivedAt: fetchedAt,
        source: SOURCE,
        delivery: 'delayed',
        declaredDelayMin: BRAPI_FREE_DELAY_MIN,
        timeIsFetch: true,
      });
  }
  return { assets, quotes };
}

/**
 * Fechamentos só da B3 (além dos feriados nacionais): sem pregão em 24/12 e 31/12.
 * Prática da B3 nos calendários recentes (2023–2025, ex.: b3.com.br "Como será o funcionamento
 * da B3 no Natal e no Ano Novo"). Conferir o ofício circular de feriados de cada ano.
 */
const B3_EXTRA_CLOSED = ['12-24', '12-31'];

/** Pregão regular da B3 (dias úteis, 10h–17h de Brasília), sem feriados nacionais nem 24/12 e 31/12. */
export function b3Open(now = Date.now()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday');
  if (['Sat', 'Sun'].includes(wd)) return false;
  const y = +get('year');
  const md = `${get('month')}-${get('day')}`;
  if (holidays(y).has(`${y}-${md}`) || B3_EXTRA_CLOSED.includes(md)) return false;
  const mins = (+get('hour') % 24) * 60 + +get('minute');
  return mins >= 600 && mins < 1020;
}

export const brapi = {
  source: SOURCE,
  /** Mercado inteiro. Gasta 2 requisições. */
  async all(): Promise<{ assets: Asset[]; quotes: Quote[] }> {
    const assets: Asset[] = [];
    const quotes: Quote[] = [];
    for (let page = 1; page <= 5; page++) {
      const t = Date.now();
      const j = await getJson<ListResp>(`${API}/quote/list?limit=10000&page=${page}`, undefined, 30_000);
      const p = parseList(j, t);
      assets.push(...p.assets);
      quotes.push(...p.quotes);
      if (!j.hasNextPage) break;
    }
    const open = b3Open();
    for (const q of quotes) q.marketState = open ? 'open' : 'closed';
    return { assets, quotes };
  },
};
