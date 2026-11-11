/**
 * "Copiar com meu orçamento": monta posições proporcionais ao valor informado, com colchão de caixa,
 * teto por ativo (o excesso é redistribuído) e ordem mínima. Lógica do trader-budget (MIT).
 * O resultado vai para a conta simulada, depois de passar pelas regras de risco.
 */
export interface CopyTarget {
  key: string; // assetId do Pulso
  label: string;
  /** Peso original na carteira copiada (qualquer escala). */
  weight: number;
}

export interface CopyLine extends CopyTarget {
  /** Peso final depois do teto (fração do valor investido). */
  finalWeight: number;
  amountBRL: number;
  capped: boolean;
}

export function sizeCopy(targets: CopyTarget[], budgetBRL: number, opts: { cashBufferPct: number; maxPositionPct: number; minOrderBRL: number }): { lines: CopyLine[]; cashBRL: number; dropped: CopyTarget[] } {
  const investable = budgetBRL * (1 - opts.cashBufferPct / 100);
  const cap = opts.maxPositionPct / 100 / (1 - opts.cashBufferPct / 100); // teto relativo ao total, convertido para a parte investida
  let pool = targets.filter((t) => t.weight > 0);
  const dropped: CopyTarget[] = [];
  for (;;) {
    const sum = pool.reduce((a, t) => a + t.weight, 0);
    const w = pool.map((t) => t.weight / sum);
    // Teto: fixa quem passou e redistribui o excesso até ninguém passar.
    const capped = new Set<number>();
    for (let k = 0; k < 20; k++) {
      const over = w.map((x, i) => (x > cap + 1e-12 && !capped.has(i) ? i : -1)).filter((i) => i >= 0);
      if (!over.length) break;
      over.forEach((i) => capped.add(i));
      const excess = over.reduce((a, i) => a + (w[i] - cap), 0);
      over.forEach((i) => (w[i] = cap));
      const free = w.map((_, i) => i).filter((i) => !capped.has(i));
      const fsum = free.reduce((a, i) => a + w[i], 0);
      if (!free.length || fsum <= 0) break;
      free.forEach((i) => (w[i] += (excess * w[i]) / fsum));
    }
    // Fatia abaixo da ordem mínima sai e a conta recomeça.
    const small = pool.findIndex((_, i) => w[i] * investable < opts.minOrderBRL);
    if (small >= 0 && pool.length > 1) {
      dropped.push(pool[small]);
      pool = pool.filter((_, i) => i !== small);
      continue;
    }
    // Valores inteiros; a sobra do arredondamento vai para o maior ativo que não está no teto (nada fica parado).
    const lines = pool.map((t, i) => ({ ...t, finalWeight: w[i], amountBRL: Math.floor(w[i] * investable), capped: capped.has(i) }));
    const leftover = Math.round(investable) - lines.reduce((a, l) => a + l.amountBRL, 0);
    const target = lines.filter((l) => !l.capped).sort((a, b) => b.amountBRL - a.amountBRL)[0];
    if (target && leftover > 0) target.amountBRL += leftover;
    const used = lines.reduce((a, l) => a + l.amountBRL, 0);
    return { lines, cashBRL: budgetBRL - used, dropped };
  }
}
