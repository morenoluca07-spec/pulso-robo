import { BinanceAdapter } from '../sources/binance';
import { BybitAdapter } from '../sources/bybit';
import { geckoterminal } from '../sources/geckoterminal';
import { yahoo } from '../sources/yahoo';
import type { Asset, Candle, Interval } from '../types';

export interface HistoryResult {
  candles: Candle[];
  source: string;
}

/** Escolhe a fonte de candles pela classe do ativo, com reserva quando houver. */
export async function loadHistory(a: Asset, interval: Interval, crypto: { binance: BinanceAdapter; bybit: BybitAdapter }, forSignals = false): Promise<HistoryResult> {
  if (a.cls === 'crypto') {
    if (forSignals) return { candles: await crypto.binance.historyLong(a.id, interval), source: 'Binance' };
    try {
      return { candles: await crypto.binance.history(a.id, interval, 500), source: 'Binance' };
    } catch {
      return { candles: await crypto.bybit.history(a.id, interval, 500), source: 'Bybit' };
    }
  }
  if (a.cls === 'meme') {
    const net = String(a.meta?.network ?? '');
    const pool = String(a.meta?.pool ?? '');
    return { candles: await geckoterminal.history(net, pool, interval), source: 'GeckoTerminal' };
  }
  return { candles: await yahoo.history(a.ref ?? a.symbol, interval, forSignals), source: forSignals ? 'Yahoo (preço ajustado por proventos)' : 'Yahoo' };
}
