import { getText } from '../http';
import type { Asset } from '../types';

/**
 * Lista pública de todos os papéis negociados nos EUA (Nasdaq Trader, arquivos diários).
 * nasdaqlisted.txt = Nasdaq; otherlisted.txt = NYSE, NYSE American, Arca, Cboe.
 * Só a lista: cotações vêm do Yahoo (atraso ~2 min) ou da Finnhub (ao vivo, com chave).
 */
const BASE = 'https://www.nasdaqtrader.com/dynamic/SymDir';
export const usId = (sym: string) => `us:${sym}`;

const EXCH: Record<string, string> = { N: 'NYSE', A: 'NYSE American', P: 'NYSE Arca', Z: 'Cboe BZX', V: 'IEX' };

function parse(txt: string, nasdaq: boolean): Asset[] {
  const lines = txt.trim().split(/\r?\n/);
  const head = lines[0].split('|');
  const ix = (n: string) => head.indexOf(n);
  const iSym = nasdaq ? ix('Symbol') : ix('ACT Symbol');
  const iName = ix('Security Name');
  const iEtf = ix('ETF');
  const iTest = ix('Test Issue');
  const iEx = ix('Exchange');
  const out: Asset[] = [];
  for (const l of lines.slice(1)) {
    if (l.startsWith('File Creation Time')) continue;
    const c = l.split('|');
    if (c[iTest] === 'Y') continue;
    const sym = c[iSym];
    if (!sym || /[$.]/.test(sym)) continue; // classes preferenciais/unidades com notação própria ficam de fora
    out.push({
      id: usId(sym),
      symbol: sym,
      name: c[iName].replace(/ - (Common Stock|Class [A-Z] Common Stock|Ordinary Shares).*$/i, '').trim(),
      cls: 'us',
      kind: c[iEtf] === 'Y' ? 'etf' : 'ação',
      quote: 'USD',
      ref: sym,
      meta: { exchange: nasdaq ? 'Nasdaq' : (EXCH[c[iEx]] ?? c[iEx]) },
    });
  }
  return out;
}

export function parseSymbolFiles(nasdaqTxt: string, otherTxt: string): Asset[] {
  const seen = new Set<string>();
  return [...parse(nasdaqTxt, true), ...parse(otherTxt, false)].filter((a) => !seen.has(a.id) && seen.add(a.id));
}

export const nasdaq = {
  async all(): Promise<Asset[]> {
    const [a, b] = await Promise.all([getText(`${BASE}/nasdaqlisted.txt`), getText(`${BASE}/otherlisted.txt`)]);
    return parseSymbolFiles(a, b);
  },
};
