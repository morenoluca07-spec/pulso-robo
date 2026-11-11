/**
 * Hyperliquid: ranking público de traders (arquivo grande, não oficial: só no PC) e posições abertas por
 * carteira (endpoint público `info`, tipo `clearinghouseState`), o mais perto de tempo real em copy trading.
 */
import { getJson } from '../http';

export const HL_LEADERBOARD = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const INFO = 'https://api.hyperliquid.xyz/info';

export type Window = 'day' | 'week' | 'month' | 'allTime';
export interface HlTrader {
  address: string;
  name?: string;
  accountValue: number;
  perf: Record<Window, { pnl: number; roi: number; volume: number }>;
}

interface LbRow {
  ethAddress: string;
  accountValue: string;
  displayName: string | null;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
}

export function parseLeaderboard(j: { leaderboardRows: LbRow[] }): HlTrader[] {
  return j.leaderboardRows.map((r) => {
    const perf = {} as HlTrader['perf'];
    for (const [w, p] of r.windowPerformances) perf[w as Window] = { pnl: +p.pnl, roi: +p.roi, volume: +p.vlm };
    return { address: r.ethAddress, name: r.displayName ?? undefined, accountValue: +r.accountValue, perf };
  });
}

/** Ranking filtrado: conta mínima e volume (evita contas minúsculas com ROI enganoso). */
export function rankTraders(ts: HlTrader[], w: Window, by: 'pnl' | 'roi', minAccount = 100_000, top = 100): HlTrader[] {
  return ts
    .filter((t) => t.accountValue >= minAccount && t.perf[w] && t.perf[w].volume > 0)
    .sort((a, b) => b.perf[w][by] - a.perf[w][by])
    .slice(0, top);
}

export interface HlPosition {
  coin: string;
  /** Tamanho com sinal (positivo = comprado, negativo = vendido). */
  size: number;
  entry: number;
  value: number;
  pnl: number;
  leverage: number;
  liquidation?: number;
}

export interface HlState {
  accountValue: number;
  positions: HlPosition[];
  time: number;
}

export function parseState(j: {
  marginSummary: { accountValue: string };
  assetPositions: { position: { coin: string; szi: string; entryPx: string; positionValue: string; unrealizedPnl: string; leverage: { value: number }; liquidationPx: string | null } }[];
  time?: number;
}): HlState {
  return {
    accountValue: +j.marginSummary.accountValue,
    time: j.time ?? Date.now(),
    positions: j.assetPositions
      .map(({ position: p }) => ({ coin: p.coin, size: +p.szi, entry: +p.entryPx, value: +p.positionValue, pnl: +p.unrealizedPnl, leverage: p.leverage?.value ?? 1, liquidation: p.liquidationPx ? +p.liquidationPx : undefined }))
      .sort((a, b) => b.value - a.value),
  };
}

export async function fetchHlState(address: string): Promise<HlState> {
  return parseState(await getJson(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'clearinghouseState', user: address }) }));
}

/** Mudanças entre duas leituras de posições (para alerta de movimento novo). */
export function hlChanges(before: HlState, now: HlState): string[] {
  const b = new Map(before.positions.map((p) => [p.coin, p]));
  const n = new Map(now.positions.map((p) => [p.coin, p]));
  const out: string[] = [];
  for (const [c, p] of n) {
    const q = b.get(c);
    if (!q) out.push(`abriu ${p.size > 0 ? 'compra' : 'venda'} em ${c}`);
    else if (Math.sign(q.size) !== Math.sign(p.size)) out.push(`virou a mão em ${c}`);
    else if (Math.abs(p.size) > Math.abs(q.size) * 1.1) out.push(`aumentou ${c}`);
    else if (Math.abs(p.size) < Math.abs(q.size) * 0.9) out.push(`reduziu ${c}`);
  }
  for (const c of b.keys()) if (!n.has(c)) out.push(`fechou ${c}`);
  return out;
}
