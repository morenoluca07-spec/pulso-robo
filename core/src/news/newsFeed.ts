import type { Asset, AssetClass, SourceHealth } from '../types';
import { buildIndex, dedupeKey, norm, relatedAssets, tagNews, type AssetIndex, type NewsTag } from './classify';
import { FEEDS, fetchCopom, fetchCvmFacts, fetchFeed, yahooFeedUrl, type CvmDoc } from './sources';
import type { RawItem } from './rss';

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  source: string;
  /** Horário de publicação (ms). Se a fonte só dá o dia, `dateOnly` = true. */
  time: number;
  dateOnly?: boolean;
  tags: NewsTag[];
  assets: string[];
  cls: AssetClass | 'macro';
  /** Fatos relevantes e comunicados oficiais valem mais que manchete. */
  official: boolean;
  firstSeen: number;
}

const MAX_ITEMS = 600;
const MAX_AGE_MS = 7 * 86_400_000;

/**
 * Feed único de notícias: RSS confirmados, Copom, fatos relevantes da CVM e Yahoo por ativo.
 * Sem repetição (mesma manchete em dois feeds vira um item). Sem copiar a matéria: título, fonte, horário, link.
 */
export class NewsFeed {
  private items = new Map<string, NewsItem>();
  private index: AssetIndex = { bySymbol: new Map(), byName: [] };
  private listeners = new Set<(fresh: NewsItem[]) => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private cvmNames: [string, string][] = [];
  cvmUpdated?: string;
  watch: Asset[] = [];

  constructor(
    private readonly onHealth: (h: SourceHealth) => void,
    private readonly seen: { load(): string[]; save(keys: string[]): void } = { load: () => [], save: () => undefined },
  ) {}

  setAssets(all: Asset[]): void {
    this.index = buildIndex(all);
    this.cvmNames = all.filter((a) => a.cls === 'br' && a.kind === 'ação').map((a) => [companyKey(a.name), a.id]);
  }

