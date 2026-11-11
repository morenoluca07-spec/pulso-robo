import { getJson } from '../http';
import type { AssetClass, Candle, Interval, Quote } from '../types';
import { parseReturn12m, type Return12m } from '../invest/longTerm';

/**
 * Endpoint de gráfico do Yahoo Finance (não oficial, pode quebrar: por isso tem reserva).
 * Medido na Fase 0: B3 ~16 min de atraso, EUA ~2 min, câmbio ~2 min, futuros ~12 min.
 */
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const SOURCE = 'Yahoo';

export interface YahooMeta {
  symbol: string;
  currency?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  longName?: string;
  shortName?: string;
  instrumentType?: string;
  exchangeTimezoneName?: string;
  currentTradingPeriod?: { regular: { start: number; end: number } };
}
interface ChartResp {
  chart: {
    result: null | {
      meta: YahooMeta;
      timestamp?: number[];
      indicators: {
        quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[];
        adjclose?: { adjclose: (number | null)[] }[];
      };
    }[];
    error: null | { code: string; description: string };
  };
}

/** Atraso declarado por mercado (o selo usa o maior entre o medido e o declarado). */
export function declaredDelay(symbol: string): number {
  if (symbol.endsWith('.SA') || symbol === '^BVSP') return 15;
  if (symbol.endsWith('=F')) return 10;
  return 0;
}

export function parseYahooQuote(j: ChartResp, assetId: string, receivedAt: number, now = receivedAt): Quote {
  const r = j.chart.result?.[0];
  if (!r) throw new Error(`Yahoo: ${j.chart.error?.description ?? 'sem resultado'}`);
  const m = r.meta;
  if (m.regularMarketPrice === undefined || !m.regularMarketTime) throw new Error(`Yahoo: ${m.symbol} sem preço`);
  const prev = m.chartPreviousClose ?? m.previousClose;
  const reg = m.currentTradingPeriod?.regular;
  const nowS = now / 1000;
  return {
    assetId,
    price: m.regularMarketPrice,
    previousClose: prev,
    changePct: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : undefined,
    high: m.regularMarketDayHigh,
    low: m.regularMarketDayLow,
    volume: m.regularMarketVolume || undefined, // índices vêm com 0: sem volume não é volume zero
    sourceTime: m.regularMarketTime * 1000,
    receivedAt,
    source: SOURCE,
    delivery: 'delayed',
    declaredDelayMin: declaredDelay(m.symbol),
    marketState: reg ? (nowS >= reg.start && nowS < reg.end ? 'open' : 'closed') : undefined,
  };
}

/**
 * `adjusted` = preços ajustados por proventos e desdobramentos (para backtest: um dividendo não é queda).
 * Para o gráfico, use o preço real (sem ajuste).
 */
export function parseYahooCandles(j: ChartResp, adjusted = false): Candle[] {
  const r = j.chart.result?.[0];
  if (!r?.timestamp) return [];
  const q = r.indicators.quote[0];
  const adj = r.indicators.adjclose?.[0]?.adjclose;
  const out: Candle[] = [];
  r.timestamp.forEach((t, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) return; // candles vazios não viram dado
    const f = adjusted && adj?.[i] != null && c > 0 ? adj[i]! / c : 1;
    out.push({ time: t * 1000, open: o * f, high: h * f, low: l * f, close: c * f, volume: q.volume[i] ?? 0 });
  });
  return out;
}

/** Período e janela máximos que o Yahoo aceita por intervalo. */
const IV: Record<Interval, [string, string]> = {
  '1m': ['1m', '5d'],
  '5m': ['5m', '1mo'],
  '15m': ['15m', '1mo'],
  '1h': ['60m', '6mo'],
  '4h': ['60m', '2y'],
  '1d': ['1d', '10y'],
  '1w': ['1wk', 'max'],
};

