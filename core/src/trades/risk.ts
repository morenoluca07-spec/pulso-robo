/**
 * Regras de risco configuráveis (inspiradas no trader-risk e no trader-budget, MIT).
 * Cada ordem é conferida como se as anteriores aprovadas já tivessem sido executadas.
 * Valores em reais (BRL): a conversão de moeda é feita antes.
 */
export interface RiskRules {
  /** Máximo de um ativo na carteira depois da compra, em % do patrimônio. */
  maxPositionPct: number;
  /** Máximo que uma operação pode perder até o stop, em % do patrimônio. */
  maxRiskPerTradePct: number;
  /** Caixa mínimo que precisa sobrar, em % do patrimônio. */
  minCashPct: number;
  /** Menor ordem aceita, em R$. */
  minOrderBRL: number;
  /** Maior ordem aceita, em R$ (0 = sem limite). */
  maxOrderBRL: number;
  maxOrdersPerDay: number;
  allowShort: boolean;
  blocked: string[];
  /** Exigir stop em toda operação. */
  requireStop: boolean;
}

export const DEFAULT_RULES: RiskRules = {
  maxPositionPct: 25,
  maxRiskPerTradePct: 1,
  minCashPct: 10,
  minOrderBRL: 10,
  maxOrderBRL: 0,
  maxOrdersPerDay: 20,
  allowShort: false,
  blocked: [],
  requireStop: true,
};

export interface OrderToCheck {
  assetId: string;
  label: string;
  side: 'buy' | 'sell';
  /** Valor da ordem em R$. */
  notionalBRL: number;
  /** Perda até o stop em R$ (ausente sem stop). */
  riskBRL?: number;
  hasStop: boolean;
}

export interface Book {
  equityBRL: number;
  cashBRL: number;
  /** Valor em R$ por ativo. */
  positionsBRL: Record<string, number>;
  ordersToday: number;
}

export interface Verdict {
  ok: boolean;
  /** Bloqueios (a ordem quebra uma regra). */
  blocks: string[];
  /** Avisos que não bloqueiam. */
  warnings: string[];
}

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function checkOrders(orders: OrderToCheck[], book: Book, rules: RiskRules): Verdict[] {
  const b: Book = { ...book, positionsBRL: { ...book.positionsBRL } };
  return orders.map((o) => {
    const blocks: string[] = [];
    const warnings: string[] = [];
    if (rules.blocked.includes(o.label) || rules.blocked.includes(o.assetId)) blocks.push(`${o.label} está na sua lista de bloqueados.`);
    if (!(o.notionalBRL > 0)) blocks.push('Valor da ordem inválido.');
    if (o.notionalBRL < rules.minOrderBRL) blocks.push(`Ordem de ${brl(o.notionalBRL)} abaixo do mínimo de ${brl(rules.minOrderBRL)}.`);
    if (rules.maxOrderBRL > 0 && o.notionalBRL > rules.maxOrderBRL) blocks.push(`Ordem de ${brl(o.notionalBRL)} acima do máximo de ${brl(rules.maxOrderBRL)}.`);
    if (b.ordersToday >= rules.maxOrdersPerDay) blocks.push(`Limite de ${rules.maxOrdersPerDay} ordens por dia atingido.`);
    const held = b.positionsBRL[o.assetId] ?? 0;
    if (o.side === 'buy') {
      if (rules.requireStop && !o.hasStop) blocks.push('Sem stop: suas regras exigem stop em toda operação.');
      if (o.riskBRL !== undefined && b.equityBRL > 0) {
        const pct = (100 * o.riskBRL) / b.equityBRL;
        if (pct > rules.maxRiskPerTradePct) blocks.push(`Perda até o stop de ${brl(o.riskBRL)} (${pct.toFixed(2).replace('.', ',')}% do patrimônio) acima do máximo de ${rules.maxRiskPerTradePct}%.`);
      }
      const after = held + o.notionalBRL;
      if (b.equityBRL > 0 && (100 * after) / b.equityBRL > rules.maxPositionPct + 1e-9)
        blocks.push(`${o.label} ficaria com ${((100 * after) / b.equityBRL).toFixed(1).replace('.', ',')}% do patrimônio, acima do máximo de ${rules.maxPositionPct}%.`);
      const cashAfter = b.cashBRL - o.notionalBRL;
      if (cashAfter < 0) blocks.push(`Caixa insuficiente: faltam ${brl(-cashAfter)}.`);
      else if (b.equityBRL > 0 && (100 * cashAfter) / b.equityBRL < rules.minCashPct - 1e-9)
        blocks.push(`Caixa ficaria em ${((100 * cashAfter) / b.equityBRL).toFixed(1).replace('.', ',')}%, abaixo do mínimo de ${rules.minCashPct}%.`);
    } else {
      if (o.notionalBRL > held + 1e-6 && !rules.allowShort) blocks.push('Venda maior que a posição: venda a descoberto está desligada nas suas regras.');
    }
    const ok = blocks.length === 0;
    if (ok) {
      // Aprovada: as próximas ordens são conferidas como se esta já tivesse sido executada.
      b.ordersToday++;
      const sign = o.side === 'buy' ? 1 : -1;
      b.positionsBRL[o.assetId] = held + sign * o.notionalBRL;
      b.cashBRL -= sign * o.notionalBRL;
    }
    return { ok, blocks, warnings };
  });
}
