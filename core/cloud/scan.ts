/**
 * Robô da nuvem: a mesma varredura de Sinais do app, sem tela, para rodar no GitHub Actions
 * e publicar `melhores.json` no GitHub Pages. O celular lê esse arquivo e mostra os Melhores
 * mesmo com o PC desligado. Uso: npx tsx cloud/scan.ts <pasta de saída>
 *
 * Contexto que exige arquivos grandes ou leitura de PDF (fundos da CVM, Hyperliquid, Congresso) fica no app do PC.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchFiiFundamentals12m } from '../src/br/fiiCvm';
import { fetchUsCompanies } from '../src/invest/longTerm';
import { RANK_UNIVERSE, type RankClass } from '../src/signals/rank';
import { buildScanItem, STABLE_BASES, type CloudBest, type ScanItem } from '../src/signals/scan';
import { computeSignal } from '../src/signals/run';
import { derivativesFactor, fetchDerivatives } from '../src/signals/context';
import { BinanceAdapter } from '../src/sources/binance';
import { brapi } from '../src/sources/brapi';
import { getJson, setFetch } from '../src/http';
import { yahoo } from '../src/sources/yahoo';
import type { Asset, Candle } from '../src/types';
import type { Factor } from '../src/signals/signal';

const out = process.argv[2] ?? 'cloud-out';
// Os servidores do GitHub ficam nos EUA, e a api.binance.com responde 451 para lá. O espelho oficial só de dados
// públicos de mercado (data-api.binance.vision) tem os mesmos caminhos. Derivativos (fapi) seguem bloqueados: o fator fica de fora.
setFetch((u, init) => fetch(u.replace('https://api.binance.com/', 'https://data-api.binance.vision/'), init));
const binance = new BinanceAdapter();

async function universe(): Promise<Record<RankClass, Asset[]>> {
  const t24 = await getJson<{ symbol: string; quoteVolume: string }[]>('https://api.binance.com/api/v3/ticker/24hr').catch((e: Error) => {
    console.log('Binance:', e.message);
    return [];
  });
  const crypto = t24
    .filter((t) => t.symbol.endsWith('USDT') && !STABLE_BASES.test(t.symbol.slice(0, -4)))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, RANK_UNIVERSE.crypto)
    .map((t): Asset => ({ id: `crypto:${t.symbol}`, symbol: t.symbol, name: t.symbol.slice(0, -4), cls: 'crypto', base: t.symbol.slice(0, -4), quote: 'USDT', ref: t.symbol }));
  const b3 = await brapi.all().catch((e: Error) => (console.log('brapi:', e.message), { assets: [] as Asset[], quotes: [] as { assetId: string; volume?: number; price: number }[] }));
  const vol = new Map(b3.quotes.map((q) => [q.assetId, (q.volume ?? 0) * q.price]));
  const byVol = (l: Asset[], n: number) => l.sort((a, b) => (vol.get(b.id) ?? 0) - (vol.get(a.id) ?? 0)).slice(0, n);
  const br = byVol(b3.assets.filter((a) => a.cls === 'br' && a.kind === 'ação'), RANK_UNIVERSE.br);
  const fii = byVol(b3.assets.filter((a) => a.cls === 'fii' && a.kind === 'fii'), RANK_UNIVERSE.fii);
  const us = (await fetchUsCompanies().catch((e: Error) => (console.log('Nasdaq:', e.message), []))).slice(0, RANK_UNIVERSE.us).map((c): Asset => ({ id: `us:${c.symbol}`, symbol: c.symbol, name: c.name, cls: 'us', kind: 'ação', quote: 'USD', ref: c.symbol, meta: { sector: c.sector } }));
  return { crypto, br, fii, us };
}

async function history(a: Asset): Promise<{ candles: Candle[]; source: string }> {
  if (a.cls === 'crypto') return { candles: await binance.historyLong(a.id, '1d'), source: 'Binance' };
  return { candles: await yahoo.history(a.ref ?? a.symbol, '1d', true), source: 'Yahoo (preço ajustado por proventos)' };
}

async function scanClass(cls: RankClass, list: Asset[]) {
  const items: ScanItem[] = [];
  const errors: string[] = [];
  let k = 0;
  const worker = async () => {
    while (k < list.length) {
      const a = list[k++];
      try {
        const { candles, source } = await history(a);
        const ctx: Factor[] = [];
        if (cls === 'crypto') {
          const d = await fetchDerivatives(a.symbol);
          if (d) ctx.push(derivativesFactor(d));
        }
        const sig = computeSignal(a, candles, source, ctx);
        if (sig) items.push(buildScanItem(a, cls, sig, candles.map((c) => c.close)));
      } catch (e) {
        errors.push(`${a.symbol}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { at: Date.now(), total: list.length, items, errors, assets: list };
}

const t0 = Date.now();
const uni = await universe();
const result: CloudBest = { v: 1, generatedAt: 0, classes: {}, fii: [] };
for (const cls of Object.keys(uni) as RankClass[]) {
  result.classes[cls] = await scanClass(cls, uni[cls]);
  console.log(`${cls}: ${result.classes[cls]!.items.length}/${uni[cls].length} (${result.classes[cls]!.errors.length} erros)`);
}
try {
  const { data, updated } = await fetchFiiFundamentals12m();
  const want = new Set(uni.fii.map((a) => a.symbol));
  result.fii = [...data.entries()].filter(([t]) => want.has(t));
  result.fiiUpdated = updated;
} catch (e) {
  console.log('CVM (FIIs):', (e as Error).message);
}
result.generatedAt = Date.now();
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/melhores.json`, JSON.stringify(result));
writeFileSync(`${out}/index.html`, `<!doctype html><meta charset="utf-8"><title>Pulso</title><p>Arquivo de dados do app Pulso: <a href="melhores.json">melhores.json</a>, gerado em ${new Date(result.generatedAt).toISOString()}.</p>`);
console.log(`pronto em ${Math.round((Date.now() - t0) / 1000)} s`);
