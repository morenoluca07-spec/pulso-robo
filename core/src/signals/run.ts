import type { Asset, Candle } from '../types';
import { backtest, ROUND_TRIP_COST, type BacktestResult } from './backtest';
import { applyRisk } from './context';
import type { RiskFlag } from '../sources/geckoterminal';
import { HORIZONS, prepare, snapshotAt, type Factor, type Horizon, type Snapshot, type SnapshotOptions } from './signal';

export interface HorizonSignal {
  horizon: Horizon;
  snapshot: Snapshot;
  backtest: BacktestResult;
}

export interface AssetSignal {
  assetId: string;
  at: number;
  /** Último candle usado (o sinal é de fechamento diário). */
  lastCandle: number;
  price: number;
  horizons: HorizonSignal[];
  /** Fatores de contexto usados só na leitura atual (não existem no histórico do backtest). */
  context: Factor[];
  candles: number;
  source: string;
}

/** Leitura nos três horizontes + probabilidade histórica de cada uma. */
/**
 * `opts.partialLast`: o último candle é o pregão de hoje ainda aberto (volume incompleto).
 * Vale só para a leitura atual; o backtest usa o histórico sem essa opção.
 */
export function computeSignal(asset: Asset, candles: Candle[], source: string, context: Factor[] = [], risk: RiskFlag[] = [], opts: SnapshotOptions = {}): AssetSignal | null {
  if (candles.length < 60) return null;
  const s = prepare(candles);
  const i = candles.length - 1;
  const cost = ROUND_TRIP_COST[asset.cls] ?? 0.001;
  const horizons: HorizonSignal[] = [];
  for (const h of Object.keys(HORIZONS) as Horizon[]) {
    let snap = snapshotAt(s, i, h, context, { partialLast: opts.partialLast });
    if (!snap) continue;
    if (risk.length) snap = applyRisk(snap, risk);
    horizons.push({ horizon: h, snapshot: snap, backtest: backtest(candles, h, snap.reading, cost, s) });
  }
  if (!horizons.length) return null;
  return { assetId: asset.id, at: Date.now(), lastCandle: candles[i].time, price: candles[i].close, horizons, context, candles: candles.length, source };
}
