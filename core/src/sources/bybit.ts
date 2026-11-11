import { ClockOffset } from '../clock';
import { getJson } from '../http';
import { ReconnectingSocket } from '../realtime/socket';
import type { Asset, Candle, Interval, Quote, SourceAdapter, SourceHealth } from '../types';
import { cryptoId } from './binance';

/** Reserva para cripto quando a Binance cai. Mesmos ids (`crypto:BTCUSDT`). */
const REST = 'https://api.bybit.com';
const WS = 'wss://stream.bybit.com/v5/public/spot';
const SOURCE = 'Bybit';

interface BybitTicker {
  symbol: string;
  lastPrice: string;
  prevPrice24h: string;
  price24hPcnt: string;
  highPrice24h: string;
  lowPrice24h: string;
  turnover24h: string;
}
interface TickersResp {
  retCode: number;
  retMsg: string;
  time: number;
  result: { list: BybitTicker[] };
}

export function parseBybitTickers(j: TickersResp, receivedAt: number, toLocal: (t: number) => number = (x) => x): Quote[] {
  if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`);
  return j.result.list.map((t) => ({
    assetId: cryptoId(t.symbol),
    price: +t.lastPrice,
    changePct: +t.price24hPcnt * 100,
    open: +t.prevPrice24h,
    high: +t.highPrice24h,
    low: +t.lowPrice24h,
    quoteVolume: +t.turnover24h,
    sourceTime: toLocal(j.time),
    receivedAt,
    source: SOURCE,
    delivery: 'poll' as const,
  }));
}

const IV: Record<Interval, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' };

export class BybitAdapter implements SourceAdapter {
  readonly id = 'bybit';
  readonly label = SOURCE;
  readonly classes = ['crypto' as const];
  readonly clock = new ClockOffset();
  private socket?: ReconnectingSocket;
  private lastHealth: SourceHealth = { source: SOURCE, state: 'idle', messages: 0, reconnects: 0 };

  async listAssets(): Promise<Asset[]> {
    const j = await getJson<{ result: { list: { symbol: string; baseCoin: string; quoteCoin: string; status: string }[] } }>(`${REST}/v5/market/instruments-info?category=spot`);
    return j.result.list
      .filter((s) => s.status === 'Trading')
      .map((s) => ({ id: cryptoId(s.symbol), symbol: s.symbol, name: `${s.baseCoin}/${s.quoteCoin}`, cls: 'crypto' as const, base: s.baseCoin, quote: s.quoteCoin }));
  }

  async quotes(assetIds?: string[]): Promise<Quote[]> {
    const t0 = Date.now();
    const j = await getJson<TickersResp>(`${REST}/v5/market/tickers?category=spot`);
    const now = Date.now();
    this.clock.add(j.time, (t0 + now) / 2);
    const all = parseBybitTickers(j, now, (t) => this.clock.toLocal(t));
    if (!assetIds?.length) return all;
    const want = new Set(assetIds);
    return all.filter((q) => want.has(q.assetId));
  }

  async history(assetId: string, interval: Interval, limit = 500): Promise<Candle[]> {
    const sym = assetId.replace(/^crypto:/, '');
    const j = await getJson<{ result: { list: string[][] } }>(`${REST}/v5/market/kline?category=spot&symbol=${sym}&interval=${IV[interval]}&limit=${Math.min(limit, 1000)}`);
    return j.result.list.map((r) => ({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })).reverse();
  }

  /** Fluxo de tickers para os símbolos pedidos (Bybit não tem stream de mercado inteiro). */
  streamSymbols(symbols: string[], onQuotes: (q: Quote[]) => void, onHealth: (h: SourceHealth) => void): () => void {
    const args = symbols.map((s) => `tickers.${s}`);
    this.socket = new ReconnectingSocket({
      source: SOURCE,
      url: WS,
      ping: { everyMs: 20_000, payload: { op: 'ping' } },
      onOpenSend: () => {
        const out: unknown[] = [];
        for (let i = 0; i < args.length; i += 10) out.push({ op: 'subscribe', args: args.slice(i, i + 10) });
        return out;
      },
      onHealth: (h) => {
        this.lastHealth = h;
        onHealth(h);
      },
      onMessage: (data) => {
        const m = data as { topic?: string; ts?: number; data?: BybitTicker };
        if (!m.topic?.startsWith('tickers.') || !m.data || !m.ts) return;
        const now = Date.now();
        const [q] = parseBybitTickers({ retCode: 0, retMsg: 'OK', time: m.ts, result: { list: [m.data] } }, now, (t) => this.clock.toLocal(t));
        q.delivery = 'stream';
        this.socket?.recordLatency(now - q.sourceTime);
        onQuotes([q]);
      },
    });
    return () => this.socket?.close();
  }

  health(): SourceHealth {
    return this.lastHealth;
  }
}