async function chart(symbol: string, interval: string, range: string): Promise<ChartResp> {
  let last: unknown;
  for (const h of HOSTS) {
    try {
      return await getJson<ChartResp>(`${h}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export const yahoo = {
  source: SOURCE,
  async quote(symbol: string, assetId: string): Promise<Quote> {
    const t = Date.now();
    // range=1d: chartPreviousClose passa a ser o fechamento do pregão anterior (com 5d seria o de 5 dias atrás).
    return parseYahooQuote(await chart(symbol, '1d', '1d'), assetId, t);
  },
  /** Retorno de 12 meses (gráfico semanal de 1 ano, ~7 KB). */
  async return12m(symbol: string): Promise<Return12m | null> {
    return parseReturn12m(await chart(symbol, '1wk', '1y'));
  },
  async meta(symbol: string): Promise<YahooMeta | undefined> {
    return (await chart(symbol, '1d', '5d')).chart.result?.[0]?.meta;
  },
  async history(symbol: string, interval: Interval, adjusted = false): Promise<Candle[]> {
    const [iv, range] = IV[interval];
    const c = parseYahooCandles(await chart(symbol, iv, range), adjusted);
    return interval === '4h' ? aggregate(c, 4 * 3600_000) : c;
  },
};

/** Junta candles em janelas maiores (Yahoo não tem 4 h). */
export function aggregate(c: Candle[], ms: number): Candle[] {
  const out: Candle[] = [];
  for (const k of c) {
    const t = Math.floor(k.time / ms) * ms;
    const cur = out[out.length - 1];
    if (cur && cur.time === t) {
      cur.high = Math.max(cur.high, k.high);
      cur.low = Math.min(cur.low, k.low);
      cur.close = k.close;
      cur.volume += k.volume;
    } else out.push({ ...k, time: t });
  }
  return out;
}

/** Instrumentos da aba Mundo e da faixa do topo. É uma seleção, não dado: as cotações vêm da fonte. */
export interface WorldItem {
  ref: string;
  name: string;
  group: 'Índices' | 'Câmbio' | 'Commodities' | 'Juros';
  cls: AssetClass;
}
export const WORLD: WorldItem[] = [
  { ref: '^BVSP', name: 'Ibovespa', group: 'Índices', cls: 'world' },
  { ref: 'IFIX.SA', name: 'IFIX', group: 'Índices', cls: 'world' },
  { ref: '^GSPC', name: 'S&P 500', group: 'Índices', cls: 'world' },
  { ref: '^IXIC', name: 'Nasdaq', group: 'Índices', cls: 'world' },
  { ref: '^DJI', name: 'Dow Jones', group: 'Índices', cls: 'world' },
  { ref: '^RUT', name: 'Russell 2000', group: 'Índices', cls: 'world' },
  { ref: '^VIX', name: 'VIX (volatilidade EUA)', group: 'Índices', cls: 'world' },
  { ref: '^STOXX50E', name: 'Euro Stoxx 50', group: 'Índices', cls: 'world' },
  { ref: '^GDAXI', name: 'DAX (Alemanha)', group: 'Índices', cls: 'world' },
  { ref: '^FTSE', name: 'FTSE 100 (Reino Unido)', group: 'Índices', cls: 'world' },
  { ref: '^FCHI', name: 'CAC 40 (França)', group: 'Índices', cls: 'world' },
  { ref: '^N225', name: 'Nikkei 225 (Japão)', group: 'Índices', cls: 'world' },
  { ref: '^HSI', name: 'Hang Seng (Hong Kong)', group: 'Índices', cls: 'world' },
  { ref: '000001.SS', name: 'Xangai Composto', group: 'Índices', cls: 'world' },
  { ref: '^MERV', name: 'Merval (Argentina)', group: 'Índices', cls: 'world' },
  { ref: '^MXX', name: 'IPC (México)', group: 'Índices', cls: 'world' },
  { ref: 'BRL=X', name: 'Dólar (USD/BRL)', group: 'Câmbio', cls: 'world' },
  { ref: 'EURBRL=X', name: 'Euro (EUR/BRL)', group: 'Câmbio', cls: 'world' },
  { ref: 'GBPBRL=X', name: 'Libra (GBP/BRL)', group: 'Câmbio', cls: 'world' },
  { ref: 'EURUSD=X', name: 'Euro/Dólar', group: 'Câmbio', cls: 'world' },
  { ref: 'JPY=X', name: 'Dólar/Iene', group: 'Câmbio', cls: 'world' },
  { ref: 'CNY=X', name: 'Dólar/Yuan', group: 'Câmbio', cls: 'world' },
  { ref: 'ARS=X', name: 'Dólar/Peso argentino', group: 'Câmbio', cls: 'world' },
  { ref: 'DX-Y.NYB', name: 'Índice do dólar (DXY)', group: 'Câmbio', cls: 'world' },
  { ref: 'GC=F', name: 'Ouro', group: 'Commodities', cls: 'world' },
  { ref: 'SI=F', name: 'Prata', group: 'Commodities', cls: 'world' },
  { ref: 'BZ=F', name: 'Petróleo Brent', group: 'Commodities', cls: 'world' },
  { ref: 'CL=F', name: 'Petróleo WTI', group: 'Commodities', cls: 'world' },
  { ref: 'NG=F', name: 'Gás natural', group: 'Commodities', cls: 'world' },
  { ref: 'HG=F', name: 'Cobre', group: 'Commodities', cls: 'world' },
  { ref: 'ZS=F', name: 'Soja', group: 'Commodities', cls: 'world' },
  { ref: 'ZC=F', name: 'Milho', group: 'Commodities', cls: 'world' },
  { ref: 'KC=F', name: 'Café arábica', group: 'Commodities', cls: 'world' },
  { ref: 'SB=F', name: 'Açúcar', group: 'Commodities', cls: 'world' },
  { ref: 'LE=F', name: 'Boi gordo (EUA)', group: 'Commodities', cls: 'world' },
  { ref: '^TNX', name: 'Juro do Tesouro EUA 10 anos', group: 'Juros', cls: 'world' },
  { ref: '^IRX', name: 'Juro do Tesouro EUA 3 meses', group: 'Juros', cls: 'world' },
];
export const worldId = (ref: string) => `world:${ref}`;
