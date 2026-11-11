/** Métricas de risco e retorno a partir de séries diárias de preço. */

export interface DatedValue {
  date: string; // aaaa-mm-dd
  value: number;
}

/** Junta séries pela data comum e devolve retornos diários alinhados. */
export function alignReturns(series: Record<string, DatedValue[]>): { dates: string[]; returns: Record<string, number[]> } {
  const keys = Object.keys(series);
  if (!keys.length) return { dates: [], returns: {} };
  const maps = keys.map((k) => new Map(series[k].map((p) => [p.date, p.value])));
  const common = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  const returns: Record<string, number[]> = {};
  keys.forEach((k, i) => {
    const r: number[] = [];
    for (let j = 1; j < common.length; j++) r.push(maps[i].get(common[j])! / maps[i].get(common[j - 1])! - 1);
    returns[k] = r;
  });
  return { dates: common.slice(1), returns };
}

export function stdev(x: number[]): number {
  if (x.length < 2) return NaN;
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
}

export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 10) return NaN;
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : NaN;
}

/** Curva da carteira com pesos fixos (rebalanceada diariamente) a partir de retornos alinhados. */
export function weightedCurve(returns: Record<string, number[]>, weights: Record<string, number>): number[] {
  const keys = Object.keys(weights).filter((k) => returns[k]);
  const n = keys.length ? returns[keys[0]].length : 0;
  const wsum = keys.reduce((a, k) => a + weights[k], 0) || 1;
  const curve = [1];
  for (let i = 0; i < n; i++) curve.push(curve[i] * (1 + keys.reduce((a, k) => a + (weights[k] / wsum) * returns[k][i], 0)));
  return curve;
}

export function maxDrawdown(curve: number[]): number {
  let peak = curve[0] ?? 1;
  let dd = 0;
  for (const v of curve) {
    peak = Math.max(peak, v);
    dd = Math.max(dd, 1 - v / peak);
  }
  return dd;
}

/** Volatilidade anualizada a partir de retornos diários (√252; cripto negocia todo dia, mas alinhamos aos dias de bolsa). */
export const annualVol = (daily: number[]) => stdev(daily) * Math.sqrt(252);

/** CDI acumulado a partir da série diária do BC (SGS 12, % ao dia). */
export function accumulate(dailyPct: DatedValue[], from: string, to: string): number {
  return dailyPct.filter((p) => p.date >= from && p.date <= to).reduce((a, p) => a * (1 + p.value / 100), 1) - 1;
}
