/** Formatação de números em pt-BR com casas decimais adequadas ao tamanho do preço. */

export function priceDigits(p: number): number {
  const a = Math.abs(p);
  if (a === 0) return 2;
  if (a >= 1000) return 2;
  if (a >= 1) return a >= 100 ? 2 : 4;
  // Memecoins: mostra ao menos 4 algarismos significativos.
  return Math.min(12, Math.max(4, -Math.floor(Math.log10(a)) + 3));
}

const cache = new Map<number, Intl.NumberFormat>();
export function fmtPrice(p: number): string {
  const d = priceDigits(p);
  let f = cache.get(d);
  if (!f) cache.set(d, (f = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })));
  return f.format(p);
}

const pct = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'always' });
/** "+1,23%" / "−0,45%" com sinal explícito (segundo sinal além da cor, seção 10). */
export function fmtPct(v: number): string {
  return `${pct.format(v).replace('-', '−')}%`;
}

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
export function fmtCompact(v: number): string {
  return compact.format(v);
}
