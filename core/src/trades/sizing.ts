/**
 * Calculadora de tamanho de posição: a partir de quanto você aceita perder se o stop for atingido.
 * quantidade = perda aceita ÷ (distância entrada→stop + custo por unidade)
 */
export interface SizeInput {
  /** Quanto aceita perder, na moeda do ativo. */
  riskAmount: number;
  entry: number;
  stop: number;
  /** Lote mínimo: 1 (fracionário/cripto inteira), 100 (lote padrão B3), 0 = fracionado livre (cripto). */
  lot: number;
  /** Custo de ida e volta em fração (0,001 = 0,1%). */
  costPct?: number;
  /** Teto em dinheiro (ex.: caixa disponível ou máximo por ativo). */
  maxNotional?: number;
}

export interface SizeResult {
  qty: number;
  notional: number;
  /** Perda real se o stop for atingido, com custos. */
  lossAtStop: number;
  /** Por que a quantidade ficou menor que a ideal (lote, teto). */
  limitedBy?: 'lote' | 'teto';
  error?: string;
}

export function positionSize(i: SizeInput): SizeResult {
  if (!(i.entry > 0) || !(i.stop > 0)) return { qty: 0, notional: 0, lossAtStop: 0, error: 'Informe entrada e stop maiores que zero.' };
  if (i.entry === i.stop) return { qty: 0, notional: 0, lossAtStop: 0, error: 'O stop precisa ser diferente da entrada.' };
  if (!(i.riskAmount > 0)) return { qty: 0, notional: 0, lossAtStop: 0, error: 'Informe quanto aceita perder.' };
  const perUnit = Math.abs(i.entry - i.stop) + i.entry * (i.costPct ?? 0);
  let qty = i.riskAmount / perUnit;
  let limitedBy: SizeResult['limitedBy'];
  if (i.maxNotional !== undefined && qty * i.entry > i.maxNotional) {
    qty = i.maxNotional / i.entry;
    limitedBy = 'teto';
  }
  if (i.lot > 0) {
    // Folga contra erro de ponto flutuante: 300 / 100 pode dar 2,9999999 e perder um lote.
    const rounded = Math.floor(qty / i.lot + 1e-9) * i.lot;
    if (rounded < qty && !limitedBy) limitedBy = 'lote';
    qty = rounded;
  } else qty = Math.floor(qty * 1e8 + 1e-6) / 1e8;
  if (qty <= 0) return { qty: 0, notional: 0, lossAtStop: 0, limitedBy, error: i.lot > 1 ? `A perda aceita não cobre nem 1 lote de ${i.lot}. Use o mercado fracionário (lote 1) ou aumente a perda aceita.` : 'A perda aceita não cobre nem 1 unidade.' };
  return { qty, notional: qty * i.entry, lossAtStop: qty * perUnit, limitedBy };
}
