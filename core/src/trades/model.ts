/**
 * Operações: diário (operações reais feitas na corretora, lançadas à mão) e conta simulada.
 * O Pulso nunca envia ordem com dinheiro real.
 */
export type Account = 'real' | 'paper';
export type Side = 'long' | 'short';

export interface Trade {
  id: string;
  account: Account;
  assetId: string;
  /** Rótulo do ativo no momento do lançamento (PETR4, BTC/USDT…). */
  label: string;
  cls: string;
  /** Moeda do preço (BRL, USD, USDT). */
  currency: string;
  side: Side;
  qty: number;
  entryPrice: number;
  entryAt: number;
  exitPrice?: number;
  exitAt?: number;
  stop?: number;
  target?: number;
  /** Custos totais na moeda do preço (corretagem, emolumentos, taxas). */
  fees: number;
  strategy: string;
  reason: string;
  /** Print do gráfico (imagem reduzida, data URL). */
  screenshot?: string;
  /** Nota livre da saída. */
  exitNote?: string;
}

export const isOpen = (t: Trade) => t.exitPrice === undefined;

export interface PnL {
  /** Resultado na moeda do ativo, já com custos. */
  net: number;
  /** Resultado em % sobre o valor de entrada, já com custos. */
  pct: number;
  /** Resultado em múltiplos do risco inicial (R). Ausente sem stop. */
  r?: number;
}

/** Resultado de uma operação ao preço `price` (saída, se fechada; preço atual, se aberta). */
export function pnl(t: Trade, price = t.exitPrice): PnL | null {
  if (price === undefined || !Number.isFinite(price)) return null;
  const dir = t.side === 'long' ? 1 : -1;
  const gross = (price - t.entryPrice) * t.qty * dir;
  const net = gross - t.fees;
  const base = t.entryPrice * t.qty;
  const risk = t.stop !== undefined ? Math.abs(t.entryPrice - t.stop) * t.qty : 0;
  return { net, pct: base > 0 ? net / base : 0, r: risk > 0 ? net / risk : undefined };
}

/** Risco em aberto: quanto se perde se o stop for atingido (na moeda do ativo). Sem stop = risco total. */
export function openRisk(t: Trade, price: number): number {
  if (t.stop === undefined) return price * t.qty;
  const dir = t.side === 'long' ? 1 : -1;
  return Math.max(0, (price - t.stop) * t.qty * dir);
}

/** Distância percentual do preço até o stop e até o alvo (positivo = falta andar). */
export function distances(t: Trade, price: number): { toStop?: number; toTarget?: number } {
  const dir = t.side === 'long' ? 1 : -1;
  return {
    toStop: t.stop !== undefined ? ((price - t.stop) / price) * dir : undefined,
    toTarget: t.target !== undefined ? ((t.target - price) / price) * dir : undefined,
  };
}
