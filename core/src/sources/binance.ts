import { ClockOffset } from '../clock';
import { getJson } from '../http';
import { ReconnectingSocket } from '../realtime/socket';
import type { Asset, Candle, Interval, Quote, SourceAdapter, SourceHealth } from '../types';

const REST = 'https://api.binance.com';
const WS = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const SOURCE = 'Binance';

interface ExchangeInfo {
  symbols: { symbol: string; status: string; baseAsset: string; quoteAsset: string }[];
}
interface Ticker24 {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
  closeTime: number;
}
export interface MiniTicker {
  e: '24hrMiniTicker';
  E: number;
  s: string;
  c: string;
  o: string;
  h: string;
  l: string;
  v: string;
  q: string;
}

export const cryptoId = (symbol: string) => `crypto:${symbol}`;

export function parseExchangeInfo(j: ExchangeInfo): Asset[] {
  return j.symbols
    .filter((s) => s.status === 'TRADING')
    .map((s) => ({ id: cryptoId(s.symbol), symbol: s.symbol, name: `${s.baseAsset}/${s.quoteAsset}`, cls: 'crypto' as const, base: s.baseAsset, quote: s.quoteAsset }));
}

export function parseTicker24(t: Ticker24, receivedAt: number, toLocal: (t: number) => number = (x) => x): Quote {
  const open = +t.openPrice;
  return {
    assetId: cryptoId(t.symbol),
    price: +t.lastPrice,
    changePct: +t.priceChangePercent,
    open,
    high: +t.highPrice,
    low: +t.lowPrice,
    quoteVolume: +t.quoteVolume,
    sourceTime: toLocal(t.closeTime),
    receivedAt,
    source: SOURCE,
    delivery: 'poll',
  };
}

export function parseMiniTicker(m: MiniTicker, receivedAt: number, toLocal: (t: number) => number = (x) => x): Quote {
  const open = +m.o;
  const price = +m.c;
  return {
    assetId: cryptoId(m.s),
    price,
    changePct: open > 0 ? ((price - open) / open) * 100 : undefined,
    open,
    high: +m.h,
    low: +m.l,
    quoteVolume: +m.q,
    sourceTime: toLocal(m.E),
    receivedAt,
    source: SOURCE,
    delivery: 'stream',
  };
}

const INTERVALS: Record<Interval, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' };

export function parseKlines(rows: (string | number)[][]): Candle[] {
  return rows.map((r) => ({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));
}

export class BinanceAdapter implements SourceAdapter {
  readonly id = 'binance';
  readonly label = SOURCE;
  readonly classes = ['crypto' as const];
  readonly clock = new ClockOffset();
  private socket?: ReconnectingSocket;
  private lastHealth: SourceHealth = { source: SOURCE, state: 'idle', messages: 0, reconnects: 0 };

  async syncClock(): Promise<void> {
    const t0 = Date.now();
    const j = await getJson<{ serverTime: number }>(`${REST}/api/v3/time`);
    this.clock.add(j.serverTime, (t0 + Date.now()) / 2);
  }

  async listAssets(): Promise<Asset[]> {
    return parseExchangeInfo(await getJson<ExchangeInfo>(`${REST}/api/v3/exchangeInfo?permissions=SPOT`, undefined, 30_000));
  }

  async quotes(assetIds?: string[]): Promise<Quote[]> {
    const syms = assetIds?.map((id) => id.replace(/^crypto:/, ''));
    const q = syms?.length ? `?symbols=${encodeURIComponent(JSON.stringify(syms))}` : '';
    const rows = await getJson<Ticker24[]>(`${REST}/api/v3/ticker/24hr${q}`, undefined, 30_000);
    const now = Date.now();
    return rows.map((r) => parseTicker24(r, now, (t) => this.clock.toLocal(t)));
  }

  async history(assetId: string, interval: Interval, limit = 500): Promise<Candle[]> {
    const sym = assetId.replace(/^crypto:/, '');
    return parseKlines(await getJson<(string | number)[][]>(`${REST}/api/v3/klines?symbol=${sym}&interval=${INTERVALS[interval]}&limit=${limit}`));
  }

  /** Histórico longo (vários pedidos de 1.000 candles, do mais novo para o mais antigo). */
  async historyLong(assetId: string, interval: Interval, maxCandles = 3000): Promise<Candle[]> {
    const sym = assetId.replace(/^crypto:/, '');
    let end: number | undefined;
    let all: Candle[] = [];
    while (all.length < maxCandles) {
      const page = parseKlines(await getJson<(string | number)[][]>(`${REST}/api/v3/klines?symbol=${sym}&interval=${INTERVALS[interval]}&limit=1000${end ? `&endTime=${end}` : ''}`));
      if (!page.length) break;
      all = [...page, ...all];
      if (page.length < 1000) break;
      end = page[0].time - 1;
    }
    return all;
  }

  stream(onQuotes: (q: Quote[]) => void, onHealth: (h: SourceHealth) => void): () => void {
    this.socket = new ReconnectingSocket({
      source: SOURCE,
      url: WS,
      silenceMs: 10_000,
      onHealth: (h) => {
        this.lastHealth = h;
        onHealth(h);
      },
      onMessage: (data) => {
        if (!Array.isArray(data)) return;
        const now = Date.now();
        const out = (data as MiniTicker[]).map((m) => parseMiniTicker(m, now, (t) => this.clock.toLocal(t)));
        if (out.length) this.socket?.recordLatency(now - out[0].sourceTime);
        onQuotes(out);
      },
    });
    return () => this.socket?.close();
  }

  health(): SourceHealth {
    return this.lastHealth;
  }
}
