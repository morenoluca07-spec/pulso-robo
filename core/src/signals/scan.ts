import type { FiiFundamentals } from '../br/fiiCvm';
import type { Asset } from '../types';
import { CRITERIA, type CriterionId, type RankClass } from './rank';
import type { AssetSignal } from './run';
import type { Factor, Horizon, Reading } from './signal';

/**
 * Formato compacto de um ativo varrido (sem candles): o mesmo no app (PC e celular) e no robô da nuvem.
 */
export interface ScanHorizon {
  h: Horizon;
  reading: Reading;
  score: number;
  strength: number;
  top: string[];
  bt: { n: number; pctUp: number; baseUp: number; mean: number; enough: boolean } | null;
}
export interface ScanItem {
  assetId: string;
  cls: RankClass;
  at: number;
  lastCandle: number;
  price: number;
  candles: number;
  horizons: ScanHorizon[];
  context: Factor[];
  crit: Partial<Record<CriterionId, number>>;
}

/** Moedas estáveis e embrulhadas: fora do ranking de cripto. */
export const STABLE_BASES = /^(USDC|FDUSD|TUSD|USD1|RLUSD|DAI|EUR|USDP|BFUSD|XUSD|USDE|PAXG|WBTC|WBETH|BNSOL|EURI|AEUR)$/;

export function buildScanItem(a: Asset, cls: RankClass, sig: AssetSignal, closes: number[]): ScanItem {
  const techLongo = sig.horizons.find((h) => h.horizon === 'longo')?.snapshot.score;
  const crit: ScanItem['crit'] = {};
  for (const k of Object.keys(CRITERIA) as CriterionId[]) {
    const v = CRITERIA[k].value(closes, techLongo);
    if (v !== undefined && Number.isFinite(v)) crit[k] = v;
  }
  return {
    assetId: a.id,
    cls,
    at: sig.at,
    lastCandle: sig.lastCandle,
    price: sig.price,
    candles: closes.length,
    context: sig.context,
    crit,
    horizons: sig.horizons.map((h) => ({
      h: h.horizon,
      reading: h.snapshot.reading,
      score: h.snapshot.score,
      strength: h.snapshot.strength,
      top: [...h.snapshot.factors]
        .sort((x, y) => Math.abs(y.value) - Math.abs(x.value))
        .slice(0, 2)
        .map((f) => f.text),
      bt: h.backtest.test ? { n: h.backtest.test.n, pctUp: h.backtest.test.pctUp, baseUp: h.backtest.test.baseUp, mean: h.backtest.test.meanReturn, enough: h.backtest.enough } : null,
    })),
  };
}

/** Arquivo publicado pelo robô da nuvem (GitHub Pages) e lido pelo app. */
export interface CloudBest {
  v: 1;
  generatedAt: number;
  classes: Partial<Record<RankClass, { at: number; total: number; items: ScanItem[]; errors: string[]; assets: Asset[] }>>;
  /** Fundamentos de 12 meses (CVM) dos FIIs varridos, para o ranking por renda. */
  fii: [string, FiiFundamentals][];
  fiiUpdated?: string;
}

/** Confere o formato antes de usar (arquivo vindo da internet). */
export function parseCloudBest(j: unknown): CloudBest | null {
  const o = j as CloudBest;
  if (!o || o.v !== 1 || typeof o.generatedAt !== 'number' || typeof o.classes !== 'object' || !Array.isArray(o.fii)) return null;
  for (const c of Object.values(o.classes)) if (!c || !Array.isArray(c.items) || typeof c.at !== 'number') return null;
  return o;
}
