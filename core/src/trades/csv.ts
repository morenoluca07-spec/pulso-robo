import type { Side, Trade } from './model';

/**
 * Importação de planilha (CSV exportado do Excel ou Google Planilhas).
 * Aceita separador ; ou , ; números em formato brasileiro (1.234,56) ou americano (1234.56);
 * datas dd/mm/aaaa (com hora opcional) ou aaaa-mm-dd. Cabeçalhos em português, sem acento ou com.
 */
export const CSV_COLUMNS = ['data', 'ativo', 'lado', 'quantidade', 'preco_entrada', 'preco_saida', 'data_saida', 'stop', 'alvo', 'taxas', 'estrategia', 'motivo'] as const;

const ALIASES: Record<string, (typeof CSV_COLUMNS)[number]> = {
  data: 'data',
  data_entrada: 'data',
  entrada_data: 'data',
  ativo: 'ativo',
  ticker: 'ativo',
  codigo: 'ativo',
  lado: 'lado',
  tipo: 'lado',
  operacao: 'lado',
  quantidade: 'quantidade',
  qtd: 'quantidade',
  qtde: 'quantidade',
  preco_entrada: 'preco_entrada',
  entrada: 'preco_entrada',
  preco: 'preco_entrada',
  preco_saida: 'preco_saida',
  saida: 'preco_saida',
  data_saida: 'data_saida',
  stop: 'stop',
  stop_loss: 'stop',
  alvo: 'alvo',
  target: 'alvo',
  taxas: 'taxas',
  custos: 'taxas',
  corretagem: 'taxas',
  estrategia: 'estrategia',
  setup: 'estrategia',
  motivo: 'motivo',
  observacao: 'motivo',
  obs: 'motivo',
};

const key = (h: string) =>
  h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Número em formato BR ou US. Vazio = undefined. */
export function parseNumber(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  let t = s.trim().replace(/[R$\sUSD]/g, '');
  if (!t) return undefined;
  if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (t.includes(',')) t = t.replace(',', '.');
  // Só pontos em grupos de 3 dígitos (10.000, 1.234.567): separador de milhar brasileiro.
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

export function parseDate(s: string | undefined): number | undefined {
  if (!s?.trim()) return undefined;
  const t = s.trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return Date.parse(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${(m[4] ?? '12').padStart(2, '0')}:${m[5] ?? '00'}:00-03:00`);
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '12'}:${m[5] ?? '00'}:00-03:00`);
  return NaN;
}

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === sep && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export interface ImportRow {
  line: number;
  trade?: Omit<Trade, 'id' | 'assetId' | 'cls' | 'currency' | 'label'> & { ticker: string };
  error?: string;
}

/** Lê o CSV. Linhas com erro voltam com o motivo (nada é importado sem você ver). */
export function parseTradesCsv(text: string): ImportRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const head = splitLine(lines[0], sep).map((h) => ALIASES[key(h)]);
  if (!head.includes('ativo') || !head.includes('quantidade') || !head.includes('preco_entrada'))
    return [{ line: 1, error: 'Cabeçalho precisa ter ao menos as colunas ativo, quantidade e preco_entrada.' }];
  return lines.slice(1).map((l, i) => {
    const cells = splitLine(l, sep);
    const get = (c: (typeof CSV_COLUMNS)[number]) => {
      const ix = head.indexOf(c);
      return ix >= 0 ? cells[ix]?.trim() : undefined;
    };
    const line = i + 2;
    const ticker = (get('ativo') ?? '').toUpperCase();
    const qty = parseNumber(get('quantidade'));
    const entryPrice = parseNumber(get('preco_entrada'));
    const exitPrice = parseNumber(get('preco_saida'));
    const entryAt = parseDate(get('data')) ?? Date.now();
    const exitAt = parseDate(get('data_saida'));
    const lado = key(get('lado') ?? 'compra');
    const side: Side = /^(v|venda|vendido|short|sell)/.test(lado) ? 'short' : 'long';
    const nums = { qty, entryPrice, exitPrice, stop: parseNumber(get('stop')), target: parseNumber(get('alvo')), fees: parseNumber(get('taxas')) };
    if (!ticker) return { line, error: 'Ativo vazio.' };
    if (!(qty! > 0)) return { line, error: 'Quantidade inválida.' };
    if (!(entryPrice! > 0)) return { line, error: 'Preço de entrada inválido.' };
    for (const [k, v] of Object.entries(nums)) if (Number.isNaN(v)) return { line, error: `Número inválido em ${k}.` };
    if (Number.isNaN(entryAt) || Number.isNaN(exitAt)) return { line, error: 'Data inválida (use dd/mm/aaaa).' };
    if (exitPrice !== undefined && exitAt === undefined) return { line, error: 'Preço de saída sem data de saída.' };
    return {
      line,
      trade: {
        ticker,
        account: 'real' as const,
        side,
        qty: qty!,
        entryPrice: entryPrice!,
        entryAt,
        exitPrice,
        exitAt,
        stop: nums.stop,
        target: nums.target,
        fees: nums.fees ?? 0,
        strategy: get('estrategia') ?? '',
        reason: get('motivo') ?? '',
      },
    };
  });
}

/** Exporta no mesmo formato da importação (abre no Excel em português). */
export function tradesToCsv(trades: Trade[]): string {
  const n = (v?: number) => (v === undefined ? '' : String(v).replace('.', ','));
  const d = (t?: number) => (t === undefined ? '' : new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(t).replace(',', ''));
  const q = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = trades.map((t) => [d(t.entryAt), t.label, t.side === 'long' ? 'compra' : 'venda', n(t.qty), n(t.entryPrice), n(t.exitPrice), d(t.exitAt), n(t.stop), n(t.target), n(t.fees), q(t.strategy), q(t.reason)].join(';'));
  return [CSV_COLUMNS.join(';'), ...rows].join('\r\n');
}
