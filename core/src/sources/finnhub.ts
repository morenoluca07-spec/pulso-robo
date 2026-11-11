import { ReconnectingSocket } from '../realtime/socket';
import type { Quote, SourceHealth } from '../types';
import { usId } from './nasdaq';

/**
 * Finnhub: negócios em tempo real das ações dos EUA por WebSocket (plano grátis: até 50 símbolos, exige chave).
 * Formato documentado: {"type":"trade","data":[{"s":"AAPL","p":189.5,"t":1700000000000,"v":100}]}.
 * A chave fica no cofre do sistema; o app só a lê na hora de conectar.
 */
export const FINNHUB_MAX_SYMBOLS = 50;

export interface FinnhubTrade {
  s: string;
  p: number;
  t: number;
  v: number;
}

/** Último negócio de cada símbolo na mensagem. A variação do dia usa o fechamento anterior que já está na tela. */
export function parseFinnhub(msg: { type?: string; data?: FinnhubTrade[] }, prevClose: (sym: string) => number | undefined, receivedAt: number): Quote[] {
  if (msg.type !== 'trade' || !msg.data?.length) return [];
  const last = new Map<string, FinnhubTrade>();
  for (const t of msg.data) if (!last.has(t.s) || last.get(t.s)!.t <= t.t) last.set(t.s, t);
  return [...last.values()].map((t) => {
    const pc = prevClose(t.s);
    return {
      assetId: usId(t.s),
      price: t.p,
      previousClose: pc,
      changePct: pc ? ((t.p - pc) / pc) * 100 : undefined,
      sourceTime: t.t,
      receivedAt,
      source: 'Finnhub',
      delivery: 'stream' as const,
    };
  });
}

export function finnhubStream(token: string, symbols: string[], prevClose: (sym: string) => number | undefined, onQuotes: (q: Quote[]) => void, onHealth: (h: SourceHealth) => void): () => void {
  const subs = symbols.slice(0, FINNHUB_MAX_SYMBOLS);
  const sock: ReconnectingSocket = new ReconnectingSocket({
    source: 'Finnhub (EUA ao vivo)',
    url: `wss://ws.finnhub.io?token=${encodeURIComponent(token)}`,
    silenceMs: 90_000, // fora do pregão americano não há negócios
    onOpenSend: () => subs.map((s) => ({ type: 'subscribe', symbol: s })),
    onHealth,
    onMessage: (d) => {
      const now = Date.now();
      const qs = parseFinnhub(d as { type?: string; data?: FinnhubTrade[] }, prevClose, now);
      if (qs.length) {
        sock.recordLatency(now - qs[0].sourceTime);
        onQuotes(qs);
      }
    },
  });
  return () => sock.close();
}
