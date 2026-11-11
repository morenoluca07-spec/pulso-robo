/**
 * Diferença entre o relógio da fonte e o relógio local.
 * Na Fase 0 o PC estava ~2,4 s atrasado; sem esta correção o selo "AO VIVO" mentiria.
 * Mantém a mediana das últimas amostras de (horário do servidor − horário local).
 */
export class ClockOffset {
  private samples: number[] = [];
  constructor(private readonly max = 50) {}

  /** `serverTime` e `localTime` em ms. Use o meio da requisição como `localTime`. */
  add(serverTime: number, localTime: number): void {
    this.samples.push(serverTime - localTime);
    if (this.samples.length > this.max) this.samples.shift();
  }

  /** Offset em ms (positivo = servidor adiantado em relação ao PC). */
  get offset(): number {
    if (!this.samples.length) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /** Converte um horário da fonte para o relógio local. */
  toLocal(serverTime: number): number {
    return serverTime - this.offset;
  }
}