  onNews(l: (fresh: NewsItem[]) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  list(): NewsItem[] {
    return [...this.items.values()].sort((a, b) => b.time - a.time);
  }

  private add(raw: RawItem[], source: string, cls: NewsItem['cls'], official = false, hint?: string, dateOnly = false): NewsItem[] {
    const fresh: NewsItem[] = [];
    const now = Date.now();
    for (const r of raw) {
      const time = Number.isFinite(r.time) ? Math.min(r.time, now) : now;
      if (now - time > MAX_AGE_MS) continue;
      const key = dedupeKey(r.title);
      const cur = this.items.get(key);
      if (cur) {
        // Mesmo assunto de outra fonte: só junta os ativos, não repete o item.
        if (hint && !cur.assets.includes(hint)) cur.assets.push(hint);
        continue;
      }
      const item: NewsItem = {
        id: key,
        title: r.title,
        link: r.link,
        source,
        time,
        dateOnly,
        tags: official ? ['oficial', ...tagNews(r.title, r.summary)] : tagNews(r.title, r.summary),
        assets: relatedAssets(r.title, this.index, hint),
        cls,
        official,
        firstSeen: now,
      };
      this.items.set(key, item);
      fresh.push(item);
    }
    if (this.items.size > MAX_ITEMS) {
      for (const it of this.list().slice(MAX_ITEMS)) this.items.delete(it.id);
    }
    return fresh;
  }

  private emit(fresh: NewsItem[], initial: boolean): void {
    // Na primeira carga nada vira "novo" para alertas: só o que chega depois.
    const seen = new Set(this.seen.load());
    const novel = initial ? [] : fresh.filter((f) => !seen.has(f.id));
    if (fresh.length) this.seen.save([...seen, ...fresh.map((f) => f.id)].slice(-2000));
    this.listeners.forEach((l) => l(novel));
  }

  private health(source: string, ok: boolean, n: number, err?: string): void {
    this.onHealth({ source, state: ok ? 'ok' : 'down', messages: n, reconnects: 0, lastMessageAt: ok ? Date.now() : undefined, lastError: err });
  }

  async pollFeeds(initial = false): Promise<void> {
    const res = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f.url)));
    const fresh: NewsItem[] = [];
    let ok = 0;
    const errs: string[] = [];
    res.forEach((r, i) => {
      const f = FEEDS[i];
      if (r.status === 'fulfilled') {
        ok++;
        fresh.push(...this.add(r.value, f.name, f.cls === 'us' ? 'macro' : (f.cls as AssetClass), 'official' in f && f.official));
      } else errs.push(`${f.name}: ${(r.reason as Error).message}`);
    });
    try {
      fresh.push(...this.add(await fetchCopom(), 'Banco Central (Copom)', 'macro', true));
      ok++;
    } catch (e) {
      errs.push(`Copom: ${(e as Error).message}`);
    }
    this.onHealth({ source: 'Notícias (RSS)', state: errs.length === 0 ? 'ok' : ok ? 'degraded' : 'down', messages: ok, reconnects: 0, lastMessageAt: Date.now(), lastError: errs[0] });
    this.emit(fresh, initial);
  }

  /** Notícias por ativo no Yahoo (EUA e cripto da lista de acompanhamento). */
  async pollWatch(initial = false): Promise<void> {
    const targets = this.watch.filter((a) => a.cls === 'us' || a.cls === 'crypto' || a.cls === 'br' || a.cls === 'fii').slice(0, 20);
    const fresh: NewsItem[] = [];
    for (const a of targets) {
      const sym = a.cls === 'crypto' ? `${a.base}-USD` : (a.ref ?? a.symbol);
      try {
        fresh.push(...this.add(await fetchFeed(yahooFeedUrl(sym)), 'Yahoo Finance', a.cls, false, a.id));
      } catch {
        /* sem notícias para este símbolo: segue */
      }
    }
    this.emit(fresh, initial);
  }

  async pollCvm(initial = false): Promise<void> {
    try {
      const { docs, updated } = await fetchCvmFacts();
      this.cvmUpdated = updated;
      this.emit(this.add(docs.slice(0, 200).map((d) => cvmToRaw(d)), 'CVM (fato relevante)', 'br', true, undefined, true).map((n) => this.linkCvm(n)), initial);
      this.health('CVM (fatos relevantes)', true, docs.length);
    } catch (e) {
      this.health('CVM (fatos relevantes)', false, 0, (e as Error).message);
    }
  }

  /** Liga o fato relevante à ação pela razão social (a CVM não informa o ticker). */
  private linkCvm(n: NewsItem): NewsItem {
    const company = companyKey(n.title.split(':')[0]);
    for (const [k, id] of this.cvmNames) if (k && company.startsWith(k)) n.assets = [...new Set([...n.assets, id])];
    return n;
  }

  async start(): Promise<void> {
    this.stop();
    await Promise.allSettled([this.pollFeeds(true), this.pollWatch(true), this.pollCvm(true)]);
    this.timers.push(setInterval(() => void this.pollFeeds(), 3 * 60_000));
    this.timers.push(setInterval(() => void this.pollWatch(), 10 * 60_000));
    this.timers.push(setInterval(() => void this.pollCvm(), 3 * 3600_000));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }
}

export function cvmToRaw(d: CvmDoc): RawItem {
  return { title: `${d.company}: ${d.subject}`, link: d.link, time: Date.parse(`${d.date}T12:00:00-03:00`), summary: '', categories: ['Fato Relevante'] };
}

/** Razão social reduzida para casar CVM e brapi (sem acento, sem S.A., só as 2 primeiras palavras). */
export function companyKey(name: string): string {
  return norm(name)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['sa', 's', 'a', 'cia', 'companhia', 'de', 'do', 'da'].includes(w))
    .slice(0, 2)
    .join(' ');
}
