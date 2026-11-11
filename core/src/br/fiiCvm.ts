import { unzipSync } from 'fflate';
import { getBytes } from '../http';
import { mergeFii } from '../invest/longTerm';

/**
 * Fundamentos de FIIs pelo informe mensal da CVM (dados abertos, defasagem de 1 a 2 meses).
 * O ticker sai do código ISIN (BRMXRFCTF008 → MXRF11). Dividend yield da CVM é sobre o patrimônio líquido.
 */
export interface FiiFundamentals {
  ticker: string;
  cnpj: string;
  name: string;
  segment: string;
  /** Mês de referência (aaaa-mm). */
  month: string;
  /** Valor patrimonial por cota (R$). */
  vpPerShare: number;
  /** Dividend yield do mês sobre o patrimônio (fração). */
  dyMonthPL: number;
  /** Rendimento estimado por cota no mês (R$) = DY × VP. */
  incomePerShare: number;
  shareholders?: number;
  /** Histórico (mês, rendimento estimado por cota) dos meses disponíveis no arquivo. */
  history: { month: string; incomePerShare: number; dy: number }[];
}

const splitCsv = (t: string) => t.split(/\r?\n/).filter(Boolean).map((l) => l.split(';'));

export function tickerFromIsin(isin: string): string | null {
  const m = isin.match(/^BR([A-Z0-9]{4})CTF\d{3}$/);
  return m ? `${m[1]}11` : null;
}

export function parseFiiCsv(geral: string, complemento: string): Map<string, FiiFundamentals> {
  const g = splitCsv(geral);
  const gh = g[0];
  const gi = (n: string) => gh.indexOf(n);
  const info = new Map<string, { ticker: string; name: string; segment: string }>();
  for (const r of g.slice(1)) {
    const t = tickerFromIsin(r[gi('Codigo_ISIN')] ?? '');
    if (t) info.set(r[gi('CNPJ_Fundo_Classe')], { ticker: t, name: r[gi('Nome_Fundo_Classe')], segment: r[gi('Segmento_Atuacao')] });
  }
  const c = splitCsv(complemento);
  const ch = c[0];
  const ci = (n: string) => ch.indexOf(n);
  // Por CNPJ primeiro. Mesmo mês em versões diferentes: vale a maior versão (reapresentação).
  // Linha curta ou sem data (arquivo cortado, linha quebrada) fica de fora em vez de derrubar a leitura.
  const di = ci('Data_Referencia');
  const rows = c.slice(1).filter((r) => /^\d{4}-\d{2}/.test(r[di] ?? '') && !!r[ci('CNPJ_Fundo_Classe')]).sort((a, b) => a[ci('Data_Referencia')].localeCompare(b[ci('Data_Referencia')]) || Number(a[ci('Versao')]) - Number(b[ci('Versao')]));
  const byCnpj = new Map<string, FiiFundamentals>();
  for (const r of rows) {
    const cnpj = r[ci('CNPJ_Fundo_Classe')];
    const meta = info.get(cnpj);
    if (!meta) continue;
    const vp = Number(r[ci('Valor_Patrimonial_Cotas')]);
    const dy = Number(r[ci('Percentual_Dividend_Yield_Mes')]);
    if (!(vp > 0) || !Number.isFinite(dy)) continue;
    const month = r[ci('Data_Referencia')].slice(0, 7);
    const prev = byCnpj.get(cnpj);
    const hist = [...(prev?.history ?? []).filter((h) => h.month !== month), { month, incomePerShare: dy * vp, dy }];
    byCnpj.set(cnpj, {
      ticker: meta.ticker,
      cnpj,
      name: meta.name,
      segment: meta.segment,
      month,
      vpPerShare: vp,
      dyMonthPL: dy,
      incomePerShare: dy * vp,
      shareholders: Number(r[ci('Total_Numero_Cotistas')]) || undefined,
      history: hist,
    });
  }
  // O mesmo ISIN aparece em mais de um CNPJ (fundo antigo e classe nova da Resolução 175, ou veículo interno com
  // poucos cotistas: XPML11 tem um de 11 cotistas com VP de R$ 22.523). Vale o que está em dia e tem mais cotistas,
  // que é o negociado na bolsa.
  const mi = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  const groups = new Map<string, FiiFundamentals[]>();
  for (const f of byCnpj.values()) groups.set(f.ticker, [...(groups.get(f.ticker) ?? []), f]);
  const out = new Map<string, FiiFundamentals>();
  for (const [t, fs] of groups) {
    const latest = Math.max(...fs.map((f) => mi(f.month)));
    const best = fs.filter((f) => mi(f.month) >= latest - 1).sort((x, y) => (y.shareholders ?? 0) - (x.shareholders ?? 0))[0];
    out.set(t, best);
  }
  return out;
}

export async function fetchFiiFundamentals(year = new Date().getFullYear()): Promise<{ data: Map<string, FiiFundamentals>; updated?: string }> {
  const { bytes, lastModified } = await getBytes(`https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/inf_mensal_fii_${year}.zip`);
  const files = unzipSync(bytes);
  const dec = new TextDecoder('latin1');
  const name = (k: string) => Object.keys(files).find((n) => n.includes(k));
  const geral = name('_geral_');
  const comp = name('_complemento_');
  if (!geral || !comp) throw new Error('CVM: arquivo do informe mensal sem as tabelas esperadas');
  return { data: parseFiiCsv(dec.decode(files[geral]), dec.decode(files[comp])), updated: lastModified };
}

/** Ano atual + anterior juntos, para ter 12 meses de rendimentos (≈ 2,8 MB). */
export async function fetchFiiFundamentals12m(now = new Date()): Promise<{ data: Map<string, FiiFundamentals>; updated?: string }> {
  const y = now.getFullYear();
  const [prev, cur] = await Promise.allSettled([fetchFiiFundamentals(y - 1), fetchFiiFundamentals(y)]);
  if (cur.status === 'fulfilled') return { data: prev.status === 'fulfilled' ? mergeFii(prev.value.data, cur.value.data) : cur.value.data, updated: cur.value.updated };
  // Em janeiro a CVM ainda não publicou o zip do ano: vale só o ano anterior (cada FII traz o próprio mês de referência).
  if (prev.status === 'fulfilled') return prev.value;
  throw cur.reason;
}
