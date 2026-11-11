import { FGC_COVERED, groupBy, hhi, type Valued } from './model';

/** Perfil informado por você (nada é presumido: sem perfil, o diagnóstico pede os dados). */
export interface Profile {
  goal: 'reserva' | 'aposentadoria' | 'imovel' | 'renda' | 'crescer' | 'outro';
  horizonYears: number;
  monthlyExpensesBRL: number;
  reserveMonths: number;
  risk: 'conservador' | 'moderado' | 'arrojado';
}

export const GOAL_LABEL: Record<Profile['goal'], string> = {
  reserva: 'montar reserva',
  aposentadoria: 'aposentadoria',
  imovel: 'comprar um imóvel',
  renda: 'viver de renda',
  crescer: 'fazer o patrimônio crescer',
  outro: 'outro objetivo',
};

/** Limites usados nos alertas, por perfil. São premissas educativas, mostradas junto de cada conclusão. */
export const PROFILE_LIMITS: Record<Profile['risk'], { maxVariable: number; maxCrypto: number; maxFx: number }> = {
  conservador: { maxVariable: 0.2, maxCrypto: 0.02, maxFx: 0.15 },
  moderado: { maxVariable: 0.5, maxCrypto: 0.05, maxFx: 0.3 },
  arrojado: { maxVariable: 0.85, maxCrypto: 0.15, maxFx: 0.5 },
};
export const MAX_SINGLE_ASSET = 0.2;

export interface Finding {
  level: 'atenção' | 'aviso' | 'ok';
  title: string;
  detail: string;
  /** Premissas que levaram à conclusão. */
  assumptions: string[];
}

const pct = (v: number) => `${(v * 100).toFixed(1).replace('.', ',')}%`;
const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

export interface DiagnosisInput {
  holdings: Valued[];
  profile: Profile | null;
  /** CDI bruto ao ano (Banco Central) e líquido de IR na faixa de longo prazo, para comparar. */
  cdiGross: number;
  cdiNet: number;
  /** Rendimento anual da poupança pela regra vigente (regras-br.json + Selic + TR). */
  poupancaAnnual: number;
  /** Retorno de 12 meses por posição de risco (preço), quando houver histórico. */
  return12m: Record<string, number>;
  cdi12m: number;
  fgcLimit: number;
}

