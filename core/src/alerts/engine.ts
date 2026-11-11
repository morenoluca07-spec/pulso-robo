import type { Quote } from '../types';

/**
 * Regras de alerta. Lógica herdada do trader-alerts (MIT): cada regra toca uma vez;
 * acima/abaixo/stop rearmam sozinhas só se o preço voltar; variação % no máximo uma vez por dia.
 * Alerta é informação, nunca ordem: um stop que toca não vende nada.
 */
export type AlertRule =
  | { id: string; type: 'above' | 'below' | 'stop'; assetId: string; price: number; rearm?: boolean; createdAt: number; note?: string }
  | { id: string; type: 'pct_move'; assetId: string; pct: number; direction?: 'up' | 'down'; createdAt: number; note?: string }
  | { id: string; type: 'news'; assetId: string; createdAt: number; note?: string }
  | { id: string; type: 'copom'; createdAt: number; note?: string };

export interface AlertState {
  /** Regra disparada e ainda não rearmada. */
  rang: Record<string, number>;
  /** Último dia (aaaa-mm-dd, Brasília) em que uma regra de variação tocou. */
  pctDay: Record<string, string>;
}

export interface Fired {
  ruleId: string;
  at: number;
  title: string;
  body: string;
  assetId?: string;
}

export const emptyState = (): AlertState => ({ rang: {}, pctDay: {} });

const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(t);

/** Avalia regras de preço contra as cotações atuais. Devolve o que tocou e o novo estado. */
export function checkPrices(rules: AlertRule[], quotes: (id: string) => Quote | undefined, st: AlertState, now: number, label: (id: string) => string, fmt: (n: number) => string): { fired: Fired[]; state: AlertState } {
  const state: AlertState = { rang: { ...st.rang }, pctDay: { ...st.pctDay } };
  const fired: Fired[] = [];
  for (const r of rules) {
    if (r.type === 'news' || r.type === 'copom') continue;
    const q = quotes(r.assetId);
    if (!q) continue;
    if (r.type === 'pct_move') {
      if (q.changePct === undefined) continue;
      const hit = r.direction === 'up' ? q.changePct >= r.pct : r.direction === 'down' ? q.changePct <= -r.pct : Math.abs(q.changePct) >= r.pct;
      const today = day(now);
      if (hit && state.pctDay[r.id] !== today) {
        state.pctDay[r.id] = today;
        fired.push({ ruleId: r.id, at: now, assetId: r.assetId, title: `${label(r.assetId)} ${q.changePct > 0 ? 'subiu' : 'caiu'} ${Math.abs(q.changePct).toFixed(2).replace('.', ',')}%`, body: `Regra: variação de ${r.pct}% no dia. Preço ${fmt(q.price)} (${q.source}).` });
      }
      continue;
    }
    const hit = r.type === 'above' ? q.price >= r.price : q.price <= r.price;
    if (hit && !state.rang[r.id]) {
      state.rang[r.id] = now;
      const what = r.type === 'above' ? 'chegou a' : r.type === 'stop' ? 'atingiu o stop em' : 'caiu a';
      fired.push({
        ruleId: r.id,
        at: now,
        assetId: r.assetId,
        title: `${label(r.assetId)} ${what} ${fmt(r.price)}`,
        body: `Preço agora ${fmt(q.price)} (${q.source}).${r.type === 'stop' ? ' Nada foi vendido: o Pulso não envia ordens.' : ''}`,
      });
    } else if (!hit && state.rang[r.id] && 'rearm' in r && r.rearm) {
      // Preço voltou para o outro lado: a regra pode tocar de novo.
      delete state.rang[r.id];
    }
  }
  return { fired, state };
}

export function ruleText(r: AlertRule, label: (id: string) => string, fmt: (n: number) => string): string {
  switch (r.type) {
    case 'above':
      return `${label(r.assetId)} chegar a ${fmt(r.price)} ou mais`;
    case 'below':
      return `${label(r.assetId)} cair a ${fmt(r.price)} ou menos`;
    case 'stop':
      return `Stop de ${label(r.assetId)} em ${fmt(r.price)}`;
    case 'pct_move':
      return `${label(r.assetId)} ${r.direction === 'up' ? 'subir' : r.direction === 'down' ? 'cair' : 'variar'} ${r.pct}% no dia`;
    case 'news':
      return `Notícia nova sobre ${label(r.assetId)}`;
    case 'copom':
      return 'Decisão do Copom publicada';
  }
}
