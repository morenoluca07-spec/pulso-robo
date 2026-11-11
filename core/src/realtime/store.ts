import type { Quote, SourceHealth } from '../types';

type Listener = () => void;
export type Scheduler = (cb: () => void) => void;

/** Na interface usa requestAnimationFrame; nos testes, imediato. */
const defaultScheduler: Scheduler = typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(() => cb()) : (cb) => setTimeout(cb, 16);

/**
 * Loja de cotações. Recebe milhares de atualizações por segundo e
 * entrega no máximo uma rodada por quadro de animação aos ouvintes (seção 7).
 */
export class QuoteStore {
  private quotes = new Map<string, Quote>();
  private prev = new Map<string, number>();
  private pending = new Map<string, Quote>();
  private scheduled = false;
  private byId = new Map<string, Set<Listener>>();
  private any = new Set<Listener>();
  private healthMap = new Map<string, SourceHealth>();
  private healthListeners = new Set<Listener>();
  /** Incrementa a cada rodada aplicada; útil para memoização na interface. */
  version = 0;

  constructor(private readonly schedule: Scheduler = defaultScheduler) {}

  /** Total de cotações recebidas desde o início (alimenta o traço do pulso). */
  ingested = 0;

  push(batch: Quote[]): void {
    this.ingested += batch.length;
    for (const q of batch) {
      const cur = this.pending.get(q.assetId) ?? this.quotes.get(q.assetId);
      // Nunca troca um dado mais novo por um mais velho (ex.: reserva atrasada).
      if (cur && cur.sourceTime > q.sourceTime && cur.source !== q.source && cur.delivery === 'stream') continue;
      this.pending.set(q.assetId, q);
    }
    if (!this.scheduled && this.pending.size) {
      this.scheduled = true;
      this.schedule(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    const changed = this.pending;
    this.pending = new Map();
    for (const [id, q] of changed) {
      const old = this.quotes.get(id);
      if (old) this.prev.set(id, old.price);
      this.quotes.set(id, q);
    }
    this.version++;
    for (const id of changed.keys()) this.byId.get(id)?.forEach((l) => l());
    this.any.forEach((l) => l());
  }

  get(id: string): Quote | undefined {
    return this.quotes.get(id);
  }

  /** Preço anterior, para o piscar verde/vermelho. */
  previous(id: string): number | undefined {
    return this.prev.get(id);
  }

  all(): Quote[] {
    return [...this.quotes.values()];
  }

  size(): number {
    return this.quotes.size;
  }

  subscribe(id: string, l: Listener): () => void {
    let s = this.byId.get(id);
    if (!s) this.byId.set(id, (s = new Set()));
    s.add(l);
    return () => s!.delete(l);
  }

  subscribeAll(l: Listener): () => void {
    this.any.add(l);
    return () => this.any.delete(l);
  }

  setHealth(h: SourceHealth): void {
    this.healthMap.set(h.source, h);
    this.healthListeners.forEach((l) => l());
  }

  health(): SourceHealth[] {
    return [...this.healthMap.values()];
  }

  subscribeHealth(l: Listener): () => void {
    this.healthListeners.add(l);
    return () => this.healthListeners.delete(l);
  }
}
