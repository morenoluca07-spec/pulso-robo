import { unzipSync } from 'fflate';
import { getBytes, getJson } from '../http';
import type { FiiFundamentals } from '../br/fiiCvm';

/**
 * Investimentos de longo prazo: retorno em 12 meses, fundamentos de FIIs (CVM) e fundos da CVM (informe diário).
 * Tudo com data de referência: quem desenha a tela mostra "até dd/mm" ao lado de cada número.
 */

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/* ---------- retorno em 12 meses (Yahoo, semanal, 1 ano) ---------- */

export interface Return12m {
  /** Primeiro e último pregão usados (aaaa-mm-dd). */
  from: string;
  to: string;
  /** Só preço. */
  priceRet: number;
  /** Com proventos reinvestidos (preço ajustado do Yahoo). Igual ao de preço quando a fonte não ajusta. */
  totalRet: number;
  last: number;
}

interface ChartLike {
  chart: { result?: { timestamp?: number[]; indicators: { quote: { close: (number | null)[] }[]; adjclose?: { adjclose: (number | null)[] }[] } }[] | null };
}

/** Retorno de 12 meses a partir do gráfico semanal de 1 ano. Ativo com menos de ~11 meses de histórico = sem número. */
export function parseReturn12m(j: ChartLike): Return12m | null {
  const r = j.chart.result?.[0];
  const ts = r?.timestamp ?? [];
  const close = r?.indicators.quote[0]?.close ?? [];
  const adj = r?.indicators.adjclose?.[0]?.adjclose ?? close;
  const ok = (i: number) => (close[i] ?? 0) > 0 && (adj[i] ?? 0) > 0;
  let a = 0;
  while (a < ts.length && !ok(a)) a++;
  let b = ts.length - 1;
  while (b > a && !ok(b)) b--;
  if (b <= a || (ts[b] - ts[a]) * 1000 < 330 * DAY) return null;
  // Salto de semana para semana fora de 0,4×–2,5× (no preço ou no ajustado) = série quebrada na fonte
  // (ex.: XPML11 em 12/01/2026 com fechamento de 1,06 e ajustado errado antes disso). Melhor sem número que número falso.
  let pc = close[a]!;
  let pa = adj[a]!;
  for (let i = a + 1; i <= b; i++) {
    if (!ok(i)) continue;
    const rc = close[i]! / pc;
    const ra = adj[i]! / pa;
    if (rc < 0.4 || rc > 2.5 || ra < 0.4 || ra > 2.5) throw new Error('série da fonte com salto suspeito (desdobramento ou erro); sem retorno de 12 meses');
    pc = close[i]!;
    pa = adj[i]!;
  }
  return { from: iso(ts[a] * 1000), to: iso(ts[b] * 1000), priceRet: close[b]! / close[a]! - 1, totalRet: adj[b]! / adj[a]! - 1, last: close[b]! };
}

/* ---------- FIIs: 12 meses pelo informe mensal da CVM ---------- */

/** Junta informes de anos diferentes (histórico completo; retrato do mês mais recente). */
export function mergeFii(...years: Map<string, FiiFundamentals>[]): Map<string, FiiFundamentals> {
  const out = new Map<string, FiiFundamentals>();
  for (const y of years)
    for (const [t, f] of y) {
      const prev = out.get(t);
      const hist = new Map([...(prev?.history ?? []), ...f.history].map((h) => [h.month, h]));
      const latest = !prev || f.month >= prev.month ? f : prev;
      out.set(t, { ...latest, history: [...hist.values()].sort((x, y2) => x.month.localeCompare(y2.month)) });
    }
  return out;
}

export interface FiiLongTerm {
  /** Mês mais recente informado à CVM (aaaa-mm). */
  month: string;
  /** Rendimento estimado por cota no último mês (R$). */
  lastIncome: number;
  /** Soma dos rendimentos estimados nos últimos 12 meses informados (R$ por cota). */
  income12m: number;
  /** Quantos meses dos últimos 12 a CVM tem (12 = ano completo). */
  months: number;
  /** Preço ÷ valor patrimonial por cota. */
  pvp?: number;
  /** Rendimento de 12 meses ÷ preço atual. */
  dy12m?: number;
  /** Rendimento do último mês ÷ preço atual. */
  dyMonth?: number;
  /** O fundo informou DY 0 em todos os meses (comum em fundos de recebíveis): rendimento não informado, não "zero". */
  notReported: boolean;
  /** Meses com DY negativo informado pelo fundo (ex.: XPML11 em jan/2026, −R$ 6,52 por cota). Com algum, DY fica sem número. */
  negativeMonths: string[];
  /** Meses com DY acima de 5% no mês: erro de digitação na CVM (ex.: VCJR11 informou 0,817 em dez/2025, ou seja 81,7%). */
  outlierMonths: string[];
  /** Algum mês negativo ou fora do padrão: DY de 12 meses fica sem número. */
  inconsistent: boolean;
}

const monthsBack = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
};

