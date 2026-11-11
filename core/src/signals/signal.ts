import type { Candle } from '../types';
import { adx, atr, bollinger, ema, macd, rsi, sma } from './indicators';

/** Horizontes (candles diários). Curto ≈ 1 semana de pregão, médio ≈ 1 mês, longo ≈ 3 meses. */
export const HORIZONS = {
  curto: { label: 'Curto', days: 5, fast: 10, slow: 20 },
  medio: { label: 'Médio', days: 20, fast: 20, slow: 50 },
  longo: { label: 'Longo', days: 60, fast: 50, slow: 200 },
} as const;
export type Horizon = keyof typeof HORIZONS;

export type Reading = 'Compra forte' | 'Compra' | 'Neutro' | 'Venda' | 'Venda forte';

export interface Factor {
  key: 'tendência' | 'força da tendência' | 'momento' | 'MACD' | 'volatilidade' | 'volume' | 'funding' | 'notícias' | 'risco' | 'investidores';
  /** Contribuição de −1 (baixa) a +1 (alta), já multiplicada pelo peso. */
  value: number;
  /** Frase em linguagem simples. */
  text: string;
}

export interface Snapshot {
  reading: Reading;
  /** −1 (baixa) a +1 (alta). */
  score: number;
  /** 0 a 100: o quanto os fatores concordam entre si e com a direção. */
  strength: number;
  factors: Factor[];
}

const clamp = (v: number, a = -1, b = 1) => Math.max(a, Math.min(b, v));

export function readingOf(score: number): Reading {
  if (score >= 0.5) return 'Compra forte';
  if (score >= 0.15) return 'Compra';
  if (score <= -0.5) return 'Venda forte';
  if (score <= -0.15) return 'Venda';
  return 'Neutro';
}

export interface Series {
  close: number[];
  high: number[];
  low: number[];
  volume: number[];
  /** Indicadores pré-calculados por horizonte (para o backtest não recalcular a cada dia). */
  ind: Record<Horizon, ReturnType<typeof computeIndicators>>;
}

function computeIndicators(c: { close: number[]; high: number[]; low: number[]; volume: number[] }, h: Horizon) {
  const p = HORIZONS[h];
  const hlc = { high: c.high, low: c.low, close: c.close };
  return {
    fast: ema(c.close, p.fast),
    slow: sma(c.close, p.slow),
    rsi: rsi(c.close, 14),
    macd: macd(c.close).hist,
    atr: atr(hlc, 14),
    bb: bollinger(c.close, 20, 2).pctB,
    adx: adx(hlc, 14),
    volAvg: sma(c.volume, 20),
  };
}

export function prepare(candles: Candle[]): Series {
  const base = { close: candles.map((k) => k.close), high: candles.map((k) => k.high), low: candles.map((k) => k.low), volume: candles.map((k) => k.volume) };
  return { ...base, ind: { curto: computeIndicators(base, 'curto'), medio: computeIndicators(base, 'medio'), longo: computeIndicators(base, 'longo') } };
}

