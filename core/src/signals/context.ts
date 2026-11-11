import { getJson } from '../http';
import type { RiskFlag } from '../sources/geckoterminal';
import type { NewsItem } from '../news/newsFeed';
import type { Factor, Snapshot } from './signal';
import { readingOf } from './signal';

/** Funding e contratos em aberto (Binance Futures, público, sem chave). Só para cripto com contrato perpétuo. */
export interface Derivatives {
  funding: number; // taxa por 8 h (ex.: 0.0001 = 0,01%)
  oiChange: number; // variação dos contratos em aberto em 3 dias
}

export async function fetchDerivatives(symbol: string): Promise<Derivatives | null> {
  try {
    const [p, h] = await Promise.all([
      getJson<{ lastFundingRate: string }>(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
      getJson<{ sumOpenInterest: string }[]>(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1d&limit=4`),
    ]);
    const first = +h[0]?.sumOpenInterest;
    const last = +h[h.length - 1]?.sumOpenInterest;
    return { funding: +p.lastFundingRate, oiChange: first > 0 ? last / first - 1 : 0 };
  } catch {
    return null; // sem contrato perpétuo na Binance: o fator simplesmente não entra
  }
}

const fmtPct = (v: number, d = 3) => `${(v * 100).toFixed(d).replace('.', ',')}%`;

/** Funding muito positivo = muita gente alavancada comprada (aglomeração): pesa levemente contra. */
export function derivativesFactor(d: Derivatives): Factor {
  const crowd = Math.max(-1, Math.min(1, d.funding / 0.0003));
  const v = -0.1 * crowd * (d.oiChange > 0.05 ? 1.3 : 1);
  return {
    key: 'funding',
    value: v,
    text: `Funding ${fmtPct(d.funding)} a cada 8 h (${d.funding > 0.0001 ? 'muitos comprados alavancados' : d.funding < 0 ? 'vendidos pagando para manter a posição' : 'equilibrado'}), contratos em aberto ${d.oiChange >= 0 ? '+' : '−'}${fmtPct(Math.abs(d.oiChange), 1)} em 3 dias`,
  };
}

/** Notícias de risco ou jurídicas recentes citando o ativo pesam contra. */
export function newsFactor(items: NewsItem[], assetId: string, now = Date.now()): Factor | null {
  const recent = items.filter((n) => n.assets.includes(assetId) && now - n.time < 3 * 86_400_000);
  if (!recent.length) return null;
  const bad = recent.filter((n) => n.tags.includes('risco') || n.tags.includes('jurídico')).length;
  if (!bad) return { key: 'notícias', value: 0, text: `${recent.length} notícia(s) recente(s), nenhuma de risco` };
  return { key: 'notícias', value: -0.08 * Math.min(3, bad), text: `${bad} notícia(s) de risco ou jurídica(s) nos últimos 3 dias` };
}

/** Memecoins: alerta de risco alto anula qualquer leitura de compra (seção 8.4). */
export function applyRisk(s: Snapshot, flags: RiskFlag[]): Snapshot {
  const high = flags.filter((f) => f.level === 'alto');
  if (!high.length || s.score <= 0) return s;
  const score = Math.min(s.score, 0.1);
  return {
    ...s,
    score,
    reading: readingOf(score),
    strength: Math.min(s.strength, 20),
    factors: [{ key: 'risco', value: -(s.score - score), text: `Risco alto: ${high.map((f) => f.text.toLowerCase()).join('; ')}. A leitura de compra foi anulada.` }, ...s.factors],
  };
}