export function fiiLongTerm(f: FiiFundamentals, price?: number): FiiLongTerm {
  const start = monthsBack(f.month, 11);
  const last12 = f.history.filter((h) => h.month >= start && h.month <= f.month);
  const income12m = last12.reduce((a, h) => a + h.incomePerShare, 0);
  const p = price && price > 0 ? price : undefined;
  const pvp = p && f.vpPerShare > 0 ? p / f.vpPerShare : undefined;
  const negativeMonths = last12.filter((h) => h.dy < 0).map((h) => h.month);
  const outlierMonths = last12.filter((h) => h.dy > 0.05).map((h) => h.month);
  const inconsistent = negativeMonths.length > 0 || outlierMonths.length > 0;
  const base = { month: f.month, lastIncome: f.incomePerShare, income12m, months: last12.length, pvp, negativeMonths, outlierMonths, inconsistent };
  if (last12.length && last12.every((h) => h.dy === 0)) return { ...base, notReported: true };
  if (inconsistent) return { ...base, notReported: false };
  return {
    notReported: false,
    negativeMonths,
    outlierMonths,
    inconsistent,
    month: f.month,
    lastIncome: f.incomePerShare,
    income12m,
    months: last12.length,
    pvp: p && f.vpPerShare > 0 ? p / f.vpPerShare : undefined,
    dy12m: p ? income12m / p : undefined,
    dyMonth: p ? f.incomePerShare / p : undefined,
  };
}

/* ---------- Fundos da CVM: cadastro + informe diário (cota) ---------- */

const digits = (s: string) => s.replace(/\D/g, '');
const lines = (t: string) => t.split(/\r?\n/).filter(Boolean);

export interface FundInfo {
  cnpj: string; // só dígitos
  name: string;
  /** Classificação da CVM: Renda Fixa, Ações, Multimercado, Cambial. */
  cls: string;
  anbima?: string;
  audience: string;
  exclusive: boolean;
  active: boolean;
  /** Fundo de longo prazo para o IR (come-cotas 15%). */
  longTermTax?: boolean;
}

/** `registro_classe.csv` da CVM (cadastro das classes de fundos, Resolução 175). Só classes FIF (fundos financeiros). */
export function parseFundRegistry(csv: string): Map<string, FundInfo> {
  const r = lines(csv);
  const h = r[0].split(';');
  const i = (n: string) => h.indexOf(n);
  const [iC, iT, iN, iS, iCl, iA, iE, iP, iL] = ['CNPJ_Classe', 'Tipo_Classe', 'Denominacao_Social', 'Situacao', 'Classificacao', 'Classificacao_Anbima', 'Exclusivo', 'Publico_Alvo', 'Tributacao_Longo_Prazo'].map(i);
  const out = new Map<string, FundInfo>();
  for (const l of r.slice(1)) {
    const c = l.split(';');
    if (!c[iT]?.includes('FIF') || !c[iCl]) continue;
    out.set(digits(c[iC]), {
      cnpj: digits(c[iC]),
      name: c[iN],
      cls: c[iCl],
      anbima: c[iA] || undefined,
      audience: c[iP],
      exclusive: c[iE] === 'S',
      active: c[iS] === 'Em Funcionamento Normal',
      longTermTax: c[iL] ? c[iL] === 'S' : undefined,
    });
  }
  return out;
}

export interface FundQuota {
  cnpj: string; // só dígitos
  date: string;
  quota: number;
  pl: number;
  holders: number;
}

/** Última cota de cada classe no informe diário (até `maxDate`, se dado). Linhas de subclasse ficam de fora. */
export function lastQuotas(csv: string, maxDate?: string): Map<string, FundQuota> {
  const r = lines(csv);
  const h = r[0].split(';');
  const [iC, iS, iD, iQ, iP, iH] = ['CNPJ_FUNDO_CLASSE', 'ID_SUBCLASSE', 'DT_COMPTC', 'VL_QUOTA', 'VL_PATRIM_LIQ', 'NR_COTST'].map((n) => h.indexOf(n));
  const out = new Map<string, FundQuota>();
  for (let k = 1; k < r.length; k++) {
    const c = r[k].split(';');
    if (c[iS]) continue;
    const date = c[iD];
    if (maxDate && date > maxDate) continue;
    const cnpj = digits(c[iC]);
    const prev = out.get(cnpj);
    if (prev && prev.date >= date) continue;
    const quota = Number(c[iQ]);
    if (!(quota > 0)) continue;
    out.set(cnpj, { cnpj, date, quota, pl: Number(c[iP]), holders: Number(c[iH]) });
  }
  return out;
}

export interface FundLongTerm {
  cnpj: string;
  name: string;
  cls: string;
  anbima?: string;
  audience: string;
  longTermTax?: boolean;
  pl: number;
  holders: number;
  date: string;
  from: string;
  /** Variação da cota (já líquida de taxas, antes do IR). */
  ret12m: number;
}

export interface FundFilter {
  minPL?: number;
  minHolders?: number;
  audiences?: string[];
}

