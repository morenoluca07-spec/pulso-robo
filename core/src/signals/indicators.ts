/**
 * Indicadores técnicos clássicos. Cada função devolve um array do mesmo tamanho da entrada,
 * com NaN onde ainda não há dados suficientes (nunca inventa valor inicial).
 */

export function sma(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
    if (i >= n) sum -= x[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Média móvel exponencial, semeada pela média simples dos `n` primeiros valores. */
export function ema(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  const k = 2 / (n + 1);
  let start = x.findIndex((v) => Number.isFinite(v));
  if (start < 0 || x.length - start < n) return out;
  let prev = 0;
  for (let i = start; i < start + n; i++) prev += x[i];
  prev /= n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < x.length; i++) {
    prev = x[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Suavização de Wilder (usada por RSI, ATR e ADX). */
function wilder(x: number[], n: number, from: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  if (x.length - from < n) return out;
  let s = 0;
  for (let i = from; i < from + n; i++) s += x[i];
  let prev = s / n;
  out[from + n - 1] = prev;
  for (let i = from + n; i < x.length; i++) {
    prev = (prev * (n - 1) + x[i]) / n;
    out[i] = prev;
  }
  return out;
}

/** RSI de Wilder (0 a 100). */
export function rsi(close: number[], n = 14): number[] {
  const gain = new Array<number>(close.length).fill(0);
  const loss = new Array<number>(close.length).fill(0);
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    gain[i] = Math.max(d, 0);
    loss[i] = Math.max(-d, 0);
  }
  const ag = wilder(gain, n, 1);
  const al = wilder(loss, n, 1);
  return ag.map((g, i) => (Number.isFinite(g) ? (al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i])) : NaN));
}

export function macd(close: number[], fast = 12, slow = 26, signal = 9): { macd: number[]; signal: number[]; hist: number[] } {
  const f = ema(close, fast);
  const s = ema(close, slow);
  const m = f.map((v, i) => v - s[i]);
  const sig = ema(m, signal);
  return { macd: m, signal: sig, hist: m.map((v, i) => v - sig[i]) };
}

export interface HLC {
  high: number[];
  low: number[];
  close: number[];
}

export function trueRange({ high, low, close }: HLC): number[] {
  return high.map((h, i) => (i === 0 ? h - low[i] : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]))));
}

export function atr(c: HLC, n = 14): number[] {
  return wilder(trueRange(c), n, 1);
}

export function bollinger(close: number[], n = 20, k = 2): { mid: number[]; upper: number[]; lower: number[]; pctB: number[] } {
  const mid = sma(close, n);
  const sd = close.map((_, i) => {
    if (!Number.isFinite(mid[i])) return NaN;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (close[j] - mid[i]) ** 2;
    return Math.sqrt(s / n);
  });
  const upper = mid.map((m, i) => m + k * sd[i]);
  const lower = mid.map((m, i) => m - k * sd[i]);
  return { mid, upper, lower, pctB: close.map((c, i) => (upper[i] - lower[i] > 0 ? (c - lower[i]) / (upper[i] - lower[i]) : NaN)) };
}

/** ADX de Wilder com +DI e −DI. */
export function adx(c: HLC, n = 14): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const len = c.close.length;
  const pdm = new Array<number>(len).fill(0);
  const mdm = new Array<number>(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = c.high[i] - c.high[i - 1];
    const down = c.low[i - 1] - c.low[i];
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
  }
  const tr = wilder(trueRange(c), n, 1);
  const sp = wilder(pdm, n, 1);
  const sm = wilder(mdm, n, 1);
  const plusDI = sp.map((v, i) => (tr[i] > 0 ? (100 * v) / tr[i] : NaN));
  const minusDI = sm.map((v, i) => (tr[i] > 0 ? (100 * v) / tr[i] : NaN));
  const dx = plusDI.map((p, i) => (p + minusDI[i] > 0 ? (100 * Math.abs(p - minusDI[i])) / (p + minusDI[i]) : NaN));
  const first = dx.findIndex((v) => Number.isFinite(v));
  const a = first < 0 ? dx.map(() => NaN) : wilder(dx.map((v) => (Number.isFinite(v) ? v : 0)), n, first);
  return { adx: a, plusDI, minusDI };
}
