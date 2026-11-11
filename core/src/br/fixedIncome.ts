/**
 * Comparador de renda fixa: rendimento líquido com IR, IOF e custódia.
 * As regras vêm do arquivo config/regras-br.json (verificado com data e link); nada fixo aqui.
 */
export interface BrRules {
  verifiedAt: string;
  items: {
    irRendaFixa: { brackets: { maxDays: number | null; rate: number }[]; source: string; url: string };
    iofRegressivo: { percentByDay: number[]; source: string; url: string };
    isencoesPF: { lci: boolean; lca: boolean; fiiRendimentos: boolean; fiiNote: string; source: string; url: string };
    tesouroCustodia: { ratePerYear: number; selicExemptUpToBRL: number; source: string; url: string };
    fgc: { perInstitutionBRL: number; globalBRL: number; globalWindowYears: number; source: string; url: string };
    poupanca: { selicThreshold: number; aboveMonthly: number; belowSelicShare: number; source: string; url: string };
  };
}

export function irRate(rules: BrRules, days: number): number {
  for (const b of rules.items.irRendaFixa.brackets) if (b.maxDays === null || days <= b.maxDays) return b.rate;
  return rules.items.irRendaFixa.brackets[rules.items.irRendaFixa.brackets.length - 1].rate;
}

/** Fração do rendimento retida de IOF (resgate em até 29 dias). */
export function iofShare(rules: BrRules, days: number): number {
  const t = rules.items.iofRegressivo.percentByDay;
  if (days < 1) return t[0] / 100;
  return days >= t.length ? 0 : t[days - 1] / 100;
}

/** Premissas de mercado do dia (vêm do Banco Central, Focus e Tesouro). */
export interface Market {
  /** CDI anual (fração). */
  cdi: number;
  /** Selic meta anual (fração). */
  selic: number;
  /** IPCA esperado ao ano (fração), Focus. */
  ipca: number;
  /** TR mensal (fração). */
  trMonthly: number;
}

export type ProductKind = 'poupanca' | 'tesouro-selic' | 'tesouro-pre' | 'tesouro-ipca' | 'cdb' | 'lci' | 'lca' | 'fii';

export interface Product {
  kind: ProductKind;
  label: string;
  /** cdb/lci/lca: % do CDI (ex.: 100 = 100%). tesouro-pre: taxa % a.a. tesouro-ipca: taxa real % a.a. tesouro-selic: ágio % a.a. sobre a Selic. fii: dividend yield % a.a. */
  rate: number;
}

export interface Result {
  product: Product;
  gross: number;
  ir: number;
  iof: number;
  custody: number;
  net: number;
  /** Rendimento líquido equivalente ao ano (fração). */
  netAnnual: number;
  notes: string[];
}

const du = (days: number) => (days * 252) / 365; // aproximação de dias úteis (premissa mostrada)

