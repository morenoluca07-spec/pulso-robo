import { getJson } from '../http';

/** Séries do Banco Central (SGS). Códigos confirmados na Fase 0. A Selic nunca fica fixa no código. */
const SGS = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs';
export const SERIES = { selicMeta: 432, cdiDiario: 12, cdiAno: 4389, ipcaMes: 433, ipca12m: 13522, ptax: 1 } as const;

export interface SgsPoint {
  date: string; // dd/mm/aaaa, como a fonte publica
  value: number;
}

export function parseSgs(rows: { data: string; valor: string }[]): SgsPoint[] {
  return rows.map((r) => ({ date: r.data, value: +r.valor }));
}

export const bcb = {
  source: 'Banco Central (SGS)',
  async last(code: number): Promise<SgsPoint | undefined> {
    const rows = parseSgs(await getJson<{ data: string; valor: string }[]>(`${SGS}.${code}/dados/ultimos/1?formato=json`));
    return rows[rows.length - 1];
  },
};
