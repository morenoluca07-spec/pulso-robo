import type { Quote } from '../types';

/**
 * Encaixe para uma fonte paga da B3 mais rápida que a lista grátis da brapi (~30 min).
 * Nenhuma está implementada: o app mostra o encaixe e o motivo. Para ligar uma, implemente `quotes`
 * (cotação com `sourceTime` real da fonte) e marque `implemented: true`; o registro escolhe a primeira ligada.
 *
 * Conferido em 11/11/2026 (brapi.dev/pricing, pergunta "Os dados são em tempo real?"): a resposta oficial é "Não".
 * Startup atualiza a cada 15 min e Pro a cada 5 min. Tempo real de verdade da B3 só por distribuidor licenciado
 * pela B3 (plano de dados de mercado pago), não por esses planos.
 */
export interface B3LiveProvider {
  id: string;
  name: string;
  site: string;
  /** Atraso declarado pela própria fonte, em minutos (0 = tempo real). */
  declaredDelayMin: number;
  verified: string;
  implemented: boolean;
  needsKey: boolean;
  note: string;
  quotes?: (tickers: string[], key: string) => Promise<Quote[]>;
}

export const B3_LIVE_PROVIDERS: B3LiveProvider[] = [
  {
    id: 'brapi-pro',
    name: 'brapi Pro',
    site: 'https://brapi.dev/pricing',
    declaredDelayMin: 5,
    verified: '2026-11-11',
    implemented: false,
    needsKey: true,
    note: 'Pago. Atualiza a cada 5 min (a própria brapi diz que não é tempo real).',
  },
  {
    id: 'b3-licenciado',
    name: 'Distribuidor licenciado pela B3',
    site: 'https://www.b3.com.br/pt_br/market-data-e-indices/servicos-de-dados/market-data/',
    declaredDelayMin: 0,
    verified: '2026-11-11',
    implemented: false,
    needsKey: true,
    note: 'Único caminho para tempo real de verdade. Exige contrato pago de dados de mercado.',
  },
];

/** Fonte paga ligada (nenhuma, por enquanto). */
export const activeB3Live = (): B3LiveProvider | null => B3_LIVE_PROVIDERS.find((p) => p.implemented && p.quotes) ?? null;