export function diagnose(i: DiagnosisInput): Finding[] {
  const f: Finding[] = [];
  const hs = i.holdings.filter((h) => !h.missing);
  const total = hs.reduce((a, h) => a + h.valueBRL, 0);
  if (!total) return [];
  const p = i.profile;

  // 1. Reserva de emergência
  const liquid = hs.filter((h) => h.cls === 'cash' || (h.cls === 'fixed' && h.fixed?.daily)).reduce((a, h) => a + h.valueBRL, 0);
  if (p) {
    const need = p.monthlyExpensesBRL * p.reserveMonths;
    if (liquid < need)
      f.push({
        level: 'atenção',
        title: 'Reserva de emergência abaixo do que você definiu',
        detail: `Você tem ${brl(liquid)} com liquidez diária e definiu ${p.reserveMonths} meses de despesas (${brl(need)}). Faltam ${brl(need - liquid)}.`,
        assumptions: ['Conta como reserva: caixa e renda fixa marcada com liquidez diária.', `Despesa mensal informada: ${brl(p.monthlyExpensesBRL)}.`],
      });
    else f.push({ level: 'ok', title: 'Reserva de emergência completa', detail: `${brl(liquid)} com liquidez diária cobre ${(liquid / p.monthlyExpensesBRL).toFixed(1).replace('.', ',')} meses de despesas.`, assumptions: [] });
  }

  // 2. Concentração em um ativo
  for (const h of hs) {
    const w = h.valueBRL / total;
    if (h.cls !== 'cash' && h.cls !== 'fixed' && w > MAX_SINGLE_ASSET)
      f.push({ level: 'atenção', title: `Concentração em ${h.label}`, detail: `${h.label} é ${pct(w)} da carteira.`, assumptions: [`Limite de referência: ${pct(MAX_SINGLE_ASSET)} em um único ativo de renda variável.`] });
  }
  const conc = hhi(hs);
  if (hs.length > 1 && conc > 0.25)
    f.push({ level: 'aviso', title: 'Carteira concentrada', detail: `Índice de concentração ${conc.toFixed(2).replace('.', ',')} (equivale a ter ${(1 / conc).toFixed(1).replace('.', ',')} posições do mesmo tamanho).`, assumptions: ['Índice de Herfindahl: soma dos pesos ao quadrado; acima de 0,25 indica concentração.'] });

  // 3. Perfil: renda variável, cripto e moeda
  if (p) {
    const lim = PROFILE_LIMITS[p.risk];
    const variable = hs.filter((h) => !['fixed', 'cash'].includes(h.cls)).reduce((a, h) => a + h.valueBRL, 0) / total;
    const crypto = hs.filter((h) => h.cls === 'crypto' || h.cls === 'meme').reduce((a, h) => a + h.valueBRL, 0) / total;
    const fx = hs.filter((h) => h.currency !== 'BRL' || h.abroad).reduce((a, h) => a + h.valueBRL, 0) / total;
    if (variable > lim.maxVariable) f.push({ level: 'atenção', title: 'Mais renda variável que o seu perfil', detail: `${pct(variable)} em ações, FIIs, exterior e cripto.`, assumptions: [`Referência para perfil ${p.risk}: até ${pct(lim.maxVariable)}.`] });
    if (crypto > lim.maxCrypto) f.push({ level: 'atenção', title: 'Exposição a cripto acima do perfil', detail: `${pct(crypto)} em cripto e memecoins.`, assumptions: [`Referência para perfil ${p.risk}: até ${pct(lim.maxCrypto)}.`] });
    if (fx > lim.maxFx) f.push({ level: 'aviso', title: 'Risco cambial alto', detail: `${pct(fx)} do patrimônio varia com o dólar.`, assumptions: [`Referência para perfil ${p.risk}: até ${pct(lim.maxFx)}. Conta tudo cotado em moeda estrangeira, cripto e contas no exterior.`] });
    else if (fx === 0 && p.horizonYears >= 5) f.push({ level: 'aviso', title: 'Nenhuma proteção em moeda forte', detail: 'Todo o patrimônio está em reais.', assumptions: ['Para prazos longos, parte em dólar costuma reduzir o risco de concentrar tudo na economia brasileira.'] });
  }

  // 4. Rende menos que o CDI depois do imposto
  for (const h of hs) {
    if (h.cls === 'fixed' && h.fixed) {
      const fx = h.fixed;
      const isento = ['lci', 'lca', 'poupanca', 'cri-cra'].includes(fx.product);
      const taxKeep = i.cdiGross > 0 ? i.cdiNet / i.cdiGross : 0.85;
      const annual =
        fx.index === 'poupanca'
          ? i.poupancaAnnual
          : fx.index === 'cdi' || fx.index === 'selic'
            ? ((i.cdiGross * fx.rate) / 100) * (isento ? 1 : taxKeep)
            : undefined;
      if (annual !== undefined && annual < i.cdiNet - 0.002)
        f.push({ level: 'aviso', title: `${h.label} rende menos que o CDI líquido`, detail: `Estimativa de ${pct(annual)} ao ano líquido contra ${pct(i.cdiNet)} de um CDB 100% do CDI após o IR de longo prazo.`, assumptions: ['CDI atual constante.', fx.index === 'poupanca' ? 'Poupança pela regra vigente (regras-br.json) com a Selic e a TR de hoje.' : `Taxa contratada de ${fx.rate}% do índice.`] });
    }
  }
  for (const [label, r] of Object.entries(i.return12m)) {
    if (r < i.cdi12m)
      f.push({ level: 'aviso', title: `${label} rendeu menos que o CDI em 12 meses`, detail: `Preço ${r >= 0 ? '+' : ''}${pct(r)} contra CDI ${pct(i.cdi12m)} no mesmo período.`, assumptions: ['Só variação de preço (proventos não incluídos).', 'Passado não garante futuro; é um ponto de atenção, não uma ordem de venda.'] });
  }

  // 5. FGC por instituição
  const byInst = groupBy(hs.filter((h) => h.cls === 'fixed' && h.fixed && FGC_COVERED.includes(h.fixed.product)), (h) => h.institution || 'Sem instituição');
  for (const g of byInst)
    if (g.valueBRL > i.fgcLimit)
      f.push({ level: 'atenção', title: `Acima do limite do FGC em ${g.key}`, detail: `${brl(g.valueBRL)} em produtos garantidos na mesma instituição; o FGC cobre até ${brl(i.fgcLimit)}.`, assumptions: ['Soma CDB, LCI, LCA, LC e poupança da mesma instituição (conglomerado).', 'Limite conferido no site do FGC (ver regras-br.json).'] });

  // 6. Horizonte curto com renda variável
  if (p && p.horizonYears < 2) {
    const variable = hs.filter((h) => !['fixed', 'cash'].includes(h.cls)).reduce((a, h) => a + h.valueBRL, 0) / total;
    if (variable > 0.2) f.push({ level: 'atenção', title: 'Prazo curto com muita oscilação', detail: `Objetivo em ${p.horizonYears} ano(s) e ${pct(variable)} em renda variável.`, assumptions: ['Em menos de 2 anos, quedas de 20% a 30% em ações são comuns e podem não dar tempo de recuperar.'] });
  }
  return f;
}