const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1).replace('.', ',')}%`;

/**
 * Leitura no índice `i` usando só dados até `i` (sem olhar o futuro).
 * Pesos fixos, definidos antes do backtest: tendência 0,35; momento 0,25; MACD 0,15; volatilidade 0,10; volume 0,15.
 */
export function snapshotAt(s: Series, i: number, h: Horizon, extra: Factor[] = []): Snapshot | null {
  const d = s.ind[h];
  const c = s.close[i];
  if (![d.fast[i], d.slow[i], d.rsi[i], d.macd[i], d.atr[i], d.bb[i], d.adx.adx[i]].every(Number.isFinite)) return null;
  const f: Factor[] = [];

  // Tendência: média rápida contra a lenta e preço contra a lenta, normalizados pela volatilidade (ATR).
  const atrPct = d.atr[i] / c;
  const gap = (d.fast[i] - d.slow[i]) / d.slow[i];
  const trend = clamp(gap / (2 * atrPct || 1e-9));
  const adxStrength = clamp((d.adx.adx[i] - 15) / 25, 0, 1); // ADX < 15 = sem tendência; > 40 = tendência forte
  f.push({ key: 'tendência', value: 0.35 * trend * (0.4 + 0.6 * adxStrength), text: `${trend > 0 ? 'Média rápida acima' : 'Média rápida abaixo'} da lenta (${pct(gap)})${adxStrength > 0.5 ? ', com tendência forte (ADX ' + Math.round(d.adx.adx[i]) + ')' : adxStrength < 0.15 ? ', mas sem tendência definida (ADX ' + Math.round(d.adx.adx[i]) + ')' : ''}` });

  // Momento: RSI. Acima de 70 ou abaixo de 30 = esticado (pesa contra a continuação).
  const r = d.rsi[i];
  const mom = r > 70 ? -clamp((r - 70) / 20, 0, 1) * 0.5 + 0.3 : r < 30 ? clamp((30 - r) / 20, 0, 1) * 0.5 - 0.3 : (r - 50) / 20;
  f.push({ key: 'momento', value: 0.25 * clamp(mom), text: r > 70 ? `RSI ${Math.round(r)}: subiu rápido, pode estar esticado` : r < 30 ? `RSI ${Math.round(r)}: caiu rápido, pode estar esticado para baixo` : `RSI ${Math.round(r)}: ${r >= 50 ? 'compradores na frente' : 'vendedores na frente'}` });

  // MACD: histograma normalizado pelo ATR.
  const mh = clamp(d.macd[i] / (0.5 * d.atr[i] || 1e-9));
  f.push({ key: 'MACD', value: 0.15 * mh, text: `MACD ${mh > 0 ? 'acima' : 'abaixo'} da linha de sinal` });

  // Volatilidade: posição nas bandas de Bollinger (perto da banda de cima = esticado).
  const b = d.bb[i];
  const vol = b > 1 ? -0.6 : b < 0 ? 0.6 : (0.5 - b) * 0.6;
  f.push({ key: 'volatilidade', value: 0.1 * vol, text: b > 1 ? 'Preço acima da banda de Bollinger superior' : b < 0 ? 'Preço abaixo da banda de Bollinger inferior' : `Preço ${b > 0.5 ? 'na metade de cima' : 'na metade de baixo'} das bandas de Bollinger` });

  // Volume: volume acima da média confirma a direção do dia.
  if (Number.isFinite(d.volAvg[i]) && d.volAvg[i] > 0 && s.volume[i] > 0) {
    const ratio = s.volume[i] / d.volAvg[i];
    const dir = Math.sign(c - s.close[i - 1]);
    const v = clamp((ratio - 1) * dir);
    f.push({ key: 'volume', value: 0.15 * v, text: `Volume ${ratio >= 1 ? `${ratio.toFixed(1).replace('.', ',')}× a média` : 'abaixo da média'} em dia de ${dir >= 0 ? 'alta' : 'baixa'}` });
  }

  f.push(...extra);
  const score = clamp(f.reduce((a, x) => a + x.value, 0) / 0.8);
  const dir = Math.sign(score) || 1;
  const agree = f.filter((x) => Math.sign(x.value) === dir).reduce((a, x) => a + Math.abs(x.value), 0);
  const total = f.reduce((a, x) => a + Math.abs(x.value), 0) || 1;
  const strength = Math.round(100 * Math.abs(score) * 0.6 + 40 * (agree / total) * Math.min(1, Math.abs(score) * 4));
  return { reading: readingOf(score), score, strength: Math.max(0, Math.min(100, strength)), factors: f };
}

/** Os três fatores que mais pesaram (em valor absoluto). */
export function topFactors(s: Snapshot, n = 3): Factor[] {
  return [...s.factors].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, n);
}