/** Retorno de 12 meses pela cota, só fundos abertos ao público, ativos e não exclusivos. */
export function fundsLongTerm(latest: Map<string, FundQuota>, old: Map<string, FundQuota>, reg: Map<string, FundInfo>, f: FundFilter = {}): FundLongTerm[] {
  const { minPL = 0, minHolders = 0, audiences = ['Público Geral'] } = f;
  const out: FundLongTerm[] = [];
  for (const [cnpj, q] of latest) {
    const info = reg.get(cnpj);
    const o = old.get(cnpj);
    if (!info || !o || !info.active || info.exclusive || !audiences.includes(info.audience)) continue;
    if (q.pl < minPL || q.holders < minHolders) continue;
    const span = (Date.parse(q.date) - Date.parse(o.date)) / DAY;
    if (span < 350 || span > 380) continue;
    out.push({ cnpj, name: info.name, cls: info.cls, anbima: info.anbima, audience: info.audience, longTermTax: info.longTermTax, pl: q.pl, holders: q.holders, date: q.date, from: o.date, ret12m: q.quota / o.quota - 1 });
  }
  return out.sort((a, b) => b.pl - a.pl);
}

const CVM = 'https://dados.cvm.gov.br/dados/FI';
const ym = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

async function unzipCsv(url: string, match: RegExp, latin1 = false): Promise<string> {
  const { bytes } = await getBytes(url, 180_000);
  const files = unzipSync(bytes, { filter: (x) => match.test(x.name) });
  const name = Object.keys(files)[0];
  if (!name) throw new Error(`CVM: arquivo esperado não veio em ${url.split('/').pop()}`);
  return new TextDecoder(latin1 ? 'latin1' : 'utf-8').decode(files[name]);
}

/** Informe diário de um mês (aaaamm). Cerca de 2 a 12 MB. */
export const fetchCvmDaily = (month: string) => unzipCsv(`${CVM}/DOC/INF_DIARIO/DADOS/inf_diario_fi_${month}.zip`, /inf_diario/);

/** Cadastro das classes de fundos (≈ 7 MB). */
export const fetchFundRegistry = () => unzipCsv(`${CVM}/CAD/DADOS/registro_fundo_classe.zip`, /registro_classe/, true);

/**
 * Fundos com retorno de 12 meses: mês atual (ou o anterior, no começo do mês) e o mesmo dia de um ano atrás.
 * Baixa ≈ 20 MB: só no PC.
 */
export async function fetchFundsLongTerm(now = Date.now(), filter: FundFilter = { minPL: 50e6, minHolders: 100 }): Promise<{ funds: FundLongTerm[]; date: string }> {
  const d = new Date(now);
  // Mês atual ainda não publicado (ou só 1 ou 2 dias): usa o mês anterior.
  let latest = await fetchCvmDaily(ym(d))
    .then((csv) => lastQuotas(csv))
    .catch(() => new Map<string, FundQuota>());
  if (latest.size < 1000) {
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    latest = lastQuotas(await fetchCvmDaily(ym(d)));
  }
  let date = '';
  for (const q of latest.values()) if (q.date > date) date = q.date;
  const target = new Date(Date.parse(date) - 365 * DAY);
  // Alvo nos primeiros dias do mês: a última cota do mês anterior fica mais perto de 12 meses.
  if (target.getUTCDate() <= 5) target.setUTCDate(0);
  const old = lastQuotas(await fetchCvmDaily(ym(target)), iso(target.getTime()));
  const reg = parseFundRegistry(await fetchFundRegistry());
  return { funds: fundsLongTerm(latest, old, reg, filter), date };
}

/* ---------- EUA: valor de mercado e setor (Nasdaq screener) ---------- */

export interface UsCompany {
  symbol: string;
  name: string;
  marketCap: number;
  sector?: string;
  industry?: string;
  country?: string;
}

interface ScreenerResp {
  data: { rows: { symbol: string; name: string; marketCap: string; sector: string; industry: string; country: string }[] };
}

/**
 * Só tamanho e setor. O preço desta lista vem sem horário e, no teste de 11/11/2026, estava diferente do pregão
 * (AAPL 348,51 contra 353,45 no Yahoo): não é usado como cotação.
 */
export function parseNasdaqScreener(j: ScreenerResp): UsCompany[] {
  return j.data.rows
    .map((r) => ({ symbol: r.symbol.trim(), name: r.name.replace(/ (Common Stock|Class [A-Z] Common Stock|Ordinary Shares|American Depositary Shares).*$/i, '').trim(), marketCap: Number(r.marketCap) || 0, sector: r.sector || undefined, industry: r.industry || undefined, country: r.country || undefined }))
    .filter((r) => r.marketCap > 0 && !/[\^/]/.test(r.symbol))
    .sort((a, b) => b.marketCap - a.marketCap);
}

export async function fetchUsCompanies(): Promise<UsCompany[]> {
  return parseNasdaqScreener(await getJson<ScreenerResp>('https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }, 40_000));
}
