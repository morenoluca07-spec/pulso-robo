import type { Candle } from '../types';
import { HORIZONS, prepare, snapshotAt, type Horizon, type Reading, type Series } from './signal';

/** Abaixo disso o app mostra "dados insuficientes" em vez de um percentual. */
export const MIN_SAMPLE = 20;
/** Fração mais antiga do histórico usada como período de ajuste; o resto é teste. */
export const FIT_FRACTION = 0.7;

export interface PeriodStats {
  /** Quantas vezes o ativo entrou nesta leitura. */
  n: number;
  /** Fração das vezes em que o preço estava mais alto ao fim do horizonte, já descontado o custo. */
  pctUp: number;
  meanReturn: number;
  worst: number;
  best: number;
  /** Fração de todos os dias do período em que o preço subiu no mesmo horizonte (comparação). */
  baseUp: number;
  from: number;
  to: number;
}

export interface BacktestResult {
  horizon: Horizon;
  reading: Reading;
  days: number;
  cost: number;
  fit: PeriodStats | null;
  test: PeriodStats | null;
  /** true quando o período de teste tem amostra suficiente. */
  enough: boolean;
}

function stats(s: Series, times: number[], idx: number[], all: number[], h: number, cost: number): PeriodStats | null {
  if (!all.length) return null;
  const ret = (i: number) => s.close[i + h] / s.close[i] - 1 - cost;
  const r = idx.map(ret);
  const base = all.map(ret);
  return {
    n: r.length,
    pctUp: r.length ? r.filter((x) => x > 0).length / r.length : NaN,
    meanReturn: r.length ? r.reduce((a, b) => a + b, 0) / r.length : NaN,
    worst: r.length ? Math.min(...r) : NaN,
    best: r.length ? Math.max(...r) : NaN,
    baseUp: base.filter((x) => x > 0).length / base.length,
    from: times[all[0]],
    to: times[all[all.length - 1] + h],
  };
}

/**
 * Probabilidade histórica da leitura atual.
 * Conta as vezes em que o ativo ENTROU nesta leitura (não cada dia nela, para não contar o mesmo episódio
 * várias vezes) e mede o retorno `h` dias depois, descontando o custo de ida e volta.
 * Os pesos dos fatores são fixos (definidos antes); o período de ajuste serve de controle e o número
 * mostrado ao usuário é o do período de teste, que o modelo nunca "viu".
 */
export function backtest(candles: Candle[], horizon: Horizon, reading: Reading, cost: number, series?: Series): BacktestResult {
  const s = series ?? prepare(candles);
  const h = HORIZONS[horizon].days;
  const times = candles.map((c) => c.time);
  const last = candles.length - 1 - h;
  const readings: (Reading | null)[] = [];
  for (let i = 0; i <= last; i++) readings.push(snapshotAt(s, i, horizon)?.reading ?? null);
  const valid = readings.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
  if (!valid.length) return { horizon, reading, days: h, cost, fit: null, test: null, enough: false };
  const cut = valid[Math.floor(valid.length * FIT_FRACTION)];
  const entries = valid.filter((i) => readings[i] === reading && readings[i - 1] !== reading);
  const fitAll = valid.filter((i) => i < cut);
  const testAll = valid.filter((i) => i >= cut);
  const fit = stats(s, times, entries.filter((i) => i < cut), fitAll, h, cost);
  const test = stats(s, times, entries.filter((i) => i >= cut), testAll, h, cost);
  return { horizon, reading, days: h, cost, fit, test, enough: !!test && test.n >= MIN_SAMPLE };
}

/** Custo de ida e volta estimado por classe (corretagem/taxas + diferença de compra e venda). */
export const ROUND_TRIP_COST: Record<string, number> = {
  crypto: 0.002, // Binance: 0,1% por lado (taxa padrão sem desconto)
  br: 0.001, // B3: emolumentos e liquidação ~0,03% por lado + diferença de compra e venda
  fii: 0.001,
  us: 0.0005,
  meme: 0.02, // DEX: ~0,3% de taxa do pool por lado + derrapagem em pools rasos
  world: 0, // índices e câmbio não são negociados diretamente: sem custo, só referência
};
