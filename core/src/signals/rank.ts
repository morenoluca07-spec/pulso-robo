import type { Horizon } from './signal';

/**
 * "Melhores" de cada classe: ordena os ativos mais negociados da classe por um critério escolhido por teste.
 * Teste de 11/11/2026 (`core/eval/rank.eval.test.ts`, 114 ativos: 40 cripto, 40 ações B3, 25 FIIs, 30 EUA; histórico
 * diário de até 10 anos). A cada semana, os 20% primeiros do critério contra a média da classe nos h pregões seguintes.
 * Ajuste = 70% mais antigos das datas; teste = 30% mais recentes. Só entra critério com vantagem nos DOIS períodos.
 * Vantagem pequena e amostra limitada: é estatística do passado, não promessa.
 */
export type RankClass = 'crypto' | 'br' | 'fii' | 'us';
export type CriterionId = 'mom12_1' | 'mom6_1' | 'rev1w' | 'techLongo';

const ret = (c: number[], a: number, b: number) => (a >= 0 && b < c.length && c[a] > 0 ? c[b] / c[a] - 1 : undefined);
const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1).replace('.', ',')}%`;

export const CRITERIA: Record<CriterionId, { label: string; value: (closes: number[], techLongo?: number) => number | undefined; describe: (v: number) => string }> = {
  mom12_1: {
    label: 'Momento de 12 meses (sem o último mês)',
    value: (c) => ret(c, c.length - 1 - 252, c.length - 1 - 21),
    describe: (v) => `${pct(v)} de 12 meses atrás até 1 mês atrás`,
  },
  mom6_1: {
    label: 'Momento de 6 meses (sem a última semana)',
    value: (c) => ret(c, c.length - 1 - 126, c.length - 1 - 5),
    describe: (v) => `${pct(v)} de 6 meses atrás até 1 semana atrás`,
  },
  rev1w: {
    label: 'Reversão de 1 semana (quem mais caiu)',
    value: (c) => {
      const r = ret(c, c.length - 1 - 5, c.length - 1);
      return r === undefined ? undefined : -r;
    },
    describe: (v) => `${pct(-v)} na última semana`,
  },
  techLongo: {
    label: 'Leitura técnica de longo prazo (tendência de 50 e 200 dias)',
    value: (_c, t) => t,
    describe: (v) => `pontuação técnica de longo prazo ${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2).replace('.', ',')}`,
  },
};

export interface PeriodResult {
  /** Retorno em excesso médio dos 20% primeiros sobre a média da classe, por período de h pregões. */
  excess: number;
  /** Fração das semanas em que os 20% primeiros venceram a média. */
  win: number;
  weeks: number;
}

export interface RankRule {
  cls: RankClass;
  horizon: Horizon;
  criterion: CriterionId | null;
  fit?: PeriodResult;
  test?: PeriodResult;
  /** "consistente" = vantagem nos dois períodos e vitória em ≥ 53% das semanas nos dois. */
  quality: 'consistente' | 'fraco' | 'nenhum';
  note: string;
}

export const RANK_VALIDATED = '2026-11-11';
export const RANK_UNIVERSE = { crypto: 40, br: 40, fii: 25, us: 30 } as const;

const r = (cls: RankClass, horizon: Horizon, criterion: CriterionId | null, fit?: [number, number, number], test?: [number, number, number], note = ''): RankRule => {
  const f = fit && { excess: fit[0] / 100, win: fit[1] / 100, weeks: fit[2] };
  const t = test && { excess: test[0] / 100, win: test[1] / 100, weeks: test[2] };
  const quality = !criterion || !f || !t ? 'nenhum' : f.excess > 0 && t.excess > 0 && f.win >= 0.53 && t.win >= 0.53 ? 'consistente' : 'fraco';
  return { cls, horizon, criterion, fit: f, test: t, quality, note };
};

/** Números exatos da avaliação de 11/11/2026 (excesso %, vitória %, semanas). */
export const RANK_RULES: RankRule[] = [
  r('us', 'curto', 'mom12_1', [0.31, 58, 315], [0.44, 55, 135]),
  r('us', 'medio', 'mom12_1', [0.9, 59, 313], [2.06, 57, 134]),
  r('us', 'longo', 'mom6_1', [3.22, 60, 307], [4.43, 64, 132]),
  r('crypto', 'curto', 'mom12_1', [0.17, 49, 274], [0.39, 56, 117]),
  r('crypto', 'medio', 'mom12_1', [0.46, 50, 272], [1.68, 54, 116]),
  r('crypto', 'longo', 'mom12_1', [1.78, 44, 266], [2.41, 61, 114]),
  r('br', 'curto', 'techLongo', [0.17, 56, 312], [0.19, 56, 134]),
  r('br', 'medio', 'techLongo', [0.34, 54, 310], [0.35, 57, 133]),
  r('br', 'longo', 'techLongo', [0.43, 53, 304], [1.26, 65, 131]),
  r('fii', 'curto', 'rev1w', [0.29, 64, 194], [0.02, 71, 84], 'Vantagem média quase zero no teste: vence a média em muitas semanas, mas por pouco.'),
  r('fii', 'medio', null, undefined, undefined, 'Nenhum critério de preço venceu a média da classe nos dois períodos. A lista mostra os FIIs pela renda (dividend yield de 12 meses da CVM), que não é previsão de preço.'),
  r('fii', 'longo', null, undefined, undefined, 'Nenhum critério de preço venceu a média da classe nos dois períodos. A lista mostra os FIIs pela renda (dividend yield de 12 meses da CVM), que não é previsão de preço.'),
];

export const ruleFor = (cls: RankClass, h: Horizon) => RANK_RULES.find((x) => x.cls === cls && x.horizon === h)!;

export interface RankInput {
  assetId: string;
  closes: number[];
  techLongo?: number;
}
export interface Ranked {
  assetId: string;
  value: number;
  /** 1 = primeiro. */
  position: number;
  of: number;
  text: string;
}

/** Ordena a classe pelo critério da regra. Ativos sem histórico suficiente ficam de fora (e são contados à parte). */
export function rankBy(items: RankInput[], criterion: CriterionId): { ranked: Ranked[]; excluded: string[] } {
  const c = CRITERIA[criterion];
  const ok: { assetId: string; value: number }[] = [];
  const excluded: string[] = [];
  for (const it of items) {
    const v = c.value(it.closes, it.techLongo);
    if (v === undefined || !Number.isFinite(v)) excluded.push(it.assetId);
    else ok.push({ assetId: it.assetId, value: v });
  }
  ok.sort((a, b) => b.value - a.value);
  return { ranked: ok.map((x, i) => ({ ...x, position: i + 1, of: ok.length, text: c.describe(x.value) })), excluded };
}
