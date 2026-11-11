import { getJson, getText } from '../http';

export interface CalEvent {
  id: string;
  /** Início (ms). Se só houver dia, meio-dia de Brasília. */
  time: number;
  title: string;
  country: 'BR' | 'EUA';
  kind: 'juros' | 'inflação' | 'atividade';
  source: string;
  sourceUrl: string;
  /** Data publicada pela fonte oficial ou conferida em mais de uma fonte (ver `note`). */
  confirmed: boolean;
  note?: string;
}

/* ---------- IBGE (calendário oficial de divulgações) ---------- */

const IBGE_PRODUCTS: Record<number, { title: string; kind: CalEvent['kind'] }> = {
  9256: { title: 'IPCA (inflação oficial)', kind: 'inflação' },
  9260: { title: 'IPCA-15 (prévia da inflação)', kind: 'inflação' },
  9300: { title: 'PIB trimestral', kind: 'atividade' },
};

interface IbgeResp {
  items: { id: number; titulo: string; data_divulgacao: string; produto_id: number }[];
}

export function parseIbge(j: IbgeResp): CalEvent[] {
  return j.items
    .filter((i) => IBGE_PRODUCTS[i.produto_id])
    .map((i) => {
      const [d, m, rest] = i.data_divulgacao.split('/');
      const [y, hm] = rest.split(' ');
      const p = IBGE_PRODUCTS[i.produto_id];
      return {
        id: `ibge-${i.id}`,
        time: Date.parse(`${y}-${m}-${d}T${hm ?? '09:00:00'}-03:00`),
        title: p.title,
        country: 'BR' as const,
        kind: p.kind,
        source: 'IBGE',
        sourceUrl: 'https://www.ibge.gov.br/calendario-de-divulgacao.html',
        confirmed: true,
      };
    });
}

const ddmmyyyy = (t: number) => {
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
};

/* ---------- FOMC (página oficial do Federal Reserve) ---------- */

const MONTHS: Record<string, number> = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };

/** Decisão do FOMC sai às 14h de Washington no 2º dia da reunião. */
export function parseFomc(html: string): CalEvent[] {
  const out: CalEvent[] = [];
  const blocks = html.split(/(\d{4}) FOMC Meetings/);
  for (let k = 1; k < blocks.length - 1; k += 2) {
    const year = +blocks[k];
    const b = blocks[k + 1].slice(0, 30_000);
    for (const m of b.matchAll(/fomc-meeting__month[^>]*><strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g)) {
      const monthTxt = m[1].trim();
      const dateTxt = m[2].trim();
      if (/notation|unscheduled|cancel/i.test(dateTxt)) continue;
      const lastMonth = monthTxt.includes('/') ? monthTxt.split('/')[1] : monthTxt;
      const mon = MONTHS[lastMonth] ?? MONTHS[Object.keys(MONTHS).find((n) => n.startsWith(lastMonth)) ?? ''];
      const day = +(dateTxt.match(/(\d+)\D*$/)?.[1] ?? NaN);
      if (!mon || !Number.isFinite(day)) continue;
      // 14h em Washington (EST, UTC−5 de nov. a mar.; EDT, UTC−4 de mar. a nov.). Aproximação por mês.
      const off = mon >= 4 && mon <= 10 ? '-04:00' : '-05:00';
      out.push({
        id: `fomc-${year}-${mon}-${day}`,
        time: Date.parse(`${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}T14:00:00${off}`),
        title: `Decisão de juros nos EUA (FOMC)${dateTxt.includes('*') ? ', com projeções' : ''}`,
        country: 'EUA',
        kind: 'juros',
        source: 'Federal Reserve',
        sourceUrl: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
        confirmed: true,
      });
    }
  }
  return out;
}

/* ---------- Copom (arquivo de configuração conferido) ---------- */

export interface CopomConfig {
  verifiedAt: string;
  source: string;
  sourceUrl: string;
  note: string;
  meetings: { start: string; end: string }[];
}

export function copomEvents(cfg: CopomConfig): CalEvent[] {
  return cfg.meetings.map((m) => ({
    id: `copom-${m.end}`,
    time: Date.parse(`${m.end}T18:30:00-03:00`),
    title: 'Decisão da Selic (Copom)',
    country: 'BR' as const,
    kind: 'juros' as const,
    source: cfg.source,
    sourceUrl: cfg.sourceUrl,
    confirmed: false,
    note: cfg.note,
  }));
}

export const calendar = {
  async ibge(from = Date.now(), days = 120): Promise<CalEvent[]> {
    const j = await getJson<IbgeResp>(`https://servicodados.ibge.gov.br/api/v3/calendario/?qtd=1000&de=${ddmmyyyy(from)}&ate=${ddmmyyyy(from + days * 86_400_000)}`);
    return parseIbge(j);
  },
  async fomc(): Promise<CalEvent[]> {
    return parseFomc(await getText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'));
  },
};
