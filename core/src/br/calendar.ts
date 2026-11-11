/**
 * Dias úteis no Brasil (feriados nacionais), base da contagem "du/252" usada pelo Tesouro e pelo CDI.
 * Nacionais fixos + móveis (Carnaval, Sexta-feira Santa, Corpus Christi). 20/11 é nacional desde 2024 (Lei 14.759/2023).
 */
function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

const cache = new Map<number, Set<string>>();
const key = (d: Date) => d.toISOString().slice(0, 10);

export function holidays(y: number): Set<string> {
  let s = cache.get(y);
  if (s) return s;
  const fixed = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];
  if (y >= 2024) fixed.push('11-20');
  s = new Set(fixed.map((md) => `${y}-${md}`));
  const e = easter(y).getTime();
  for (const off of [-48, -47, -2, 60]) s.add(key(new Date(e + off * 86_400_000))); // Carnaval (seg, ter), Sexta Santa, Corpus Christi
  cache.set(y, s);
  return s;
}

export function isBusinessDay(d: Date): boolean {
  const wd = d.getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays(d.getUTCFullYear()).has(key(d));
}

/** Dias úteis entre `from` (inclusive) e `to` (exclusive). Datas "aaaa-mm-dd". */
export function businessDays(from: string, to: string): number {
  let d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let n = 0;
  while (d < end) {
    if (isBusinessDay(d)) n++;
    d = new Date(d.getTime() + 86_400_000);
  }
  return n;
}

export function addBusinessDays(from: string, n: number): string {
  let d = new Date(`${from}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d = new Date(d.getTime() + 86_400_000);
    if (isBusinessDay(d)) left--;
  }
  return key(d);
}

/** "dd/mm/aaaa" → "aaaa-mm-dd". */
export const isoFromBr = (s: string) => {
  const [d, m, y] = s.split('/');
  return `${y}-${m}-${d}`;
};
