/** Classes de ativo que o Pulso cobre (seção 8.2 do prompt). */
export type AssetClass = 'br' | 'fii' | 'us' | 'world' | 'crypto' | 'meme' | 'fixed';

/** Como a fonte entrega o dado. Define o selo mostrado ao lado do número. */
export type Delivery = 'stream' | 'poll' | 'delayed' | 'close';

export interface Asset {
  /** Identificador interno estável: `<classe>:<símbolo>` (ex.: `crypto:BTCUSDT`). */
  id: string;
  symbol: string;
  name: string;
  cls: AssetClass;
  /** Moeda de cotação (USDT, BRL, USD…). */
  quote: string;
  base?: string;
  /** Subtipo (ação, etf, bdr, fii, fi-agro, fi-infra…) para filtros. */
  kind?: string;
  /** Símbolo na fonte de detalhe/gráfico quando difere (ex.: `PETR4.SA` no Yahoo). */
  ref?: string;
  /** Extras da fonte (rede e endereço do pool, setor…). */
  meta?: Record<string, string | number | undefined>;
}

export interface Quote {
  assetId: string;
  price: number;
  /** Variação em 24 h (cripto) ou no dia (bolsa), em %. Ausente = a fonte não informou. */
  changePct?: number;
  open?: number;
  high?: number;
  low?: number;
  /** Volume financeiro na moeda de cotação. */
  quoteVolume?: number;
  /** Momento do dado na fonte, em ms (já corrigido pelo offset de relógio). */
  sourceTime: number;
  /** Momento em que o Pulso recebeu, em ms (relógio local). */
  receivedAt: number;
  source: string;
  delivery: Delivery;
  /** Atraso declarado pela fonte, em minutos (ex.: brapi grátis ~30). */
  declaredDelayMin?: number;
  /** A fonte não informa o horário do dado: `sourceTime` é o horário da consulta. */
  timeIsFetch?: boolean;
  /** Pregão do ativo aberto ou fechado (bolsas). Ausente = mercado 24 h. */
  marketState?: 'open' | 'closed';
  previousClose?: number;
  volume?: number;
}

export interface Candle {
  time: number; // início do candle, ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w';

export type HealthState = 'ok' | 'degraded' | 'down' | 'idle';

export interface SourceHealth {
  source: string;
  state: HealthState;
  /** Último dado recebido (ms local). */
  lastMessageAt?: number;
  /** Latência mediana medida (ms), quando a fonte informa o horário do evento. */
  latencyMs?: number;
  messages: number;
  reconnects: number;
  /** Motivo legível do último problema. */
  lastError?: string;
}

/** Interface única de todo adaptador (seção 5): cotação, histórico, stream e saúde. */
export interface SourceAdapter {
  readonly id: string;
  readonly label: string;
  readonly classes: AssetClass[];
  listAssets(): Promise<Asset[]>;
  quotes(assetIds?: string[]): Promise<Quote[]>;
  history(assetId: string, interval: Interval, limit?: number): Promise<Candle[]>;
  /** Abre o fluxo contínuo. Retorna função para fechar. */
  stream?(onQuotes: (q: Quote[]) => void, onHealth: (h: SourceHealth) => void): () => void;
  health(): SourceHealth;
}
