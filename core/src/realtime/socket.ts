import type { HealthState, SourceHealth } from '../types';

export interface SocketOptions {
  source: string;
  url: string;
  /** Mensagens enviadas a cada (re)conexão: retomada das assinaturas. */
  onOpenSend?: () => unknown[];
  onMessage: (data: unknown) => void;
  onHealth: (h: SourceHealth) => void;
  /** Sem mensagem por este tempo = conexão considerada travada e reaberta. */
  silenceMs?: number;
  /** Ping de aplicação (alguns servidores exigem). */
  ping?: { everyMs: number; payload: unknown };
  /** Construtor de WebSocket injetável (testes). */
  WS?: typeof WebSocket;
}

/**
 * WebSocket permanente: reconexão automática com espera crescente (1 s → 30 s),
 * retomada das assinaturas e relatório de saúde a cada mudança.
 */
export class ReconnectingSocket {
  private ws?: WebSocket;
  private attempt = 0;
  private closed = false;
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  readonly health: SourceHealth;
  private latencies: number[] = [];

  constructor(private readonly o: SocketOptions) {
    this.health = { source: o.source, state: 'idle', messages: 0, reconnects: 0 };
    this.open();
  }

  /** Registra latência (ms) de um evento cujo horário a fonte informou. */
  recordLatency(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.latencies.push(ms);
    if (this.latencies.length > 200) this.latencies.shift();
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.silenceTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.set('idle');
  }

  private lastEmit = 0;

  private set(state: HealthState, err?: string): void {
    this.lastEmit = Date.now();
    this.health.state = state;
    if (err) this.health.lastError = err;
    if (this.latencies.length) {
      const s = [...this.latencies].sort((a, b) => a - b);
      this.health.latencyMs = Math.round(s[Math.floor(s.length / 2)]);
    }
    this.o.onHealth({ ...this.health });
  }

  private open(): void {
    if (this.closed) return;
    const WS = this.o.WS ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new WS(this.o.url);
    } catch (e) {
      this.retry(`Não abriu: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      for (const m of this.o.onOpenSend?.() ?? []) ws.send(JSON.stringify(m));
      if (this.o.ping) {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send(this.o.ping!.payload), this.o.ping.everyMs);
      }
      this.armSilence();
      this.set('ok');
    };
    ws.onmessage = (ev) => {
      this.health.messages++;
      this.health.lastMessageAt = Date.now();
      this.armSilence();
      if (this.health.state !== 'ok') this.set('ok');
      let data: unknown;
      try {
        data = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      this.o.onMessage(data);
      // Saúde com latência atualizada no máximo a cada 2 s, sem inundar a interface.
      if (Date.now() - this.lastEmit >= 2_000) this.set('ok');
    };
    ws.onerror = () => {
      /* o motivo chega em onclose */
    };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      if (this.closed) return;
      this.retry(`Conexão fechada (código ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`);
    };
  }

  private armSilence(): void {
    clearTimeout(this.silenceTimer);
    const ms = this.o.silenceMs ?? 15_000;
    this.silenceTimer = setTimeout(() => {
      this.set('degraded', `Sem dados há ${ms / 1000} s; reconectando`);
      this.ws?.close();
    }, ms);
  }

  private retry(reason: string): void {
    clearTimeout(this.silenceTimer);
    this.health.reconnects++;
    const wait = Math.min(30_000, 1_000 * 2 ** this.attempt++);
    this.set(this.attempt > 3 ? 'down' : 'degraded', `${reason}. Nova tentativa em ${Math.round(wait / 1000)} s`);
    this.retryTimer = setTimeout(() => this.open(), wait);
  }
}