export function simulate(rules: BrRules, m: Market, p: Product, amount: number, days: number): Result {
  const years = days / 365;
  const notes: string[] = [];
  let factor = 1;
  let taxable = true;
  let custodyRate = 0;
  switch (p.kind) {
    case 'poupanca': {
      const pr = rules.items.poupanca;
      const monthly = m.selic > pr.selicThreshold ? pr.aboveMonthly : (1 + m.selic * pr.belowSelicShare) ** (1 / 12) - 1;
      const months = Math.floor(days / 30); // rende só no aniversário mensal
      factor = ((1 + monthly) * (1 + m.trMonthly)) ** months;
      taxable = false;
      notes.push(`${m.selic > pr.selicThreshold ? '0,5% ao mês' : '70% da Selic'} + TR, só em meses completos; isenta de IR.`);
      break;
    }
    case 'tesouro-selic':
      factor = (1 + m.selic + p.rate / 100) ** (du(days) / 252);
      custodyRate = rules.items.tesouroCustodia.ratePerYear;
      notes.push('Selic constante no período (premissa).');
      break;
    case 'tesouro-pre':
      factor = (1 + p.rate / 100) ** (du(days) / 252);
      custodyRate = rules.items.tesouroCustodia.ratePerYear;
      notes.push('Taxa garantida só se levar até o vencimento; venda antes pode dar mais ou menos.');
      break;
    case 'tesouro-ipca':
      factor = ((1 + p.rate / 100) * (1 + m.ipca)) ** (du(days) / 252);
      custodyRate = rules.items.tesouroCustodia.ratePerYear;
      notes.push('IPCA do Focus como premissa; o valor real depende da inflação que vier.');
      break;
    case 'cdb':
      // CDI diário × percentual contratado, capitalizado por dia útil (convenção do mercado).
      factor = (1 + ((1 + m.cdi) ** (1 / 252) - 1) * (p.rate / 100)) ** du(days);
      notes.push('Coberto pelo FGC até o limite por instituição.');
      break;
    case 'lci':
    case 'lca':
      factor = (1 + ((1 + m.cdi) ** (1 / 252) - 1) * (p.rate / 100)) ** du(days);
      taxable = !(p.kind === 'lci' ? rules.items.isencoesPF.lci : rules.items.isencoesPF.lca);
      notes.push('Isenta de IR para pessoa física; coberta pelo FGC; costuma ter carência.');
      break;
    case 'fii':
      factor = 1 + (p.rate / 100) * years; // renda distribuída, sem reinvestir; cota pode subir ou cair
      taxable = !rules.items.isencoesPF.fiiRendimentos;
      notes.push('Só a renda distribuída (dividend yield informado); o preço da cota oscila e não está na conta. Sem FGC.');
      break;
  }
  const gross = amount * (factor - 1);
  const iof = taxable ? gross * iofShare(rules, days) : 0;
  const ir = taxable ? (gross - iof) * irRate(rules, days) : 0;
  let custody = 0;
  if (custodyRate) {
    const base = p.kind === 'tesouro-selic' ? Math.max(0, amount - rules.items.tesouroCustodia.selicExemptUpToBRL) : amount;
    custody = base * custodyRate * years;
    if (p.kind === 'tesouro-selic' && amount <= rules.items.tesouroCustodia.selicExemptUpToBRL) notes.push('Isento de custódia até R$ 10 mil.');
  }
  const net = gross - iof - ir - custody;
  return { product: p, gross, ir, iof, custody, net, netAnnual: (1 + net / amount) ** (1 / Math.max(years, 1 / 365)) - 1, notes };
}

/** Taxa (% do CDI) que um CDB precisa pagar para empatar com uma LCI/LCA isenta, no mesmo prazo. */
export function cdbEquivalent(rules: BrRules, lciPctCdi: number, days: number): number {
  return lciPctCdi / (1 - irRate(rules, days));
}

/**
 * Títulos do Tesouro por horizonte, pela rentabilidade líquida anual se levados ATÉ O VENCIMENTO
 * (IR, custódia; IPCA do Focus como premissa). Não é previsão: é a taxa contratada hoje.
 * Curto = vencimento em até 2 anos ou Tesouro Selic (liquidez diária); médio = 2 a 5 anos; longo = mais de 5 anos.
 */
export interface FixedPick {
  type: string;
  maturity: string;
  rate: number;
  netAnnual: number;
  days: number;
  date: string;
  notes: string[];
}
export function rankTesouro(
  offers: { type: string; maturity: string; date: string; buyRate: number; index: string; coupons: boolean }[],
  rules: BrRules,
  m: Market,
  horizon: 'curto' | 'medio' | 'longo',
  today = new Date().toISOString().slice(0, 10),
): FixedPick[] {
  const out: FixedPick[] = [];
  for (const o of offers) {
    if (o.coupons || o.index === 'igpm' || !(o.buyRate > -50)) continue; // cupom semestral muda o IR; IGP-M fora da venda
    const days = Math.round((Date.parse(o.maturity) - Date.parse(today)) / 86_400_000);
    if (days < 30) continue;
    const years = days / 365;
    const fits = horizon === 'curto' ? o.index === 'selic' || years <= 2 : horizon === 'medio' ? o.index !== 'selic' && years > 2 && years <= 5 : o.index !== 'selic' && years > 5;
    if (!fits) continue;
    const kind = o.index === 'selic' ? 'tesouro-selic' : o.index === 'ipca' ? 'tesouro-ipca' : 'tesouro-pre';
    const r = simulate(rules, m, { kind, label: o.type, rate: o.buyRate }, 10_000, o.index === 'selic' && horizon === 'curto' ? 365 : days);
    out.push({ type: o.type, maturity: o.maturity, rate: o.buyRate, netAnnual: r.netAnnual, days, date: o.date, notes: r.notes });
  }
  return out.sort((a, b) => b.netAnnual - a.netAnnual);
}
