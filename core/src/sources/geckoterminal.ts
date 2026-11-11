import { getJson } from '../http';
import type { Asset, Candle, Interval, Quote } from '../types';

/**
 * Memecoins e tokens fora de corretora: pools em alta da GeckoTerminal (30 req/min, sem chave).
 * Os alertas de risco pesam mais que qualquer indicador técnico (seção 8.4).
 */
const API = 'https://api.geckoterminal.com/api/v2';
const SOURCE = 'GeckoTerminal';
export const MEME_NETWORKS = [
  { id: 'solana', label: 'Solana' },
  { id: 'base', label: 'Base' },
  { id: 'eth', label: 'Ethereum' },
  { id: 'bsc', label: 'BNB Chain' },
] as const;

interface Pool {
  id: string;
  attributes: {
    address: string;
    name: string;
    base_token_price_usd: string | null;
    pool_created_at: string | null;
    reserve_in_usd: string | null;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    price_change_percentage: { h1?: string; h24?: string };
    volume_usd: { h24?: string };
    transactions: { h24?: { buys: number; sells: number; buyers?: number; sellers?: number } };
  };
  relationships: { base_token: { data: { id: string } }; dex: { data: { id: string } } };
}
interface PoolsResp {
  data: Pool[];
  included?: { id: string; attributes: { symbol: string; name: string; address: string } }[];
}

export interface RiskFlag {
  level: 'alto' | 'médio';
  text: string;
}

/** Regras de risco explícitas (os limites aparecem na tela, junto do alerta). */
export const RISK_RULES = { minLiquidityUsd: 50_000, minAgeDays: 7, maxVolumeToLiquidity: 20, minBuyers24h: 100 };

export function riskFlags(m: { liquidity?: number; ageDays?: number; volume24?: number; buyers24?: number }): RiskFlag[] {
  const f: RiskFlag[] = [];
  if (m.liquidity === undefined) f.push({ level: 'alto', text: 'Liquidez não informada' });
  else if (m.liquidity < RISK_RULES.minLiquidityUsd) f.push({ level: 'alto', text: `Liquidez baixa (abaixo de US$ 50 mil)` });
  if (m.ageDays !== undefined && m.ageDays < RISK_RULES.minAgeDays) f.push({ level: m.ageDays < 1 ? 'alto' : 'médio', text: m.ageDays < 1 ? 'Par criado há menos de 1 dia' : `Par novo (${Math.floor(m.ageDays)} dias)` });
  if (m.liquidity && m.volume24 && m.volume24 / m.liquidity > RISK_RULES.maxVolumeToLiquidity) f.push({ level: 'médio', text: 'Volume mais de 20× a liquidez (giro especulativo)' });
  if (m.buyers24 !== undefined && m.buyers24 < RISK_RULES.minBuyers24h) f.push({ level: 'médio', text: 'Poucos compradores distintos em 24 h (concentração)' });
  return f;
}

export const memeId = (network: string, pool: string) => `meme:${network}:${pool}`;
const num = (s: string | null | undefined) => (s == null || s === '' ? undefined : +s);

export function parsePools(j: PoolsResp, network: string, fetchedAt: number): { assets: Asset[]; quotes: Quote[] } {
  const tokens = new Map((j.included ?? []).map((t) => [t.id, t.attributes]));
  const assets: Asset[] = [];
  const quotes: Quote[] = [];
  for (const p of j.data) {
    const a = p.attributes;
    const tok = tokens.get(p.relationships.base_token.data.id);
    const symbol = tok?.symbol ?? a.name.split(' / ')[0];
    const id = memeId(network, a.address);
    const liquidity = num(a.reserve_in_usd);
    const volume24 = num(a.volume_usd.h24);
    const created = a.pool_created_at ? Date.parse(a.pool_created_at) : undefined;
    const ageDays = created ? (fetchedAt - created) / 86_400_000 : undefined;
    const buyers24 = a.transactions.h24?.buyers;
    assets.push({
      id,
      symbol,
      name: tok?.name ?? a.name,
      cls: 'meme',
      quote: 'USD',
      base: symbol,
      kind: network,
      meta: {
        network,
        pool: a.address,
        pair: a.name,
        dex: p.relationships.dex.data.id,
        token: tok?.address,
        liquidity,
        volume24,
        ageDays,
        fdv: num(a.fdv_usd),
        buys24: a.transactions.h24?.buys,
        sells24: a.transactions.h24?.sells,
        buyers24,
      },
    });
    const price = num(a.base_token_price_usd);
    if (price !== undefined)
      quotes.push({
        assetId: id,
        price,
        changePct: num(a.price_change_percentage.h24),
        quoteVolume: volume24,
        sourceTime: fetchedAt,
        receivedAt: fetchedAt,
        source: SOURCE,
        delivery: 'poll',
        timeIsFetch: true,
      });
  }
  return { assets, quotes };
}

const TF: Record<Interval, [string, number]> = { '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4], '1d': ['day', 1], '1w': ['day', 1] };

export const geckoterminal = {
  source: SOURCE,
  async trending(network: string): Promise<{ assets: Asset[]; quotes: Quote[] }> {
    const t = Date.now();
    const j = await getJson<PoolsResp>(`${API}/networks/${network}/trending_pools?include=base_token`, { headers: { Accept: 'application/json' } });
    return parsePools(j, network, t);
  },
  async history(network: string, pool: string, interval: Interval): Promise<Candle[]> {
    const [tf, agg] = TF[interval];
    const j = await getJson<{ data: { attributes: { ohlcv_list: number[][] } } }>(`${API}/networks/${network}/pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=500&currency=usd`, {
      headers: { Accept: 'application/json' },
    });
    return j.data.attributes.ohlcv_list.map((r) => ({ time: r[0] * 1000, open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] })).reverse();
  },
};
