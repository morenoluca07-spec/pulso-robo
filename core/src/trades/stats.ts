import { pnl, type Trade } from './model';

export interface Stats {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  /** Soma dos ganhos ÷ soma das perdas. Infinity sem perdas. */
  profitFactor: number;
  maxLossStreak: number;
  total: number;
  /** Média de R (só operações com stop). */
  avgR?: number;
  /** Maior queda da curva de patrimônio, em valor. */
  maxDrawdown: number;
}

/**
 * Estatísticas das operações fechadas, na moeda comum (`toBase` converte o resultado de cada operação).
 * Ordem cronológica pela data de saída.
 */
export function tradeStats(trades: Trade[], toBase: (t: Trade, v: number) => number = (_, v) => v): Stats {
  const closed = trades.filter((t) => t.exitPrice !== undefined).sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0));
  const res = closed.map((t) => toBase(t, pnl(t)!.net));
  const rs = closed.map((t) => pnl(t)!.r).filter((r): r is number => r !== undefined);
  const w = res.filter((v) => v > 0);
  const l = res.filter((v) => v <= 0);
  let streak = 0;
  let maxStreak = 0;
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const v of res) {
    streak = v <= 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
    eq += v;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const sumW = w.reduce((a, b) => a + b, 0);
  const sumL = -l.reduce((a, b) => a + b, 0);
  return {
    n: res.length,
    wins: w.length,
    losses: l.length,
    winRate: res.length ? w.length / res.length : NaN,
    avgWin: w.length ? sumW / w.length : NaN,
    avgLoss: l.length ? -sumL / l.length : NaN,
    profitFactor: sumL > 0 ? sumW / sumL : sumW > 0 ? Infinity : NaN,
    maxLossStreak: maxStreak,
    total: sumW - sumL,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : undefined,
    maxDrawdown: dd,
  };
}

/** Curva de patrimônio: ponto a cada operação fechada. */
export function equityCurve(trades: Trade[], start: number, toBase: (t: Trade, v: number) => number = (_, v) => v): { time: number; value: number }[] {
  const closed = trades.filter((t) => t.exitPrice !== undefined).sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0));
  let eq = start;
  return closed.map((t) => ({ time: t.exitAt!, value: (eq += toBase(t, pnl(t)!.net)) }));
}

export function groupStats(trades: Trade[], key: (t: Trade) => string, toBase?: (t: Trade, v: number) => number): { key: string; stats: Stats }[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = key(t) || 'Sem estratégia';
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.entries()].map(([k, list]) => ({ key: k, stats: tradeStats(list, toBase) })).filter((g) => g.stats.n > 0);
}
