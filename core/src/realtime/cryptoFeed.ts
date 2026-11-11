import { BinanceAdapter } from '../sources/binance';
import { BybitAdapter } from '../sources/bybit';
import type { Asset, SourceHealth } from '../types';
import type { QuoteStore } from './store';

export interface CryptoFeedState {
  assets: Asset[];
  primary: 'binance' | 'bybit';
  error?: string;
}

/**
 * Cripto de ponta a ponta: lista todos os pares, carrega o retrato inicial,
 * abre o fluxo do mercado inteiro e troca para a Bybit se a Binance cair.
 */
export class CryptoFeed {
  readonly binance = new BinanceAdapter();
  readonly bybit = new BybitAdapter();
  state: CryptoFeedState = { assets: [], primary: 'binance' };
  private stops: (() => void)[] = [];
  private fallbackTimer?: ReturnType<typeof setInterval>;
  private downSince?: number;
  private listeners = new Set<() => void>();

  constructor(private readonly store: QuoteStore) {}

  onState(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  async start(): Promise<void> {
    try {
      await this.binance.syncClock().catch(() => undefined);
      const [assets, snapshot] = await Promise.all([this.binance.listAssets(), this.binance.quotes()]);
      const active = new Set(assets.map((a) => a.id));
      this.state = { assets, primary: 'binance' };
      this.store.push(snapshot.filter((q) => active.has(q.assetId)));
      this.emit();
    } catch (e) {
      this.state = { ...this.state, error: `Binance indisponível: ${(e as Error).message}` };
      this.emit();
      await this.startFallback();
    }
    this.stops.push(this.binance.stream((q) => this.store.push(q), (h) => this.onBinanceHealth(h)));
  }

  private onBinanceHealth(h: SourceHealth): void {
    this.store.setHealth(h);
    if (h.state === 'ok') {
      this.downSince = undefined;
      if (this.state.primary !== 'binance') {
        this.stopFallback();
        this.state = { ...this.state, primary: 'binance', error: undefined };
        this.emit();
      }
      return;
    }
    this.downSince ??= Date.now();
    // 20 s sem a Binance: a reserva assume (o selo mostra a fonte nova).
    if (Date.now() - this.downSince > 20_000 && this.state.primary === 'binance') void this.startFallback();
  }

  private async startFallback(): Promise<void> {
    if (this.fallbackTimer) return;
    this.state = { ...this.state, primary: 'bybit' };
    this.emit();
    const tick = async () => {
      try {
        const qs = await this.bybit.quotes();
        this.store.push(qs);
        this.store.setHealth({ source: 'Bybit', state: 'ok', messages: qs.length, reconnects: 0, lastMessageAt: Date.now() });
        if (!this.state.assets.length) {
          this.state = { ...this.state, assets: await this.bybit.listAssets(), error: undefined };
          this.emit();
        }
      } catch (e) {
        this.store.setHealth({ source: 'Bybit', state: 'down', messages: 0, reconnects: 0, lastError: (e as Error).message });
      }
    };
    await tick();
    this.fallbackTimer = setInterval(tick, 3_000);
  }

  private stopFallback(): void {
    clearInterval(this.fallbackTimer);
    this.fallbackTimer = undefined;
  }

  /** Pausa (app em segundo plano no celular) e retoma depois. */
  stop(): void {
    this.stops.forEach((s) => s());
    this.stops = [];
    this.stopFallback();
  }
}