/** Cenários para dinheiro novo, pela ordem de prioridade e pelo perfil. Educativo, com premissas. */
export function newMoneyScenarios(i: DiagnosisInput, amountBRL: number): { title: string; detail: string }[] {
  const p = i.profile;
  if (!p) return [];
  const hs = i.holdings.filter((h) => !h.missing);
  const total = hs.reduce((a, h) => a + h.valueBRL, 0) + amountBRL;
  const liquid = hs.filter((h) => h.cls === 'cash' || (h.cls === 'fixed' && h.fixed?.daily)).reduce((a, h) => a + h.valueBRL, 0);
  const out: { title: string; detail: string }[] = [];
  let left = amountBRL;
  const need = Math.max(0, p.monthlyExpensesBRL * p.reserveMonths - liquid);
  if (need > 0) {
    const r = Math.min(left, need);
    out.push({ title: `${brl(r)} para completar a reserva`, detail: 'Pós-fixado com liquidez diária (Tesouro Selic ou CDB de banco grande a 100% do CDI ou mais), antes de qualquer outra coisa.' });
    left -= r;
  }
  if (left <= 0) return out;
  const lim = PROFILE_LIMITS[p.risk];
  const variable = hs.filter((h) => !['fixed', 'cash'].includes(h.cls)).reduce((a, h) => a + h.valueBRL, 0);
  const roomVar = Math.max(0, lim.maxVariable * total - variable);
  const toVar = p.horizonYears >= 3 ? Math.min(left, roomVar) : 0;
  if (toVar > 0) out.push({ title: `${brl(toVar)} em renda variável, dentro do limite do perfil`, detail: `Seu perfil ${p.risk} aceita até ${pct(lim.maxVariable)} em renda variável e você tem ${pct(variable / total)}. Diversifique entre classes (ações, FIIs, exterior) em vez de um ativo só.` });
  const rest = left - toVar;
  if (rest > 0)
    out.push({
      title: `${brl(rest)} em renda fixa`,
      detail:
        p.horizonYears >= 5
          ? 'Prazo longo: Tesouro IPCA+ protege da inflação; o preço oscila antes do vencimento.'
          : p.horizonYears >= 2
            ? 'Prazo médio: prefixado ou CDB/LCI com vencimento perto do objetivo.'
            : 'Prazo curto: pós-fixado com liquidez.',
    });
  return out;
}


