import type { Quote } from './types';

export type FreshnessKind = 'live' | 'delayed' | 'close' | 'closed' | 'stale';

export interface Freshness {
  kind: FreshnessKind;
  /** Texto do selo, exatamente como aparece na tela. */
  label: string;
  ageMs: number;
}

/** Abaixo disso o dado é "AO VIVO" (regra 2 do prompt). */
export const LIVE_MAX_MS = 2_000;

/**
 * Calcula o selo de idade de uma cotação.
 * `marketOpen` = false quando o mercado do ativo está fechado (bolsa fora do pregão).
 */
export function freshness(q: Pick<Quote, 'sourceTime' | 'delivery' | 'declaredDelayMin' | 'marketState' | 'timeIsFetch'>, now: number, marketOpen = q.marketState !== 'closed'): Freshness {
  const ageMs = Math.max(0, now - q.sourceTime);
  if (!marketOpen) return { kind: 'closed', label: 'MERCADO FECHADO', ageMs };
  if (q.delivery === 'close') return { kind: 'close', label: 'FECHAMENTO', ageMs };
  if (ageMs < LIVE_MAX_MS) return { kind: 'live', label: 'AO VIVO', ageMs };
  const min = Math.round(ageMs / 60_000);
  // Fluxo contínuo: a fonte só envia quando há negócio. Preço parado não é atraso da fonte.
  if (q.delivery === 'stream') {
    return { kind: 'stale', label: min >= 1 ? `HÁ ${min} min` : `HÁ ${Math.round(ageMs / 1000)} s`, ageMs };
  }
  // Consulta com mais de 4 h: nenhuma fonte atrasa tanto, é o último fechamento daquele mercado.
  if (ageMs > 4 * 3600_000) return { kind: 'close', label: 'FECHAMENTO', ageMs };
  if (q.delivery === 'delayed' || min >= 1) {
    // timeIsFetch: o horário é o da consulta, não do preço. O preço já tinha o atraso declarado
    // quando foi consultado, então a idade real = idade da consulta + atraso declarado.
    const declared = q.declaredDelayMin ?? 0;
    const shown = q.timeIsFetch ? min + declared : Math.max(min, declared);
    return { kind: 'delayed', label: shown >= 1 ? `ATRASO ~${shown} min` : `ATRASO ${Math.round(ageMs / 1000)} s`, ageMs };
  }
  // Fluxo contínuo que ficou alguns segundos sem negócio: ainda é recente, mas não "ao vivo".
  return { kind: 'stale', label: `HÁ ${Math.round(ageMs / 1000)} s`, ageMs };
}

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Sao_Paulo' });

/** "Binance · 13:42:05" — fonte e horário que acompanham o selo. */
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

export function sourceStamp(q: Pick<Quote, 'source' | 'sourceTime' | 'timeIsFetch'>, now = Date.now()): string {
  const old = now - q.sourceTime > 20 * 3600_000;
  const t = old ? dateFmt.format(q.sourceTime) : timeFmt.format(q.sourceTime);
  return q.timeIsFetch ? `${q.source}, consultado ${t}` : `${q.source}, ${t}`;
}
