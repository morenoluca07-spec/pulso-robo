import { bcb, SERIES, type SgsPoint } from '../sources/bcb';
import { b3Open, brapi } from '../sources/brapi';
import { geckoterminal, MEME_NETWORKS } from '../sources/geckoterminal';
import { nasdaq } from '../sources/nasdaq';
import { WORLD, worldId, yahoo } from '../sources/yahoo';
import type { Asset, AssetClass, Quote, SourceHealth } from '../types';
import type { QuoteStore } from './store';

type Health = Pick<SourceHealth, 'source'> & Partial<SourceHealth>;

/** Fila com limite de concorrência e validade por item (cotação sob demanda das linhas visíveis). */
class OnDemand {
  private inflight = new Set<string>();
  private fetchedAt = new Map<string, number>();
  private queue: Asset[] = [];
  private running = 0;
  constructor(
    private readonly fetchOne: (a: Asset) => Promise<Quote>,
    private readonly push: (q: Quote) => void,
    private readonly report: (ok: boolean, err?: string) => void,
    private readonly ttlMs = 60_000,
    private readonly concurrency = 4,
  ) {}

  want(assets: Asset[]): void {
    const now = Date.now();
    for (const a of assets) {
      if (this.inflight.has(a.id)) continue;
      if (now - (this.fetchedAt.get(a.id) ?? 0) < this.ttlMs) continue;
      this.inflight.add(a.id);
      this.queue.push(a);
    }
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const a = this.queue.shift()!;
      this.running++;
      this.fetchOne(a)
        .then((q) => {
          this.push(q);
          this.report(true);
        })
        .catch((e: Error) => this.report(false, `${a.symbol}: ${e.message}`))
        .finally(() => {
          this.fetchedAt.set(a.id, Date.now());
          this.inflight.delete(a.id);
          this.running--;
          this.pump();
        });
    }
  }
}

/**
 * Mercados da Fase 2: B3 e FIIs (brapi), EUA (lista Nasdaq + Yahoo sob demanda),
 * Mundo (Yahoo em ciclo), Memecoins (GeckoTerminal em ciclo) e Selic (Banco Central).
 */
export class MarketsFeed {
  readonly assets = new Map<AssetClass, Asset[]>();
  readonly byId = new Map<string, Asset>();
  readonly errors = new Map<AssetClass, string>();
  selic?: SgsPoint & { fetchedAt: number };
  private listeners = new Set<() => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private healthState = new Map<string, SourceHealth>();
  readonly yahooOnDemand: OnDemand;

