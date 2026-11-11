import { pnl, type Side, type Trade } from './model';

/**
 * Conta simulada (paper trading): saldo fictício em reais, executa ao preço real da tela.
 * Ativos em dólar/USDT são convertidos pelo câmbio da tela no momento da execução.
 * Posição vendida (short) guarda o valor como garantia e devolve garantia + resultado ao fechar.
 */
export interface PaperState {
  startBRL: number;
  cashBRL: number;
  createdAt: number;
}

export interface Fill {
  price: number;
  /** Reais por 1 unidade da moeda do ativo (1 para BRL). */
  fx: number;
  at: number;
  /** Custo de ida e volta (fração); metade é cobrada em cada lado. */
  costPct: number;
}

export function openPaper(state: PaperState, t: Omit<Trade, 'fees' | 'entryPrice' | 'entryAt' | 'account'>, fill: Fill): { state: PaperState; trade: Trade } {
  const notional = fill.price * t.qty;
  const fee = notional * (fill.costPct / 2);
  const costBRL = (notional + fee) * fill.fx;
  if (costBRL > state.cashBRL + 1e-9) throw new Error('Saldo simulado insuficiente.');
  return {
    state: { ...state, cashBRL: state.cashBRL - costBRL },
    trade: { ...t, account: 'paper', entryPrice: fill.price, entryAt: fill.at, fees: fee },
  };
}

export function closePaper(state: PaperState, t: Trade, fill: Fill, note?: string): { state: PaperState; trade: Trade } {
  if (t.exitPrice !== undefined) throw new Error('Operação já encerrada.');
  const exitFee = fill.price * t.qty * (fill.costPct / 2);
  const closed: Trade = { ...t, exitPrice: fill.price, exitAt: fill.at, fees: t.fees + exitFee, exitNote: note };
  // Devolve a garantia (valor de entrada) mais o resultado bruto, menos a taxa de saída.
  const gross = pnl({ ...closed, fees: 0 })!.net;
  const back = (t.entryPrice * t.qty + gross - exitFee) * fill.fx;
  return { state: { ...state, cashBRL: state.cashBRL + back }, trade: closed };
}

/** Patrimônio simulado ao preço atual. */
export function paperEquity(state: PaperState, open: Trade[], price: (t: Trade) => number | undefined, fx: (currency: string) => number): number {
  let v = state.cashBRL;
  for (const t of open) {
    const p = price(t) ?? t.entryPrice;
    const gross = pnl({ ...t, fees: 0 }, p)!.net;
    v += (t.entryPrice * t.qty + gross) * fx(t.currency);
  }
  return v;
}

export const sideLabel = (s: Side) => (s === 'long' ? 'Compra' : 'Venda (vendido)');
