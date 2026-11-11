import type { Asset } from '../types';

/** Etiquetas do feed (seção 8.5). */
export type NewsTag = 'resultado' | 'jurídico' | 'negócio' | 'macro' | 'risco' | 'oficial';

/** Remove acentos e baixa a caixa, para comparar textos. */
export function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const RULES: [NewsTag, RegExp][] = [
  ['resultado', /\b(lucro|prejuizo|balanco|resultado (do|trimestral|tri)|receita|ebitda|guidance|earnings|revenue|quarterly|eps|1t\d{2}|2t\d{2}|3t\d{2}|4t\d{2}|dividend|proventos|jcp|juros sobre capital)/],
  ['jurídico', /\b(justica|judicial|processo|stf|stj|cvm (abre|investiga|multa)|tcu|cade|lawsuit|sec charges|settlement|investigacao|recuperacao judicial|falencia|bankruptcy|sued?)\b/],
  ['risco', /\b(rebaixa|downgrade|calote|default|fraude|hack|exploit|rug pull|liquidac|queda forte|despenca|crash|tomba|suspens|alerta|warning|delisting)/],
  ['macro', /\b(selic|copom|ipca|inflacao|pib|juros|fed\b|fomc|payroll|cambio|dolar|banco central|focus|desemprego|cpi|gdp|treasury|tesouro|fiscal|arcabouco)/],
  ['negócio', /\b(aquisicao|compra de|fusao|merger|acquisition|acordo|parceria|ipo|follow-on|oferta|emissao|debentures|recompra|buyback|investimento de|contrato|deal|joint venture)/],
];

export function tagNews(title: string, summary = ''): NewsTag[] {
  const t = norm(`${title} ${summary.slice(0, 200)}`);
  return RULES.filter(([, re]) => re.test(t)).map(([k]) => k);
}

/** Nomes populares de cripto citados em manchetes, para ligar a notícia ao par certo. */
const CRYPTO_NAMES: Record<string, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  ether: 'ETH',
  solana: 'SOL',
  ripple: 'XRP',
  xrp: 'XRP',
  cardano: 'ADA',
  dogecoin: 'DOGE',
  'shiba inu': 'SHIB',
  avalanche: 'AVAX',
  polkadot: 'DOT',
  chainlink: 'LINK',
  litecoin: 'LTC',
  tron: 'TRX',
  toncoin: 'TON',
  pepe: 'PEPE',
  bnb: 'BNB',
  hyperliquid: 'HYPE',
  sui: 'SUI',
};

export interface AssetIndex {
  /** Ticker exato (PETR4, AAPL…) para id. */
  bySymbol: Map<string, string>;
  /** Primeiras palavras do nome normalizado (PETROBRAS, VALE…) para id. */
  byName: [string, string][];
}

const STOP = new Set(['banco', 'companhia', 'grupo', 'brasil', 'brasileira', 'brasileiro', 'fundo', 'investimento', 'investimentos', 'holding', 'participacoes', 'energia', 'global', 'nacional', 'industria', 'industrias', 'comercio', 'servicos', 'empreendimentos', 'gestao', 'sistemas', 'tecnologia', 'saude', 'seguros', 'transmissao', 'distribuicao', 'geracao', 'saneamento', 'educacao', 'mineracao', 'alimentos', 'varejo', 'logistica', 'imoveis', 'construcoes', 'engenharia', 'petroleo', 'estado', 'paulo', 'janeiro', 'minas', 'gerais', 'santa', 'catarina', 'grande', 'parana', 'bahia', 'unidas', 'brasilia', 'novo', 'nova', 'mercado', 'capital', 'financeira', 'credito']);

/** Índice para achar ativos citados. Só ações/FIIs da B3, EUA e cripto em USDT. */
export function buildIndex(assets: Asset[]): AssetIndex {
  const bySymbol = new Map<string, string>();
  const byName: [string, string][] = [];
  for (const a of assets) {
    if (a.cls === 'crypto') {
      if (a.quote === 'USDT' && a.base) bySymbol.set(`$${a.base}`, a.id);
      continue;
    }
    if (a.cls === 'br' || a.cls === 'fii') bySymbol.set(a.symbol, a.id);
    else if (a.cls === 'us') bySymbol.set(`US:${a.symbol}`, a.id);
  }
  // Nome da empresa: só palavras que aparecem em uma única razão social (PETROBRAS, EMBRAER...),
  // para "Brasil" ou "Energia" não ligarem a notícia à empresa errada.
  const owners = new Map<string, Set<string>>();
  const firstId = new Map<string, string>();
  for (const a of assets) {
    if (a.cls !== 'br' || a.kind !== 'ação') continue;
    const name = norm(a.name);
    if (!firstId.has(name)) firstId.set(name, a.id);
    for (const w of new Set(name.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/))) {
      if (w.length < 5 || STOP.has(w)) continue;
      if (!owners.has(w)) owners.set(w, new Set());
      owners.get(w)!.add(name);
    }
  }
  for (const [w, names] of owners) if (names.size === 1) byName.push([w, firstId.get([...names][0])!]);
  return { bySymbol, byName };
}

/**
 * Ativos citados no título: tickers da B3 (PETR4, MXRF11), cashtags ($AAPL), nomes de cripto e
 * nomes de empresas da B3. `hint` = ativo do feed (ex.: notícias do Yahoo para AAPL).
 */
export function relatedAssets(title: string, idx: AssetIndex, hint?: string): string[] {
  const out = new Set<string>();
  if (hint) out.add(hint);
  for (const m of title.matchAll(/\b([A-Z]{4}\d{1,2})\b/g)) {
    const id = idx.bySymbol.get(m[1]);
    if (id) out.add(id);
  }
  for (const m of title.matchAll(/\$([A-Z]{1,5})\b/g)) {
    const id = idx.bySymbol.get(`US:${m[1]}`) ?? idx.bySymbol.get(`$${m[1]}`);
    if (id) out.add(id);
  }
  const t = norm(title);
  for (const [name, sym] of Object.entries(CRYPTO_NAMES)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      const id = idx.bySymbol.get(`$${sym}`);
      if (id) out.add(id);
    }
  }
  const words = new Set(t.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/));
  for (const [first, id] of idx.byName) if (words.has(first)) out.add(id);
  return [...out].slice(0, 6);
}

/** Chave de repetição: mesma manchete em feeds diferentes vira um item só. */
export function dedupeKey(title: string): string {
  return norm(title)
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