  constructor(private readonly store: QuoteStore) {
    this.yahooOnDemand = new OnDemand(
      (a) => yahoo.quote(a.ref ?? a.symbol, a.id),
      (q) => this.store.push([q]),
      (ok, err) => this.health({ source: 'Yahoo', state: ok ? 'ok' : 'degraded', lastError: err }, ok ? 1 : 0),
    );
    for (const w of WORLD) this.addAsset({ id: worldId(w.ref), symbol: w.ref, name: w.name, cls: 'world', quote: '', kind: w.group, ref: w.ref });
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  private addAsset(a: Asset): void {
    this.byId.set(a.id, a);
    const list = this.assets.get(a.cls) ?? [];
    list.push(a);
    this.assets.set(a.cls, list);
  }
  private setClass(cls: AssetClass, list: Asset[]): void {
    for (const a of this.assets.get(cls) ?? []) this.byId.delete(a.id);
    this.assets.set(cls, list);
    for (const a of list) this.byId.set(a.id, a);
  }

  private health(h: Health, newMessages = 1): void {
    const cur = this.healthState.get(h.source) ?? { source: h.source, state: 'idle', messages: 0, reconnects: 0 };
    const next: SourceHealth = {
      ...cur,
      ...h,
      messages: cur.messages + newMessages,
      lastMessageAt: h.state === 'ok' ? Date.now() : cur.lastMessageAt,
      lastError: h.state === 'ok' ? cur.lastError : (h.lastError ?? cur.lastError),
    };
    this.healthState.set(h.source, next);
    this.store.setHealth(next);
  }

  async start(): Promise<void> {
    this.stop(); // evita ciclos duplicados ao voltar do segundo plano
    await Promise.allSettled([this.loadB3(), this.assets.get('us')?.length ? Promise.resolve() : this.loadUS(), this.loadWorld(), this.loadMeme(), this.loadSelic()]);
    // Ciclos respeitando os limites medidos na Fase 0.
    this.timers.push(setInterval(() => void this.loadB3(), b3Open() ? 5 * 60_000 : 30 * 60_000)); // ~192 req/dia
    this.timers.push(setInterval(() => void this.loadWorld(), 60_000));
    this.timers.push(setInterval(() => void this.loadMeme(), 90_000)); // 4 req a cada 90 s, espaçadas
    this.timers.push(setInterval(() => void this.loadSelic(), 3600_000));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  async loadB3(): Promise<void> {
    try {
      const { assets, quotes } = await brapi.all();
      this.setClass('br', assets.filter((a) => a.cls === 'br'));
      this.setClass('fii', assets.filter((a) => a.cls === 'fii'));
      this.store.push(quotes);
      this.errors.delete('br');
      this.errors.delete('fii');
      this.health({ source: 'brapi', state: 'ok' }, 2);
    } catch (e) {
      const msg = (e as Error).message;
      this.errors.set('br', msg);
      this.errors.set('fii', msg);
      this.health({ source: 'brapi', state: 'down', lastError: msg }, 0);
    }
    this.emit();
  }

  async loadUS(): Promise<void> {
    try {
      this.setClass('us', await nasdaq.all());
      this.errors.delete('us');
      this.health({ source: 'Nasdaq Trader (lista EUA)', state: 'ok' }, 2);
    } catch (e) {
      this.errors.set('us', (e as Error).message);
      this.health({ source: 'Nasdaq Trader (lista EUA)', state: 'down', lastError: (e as Error).message }, 0);
    }
    this.emit();
  }

  async loadWorld(): Promise<void> {
    this.yahooOnDemand.want(this.assets.get('world') ?? []);
  }

  private memeBackoffUntil = 0;

  async loadMeme(): Promise<void> {
    if (Date.now() < this.memeBackoffUntil) return;
    // Uma rede por vez, com intervalo: o limite gratuito da GeckoTerminal é apertado.
    const res: PromiseSettledResult<Awaited<ReturnType<typeof geckoterminal.trending>>>[] = [];
    for (const n of MEME_NETWORKS) {
      res.push(await geckoterminal.trending(n.id).then((value) => ({ status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason })));
      await new Promise((r) => setTimeout(r, 2500));
    }
    // Recusa por excesso de pedidos (429): espera 5 minutos antes de tentar de novo.
    if (res.some((r) => r.status === 'rejected' && /HTTP 429/.test(String((r.reason as Error).message)))) this.memeBackoffUntil = Date.now() + 5 * 60_000;
    const list: Asset[] = [];
    const quotes: Quote[] = [];
    const errs: string[] = [];
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        list.push(...r.value.assets);
        quotes.push(...r.value.quotes);
      } else errs.push(`${MEME_NETWORKS[i].label}: ${(r.reason as Error).message}`);
    });
    const prev = this.assets.get('meme') ?? [];
    if (list.length) {
      // Rede que falhou mantém os pools anteriores (com o selo de idade da última consulta).
      const failed = new Set<string>(MEME_NETWORKS.filter((_, i) => res[i].status === 'rejected').map((n) => n.id));
      this.setClass('meme', [...list, ...prev.filter((a) => failed.has(String(a.meta?.network)))]);
      this.store.push(quotes);
      this.errors.delete('meme');
    } else this.errors.set('meme', errs.join('; '));
    this.health({ source: 'GeckoTerminal', state: errs.length === 0 ? 'ok' : list.length || prev.length ? 'degraded' : 'down', lastError: errs[0] }, res.length - errs.length);
    this.emit();
  }

  async loadSelic(): Promise<void> {
    try {
      const p = await bcb.last(SERIES.selicMeta);
      if (p) this.selic = { ...p, fetchedAt: Date.now() };
      this.health({ source: 'Banco Central', state: 'ok' });
    } catch (e) {
      this.health({ source: 'Banco Central', state: 'down', lastError: (e as Error).message }, 0);
    }
    this.emit();
  }

  /** Linhas visíveis pedem cotação (EUA sempre; B3 sem lista da brapi). */
  wantQuotes(assets: Asset[]): void {
    const need = assets.filter((a) => a.cls === 'us' || a.cls === 'world' || ((a.cls === 'br' || a.cls === 'fii') && !this.store.get(a.id)));
    if (need.length) this.yahooOnDemand.want(need);
  }

  all(): Asset[] {
    return [...this.byId.values()];
  }
}
