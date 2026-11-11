import type { FundPortfolio } from '../investors/cvmFunds';
import { fundDiff } from '../investors/cvmFunds';
import type { HlState } from '../investors/hyperliquid';
import type { PtrRow } from '../investors/congress';
import type { Factor } from './signal';

/**
 * O que os grandes investidores fizeram com o ativo (lógica dos skills trader-copycat e trader-pelosi).
 * Só entra na leitura de hoje, como contexto com peso pequeno: não existe no histórico do backtest e chega
 * atrasado (CVM: mês de ~2 meses atrás; Congresso: até 45 dias de prazo para declarar).
 */

export interface InstitutionalFlow {
  up: number; // entraram ou aumentaram
  down: number; // reduziram ou zeraram
  holders: number; // fundos com o papel no mês mais recente
  month: string;
}

/** Fundos de ações da CVM (CDA): quantos aumentaram ou reduziram cada papel do mês anterior para o atual. */
export function institutionalFlow(now: FundPortfolio[], prev: FundPortfolio[], month: string): Map<string, InstitutionalFlow> {
  const before = new Map(prev.map((f) => [f.cnpj, f]));
  const out = new Map<string, InstitutionalFlow>();
  for (const f of now) {
    const p = before.get(f.cnpj);
    if (!p) continue; // fundo sem mês anterior para comparar
    for (const d of fundDiff(f, p)) {
      const e = out.get(d.ticker) ?? { up: 0, down: 0, holders: 0, month };
      if (d.status === 'NOVA' || d.status === 'AUMENTOU') e.up++;
      if (d.status === 'REDUZIU' || d.status === 'ZEROU') e.down++;
      if (d.status !== 'ZEROU') e.holders++;
      out.set(d.ticker, e);
    }
  }
  return out;
}

const mmYY = (m: string) => `${m.slice(4, 6) || m.slice(5, 7)}/${m.slice(0, 4)}`;

export function institutionalFactor(f: InstitutionalFlow | undefined): Factor | null {
  if (!f || f.up + f.down < 3) return null;
  const net = (f.up - f.down) / (f.up + f.down);
  return { key: 'investidores', value: 0.06 * net, text: `Fundos de ações (CVM, carteira de ${mmYY(f.month)}): ${f.up} entraram ou aumentaram, ${f.down} reduziram ou saíram` };
}

export interface CrowdPositions {
  long: number;
  short: number;
  traders: number;
}

/** Quantos dos traders acompanhados na Hyperliquid estão comprados ou vendidos em cada moeda. */
export function hlConsensus(states: HlState[]): Map<string, CrowdPositions> {
  const out = new Map<string, CrowdPositions>();
  for (const s of states)
    for (const p of s.positions) {
      const e = out.get(p.coin) ?? { long: 0, short: 0, traders: states.length };
      if (p.size > 0) e.long++;
      else if (p.size < 0) e.short++;
      out.set(p.coin, e);
    }
  return out;
}

export function hlFactor(c: CrowdPositions | undefined): Factor | null {
  if (!c || c.long + c.short < 3) return null;
  const net = (c.long - c.short) / (c.long + c.short);
  return { key: 'investidores', value: 0.05 * net, text: `Maiores traders da Hyperliquid (${c.traders} acompanhados): ${c.long} comprados, ${c.short} vendidos` };
}

export interface CongressFlow {
  buys: number;
  sells: number;
  last: string;
}

/** Compras e vendas declaradas por membros do Congresso dos EUA (PTRs) nos últimos `days` dias. */
export function congressFlow(rows: PtrRow[], now = Date.now(), days = 90): Map<string, CongressFlow> {
  const out = new Map<string, CongressFlow>();
  const since = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  for (const r of rows) {
    if (!r.ticker || !r.date || r.date < since) continue;
    const e = out.get(r.ticker) ?? { buys: 0, sells: 0, last: '' };
    if (/^P/i.test(r.type)) e.buys++;
    else if (/^S/i.test(r.type)) e.sells++;
    if (r.date > e.last) e.last = r.date;
    out.set(r.ticker, e);
  }
  return out;
}

export function congressFactor(c: CongressFlow | undefined): Factor | null {
  if (!c || c.buys + c.sells === 0) return null;
  const net = (c.buys - c.sells) / (c.buys + c.sells);
  return { key: 'investidores', value: 0.04 * net, text: `Congresso dos EUA (declarações dos últimos 90 dias): ${c.buys} compra(s), ${c.sells} venda(s); última em ${c.last.split('-').reverse().join('/')}` };
}
