import { getJson } from '../http';

/** Painel da economia: séries do Banco Central (SGS) e expectativas do Focus (Olinda). */
const SGS = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs';
const OLINDA = 'https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata';

export interface Point {
  date: string; // aaaa-mm-dd
  value: number;
}

const iso = (br: string) => {
  const [d, m, y] = br.split('/');
  return `${y}-${m}-${d}`;
};
const brDate = (t: number) => {
  const d = new Date(t);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

export async function sgs(code: number, fromDays = 800): Promise<Point[]> {
  const rows = await getJson<{ data: string; valor: string }[]>(`${SGS}.${code}/dados?formato=json&dataInicial=${brDate(Date.now() - fromDays * 86_400_000)}&dataFinal=${brDate(Date.now() + 120 * 86_400_000)}`);
  return rows.map((r) => ({ date: iso(r.data), value: +r.valor }));
}

export interface FocusYear {
  indicator: string;
  year: string;
  median: number;
  date: string;
  respondents: number;
}

export async function focusAnnual(): Promise<FocusYear[]> {
  const f = encodeURIComponent("Indicador eq 'Selic' or Indicador eq 'IPCA' or Indicador eq 'Câmbio' or Indicador eq 'PIB Total'");
  const j = await getJson<{ value: { Indicador: string; Data: string; DataReferencia: string; Mediana: number; numeroRespondentes: number; baseCalculo: number }[] }>(
    `${OLINDA}/ExpectativasMercadoAnuais?$top=60&$format=json&$orderby=Data%20desc&$filter=${f}`,
  );
  const last = j.value[0]?.Data;
  return j.value
    .filter((v) => v.Data === last && v.baseCalculo === 0)
    .map((v) => ({ indicator: v.Indicador, year: v.DataReferencia, median: v.Mediana, date: v.Data, respondents: v.numeroRespondentes }));
}

export async function focusIpca12m(): Promise<{ median: number; date: string } | undefined> {
  const j = await getJson<{ value: { Data: string; Mediana: number; baseCalculo: number }[] }>(
    `${OLINDA}/ExpectativasMercadoInflacao12Meses?$top=4&$format=json&$orderby=Data%20desc&$filter=${encodeURIComponent("Indicador eq 'IPCA' and Suavizada eq 'S'")}`,
  );
  const v = j.value.find((x) => x.baseCalculo === 0);
  return v && { median: v.Mediana, date: v.Data };
}

/** Selic esperada pelo Focus para as próximas reuniões (R1/2027, R2/2027…). */
export async function focusSelicPath(): Promise<{ meeting: string; median: number; date: string }[]> {
  const j = await getJson<{ value: { Data: string; Reuniao: string; Mediana: number; baseCalculo: number }[] }>(`${OLINDA}/ExpectativasMercadoSelic?$top=60&$format=json&$orderby=Data%20desc`);
  const last = j.value[0]?.Data;
  const order = (r: string) => {
    const [n, y] = r.slice(1).split('/');
    return +y * 10 + +n;
  };
  return j.value
    .filter((v) => v.Data === last && v.baseCalculo === 0)
    .map((v) => ({ meeting: v.Reuniao, median: v.Mediana, date: v.Data }))
    .sort((a, b) => order(a.meeting) - order(b.meeting));
}

export type RateTrend = 'subindo' | 'parados' | 'caindo';

/** Tendência dos juros pelas últimas decisões (SGS 432) e pelo caminho do Focus. */
export function rateTrend(selicHistory: Point[], path: { median: number }[]): { recent: RateTrend; expected: RateTrend; current: number; inOneYear?: number } {
  const changes: number[] = [];
  for (let i = 1; i < selicHistory.length; i++) if (selicHistory[i].value !== selicHistory[i - 1].value) changes.push(selicHistory[i].value - selicHistory[i - 1].value);
  const last = changes.slice(-2);
  const today = new Date().toISOString().slice(0, 10);
  const current = [...selicHistory].reverse().find((p) => p.date <= today)?.value ?? selicHistory[selicHistory.length - 1]?.value;
  const recentSince = selicHistory.slice(-200);
  const lastChange = recentSince.length ? recentSince[recentSince.length - 1].value - recentSince[0].value : 0;
  const recent: RateTrend = last.length && last.every((c) => c > 0) ? 'subindo' : last.length && last.every((c) => c < 0) ? 'caindo' : lastChange > 0 ? 'subindo' : lastChange < 0 ? 'caindo' : 'parados';
  const target = path[Math.min(path.length - 1, 7)]?.median; // ~8 reuniões = 1 ano
  const expected: RateTrend = target === undefined ? 'parados' : target < current - 0.24 ? 'caindo' : target > current + 0.24 ? 'subindo' : 'parados';
  return { recent, expected, current, inOneYear: target };
}

/** Texto curto, sempre com data, explicando o momento dos juros e o que costuma significar. Educativo. */
export function rateNarrative(t: ReturnType<typeof rateTrend>, ipca12: number | undefined, date: string): string {
  const pct = (v: number) => `${v.toFixed(2).replace('.', ',')}%`;
  const real = ipca12 !== undefined ? ((1 + t.current / 100) / (1 + ipca12 / 100) - 1) * 100 : undefined;
  const parts = [`Em ${date.split('-').reverse().join('/')}, a Selic está em ${pct(t.current)} ao ano`];
  parts[0] += t.recent === 'parados' ? ' e vem parada nas últimas reuniões.' : t.recent === 'caindo' ? ', depois de cortes recentes.' : ', depois de altas recentes.';
  if (t.inOneYear !== undefined) parts.push(`O mercado (Focus) espera ${pct(t.inOneYear)} em cerca de um ano, ou seja, juros ${t.expected}.`);
  if (real !== undefined) parts.push(`Descontada a inflação esperada para 12 meses (${pct(ipca12!)}), o juro real fica perto de ${pct(real)} ao ano${real > 6 ? ', um nível alto' : ''}.`);
  if (t.expected === 'caindo')
    parts.push('Historicamente, quando os juros caem, títulos prefixados e IPCA+ longos tendem a se valorizar, e ações e FIIs costumam ser favorecidos; o pós-fixado (CDI) passa a render menos.');
  else if (t.expected === 'subindo') parts.push('Quando os juros sobem, o pós-fixado (CDI) rende mais; prefixados e IPCA+ longos podem perder valor antes do vencimento, e ações e FIIs costumam sofrer.');
  else parts.push('Com juros parados em nível alto, o pós-fixado segue competitivo; prefixados e IPCA+ dependem de quando os cortes vierem.');
  parts.push('Isto é uma leitura educativa do cenário, não uma recomendação.');
  return parts.join(' ');
}
