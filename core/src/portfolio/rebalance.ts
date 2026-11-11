/**
 * Rebalanceamento por classe (lógica do trader-rebalance, MIT): mede o desvio de cada classe em pontos
 * percentuais contra o alvo, só mexe no que saiu da faixa e lista vendas antes das compras.
 * Com dinheiro novo, usa o aporte para comprar o que está abaixo do alvo antes de sugerir vendas.
 */
export interface RebalanceLine {
  key: string;
  currentBRL: number;
  currentPct: number;
  targetPct: number;
  driftPP: number;
  /** Valor a comprar (+) ou vender (−), em reais. */
  tradeBRL: number;
}

export function rebalance(current: Record<string, number>, targetPct: Record<string, number>, bandPP = 5, newMoneyBRL = 0, avoidSells = false): { lines: RebalanceLine[]; totalAfter: number; note?: string } {
  const keys = [...new Set([...Object.keys(current), ...Object.keys(targetPct)])];
  const tsum = keys.reduce((a, k) => a + (targetPct[k] ?? 0), 0);
  const totalBefore = keys.reduce((a, k) => a + (current[k] ?? 0), 0);
  const totalAfter = totalBefore + newMoneyBRL;
  const lines: RebalanceLine[] = keys.map((k) => {
    const cur = current[k] ?? 0;
    const tp = tsum > 0 ? ((targetPct[k] ?? 0) / tsum) * 100 : 0;
    const cp = totalBefore > 0 ? (cur / totalBefore) * 100 : 0;
    return { key: k, currentBRL: cur, currentPct: cp, targetPct: tp, driftPP: cp - tp, tradeBRL: 0 };
  });
  const outOfBand = lines.filter((l) => Math.abs(l.driftPP) > bandPP || newMoneyBRL > 0);
  if (avoidSells || newMoneyBRL > 0) {
    // Só compras: distribui o aporte proporcionalmente ao que falta em cada classe abaixo do alvo.
    const gaps = lines.map((l) => Math.max(0, (l.targetPct / 100) * totalAfter - l.currentBRL));
    const gsum = gaps.reduce((a, b) => a + b, 0);
    lines.forEach((l, i) => (l.tradeBRL = gsum > 0 ? (gaps[i] / gsum) * Math.min(newMoneyBRL, gsum) : 0));
    if (newMoneyBRL > gsum) {
      const extra = newMoneyBRL - gsum;
      lines.forEach((l) => (l.tradeBRL += (extra * l.targetPct) / 100));
    }
  } else {
    for (const l of outOfBand) l.tradeBRL = (l.targetPct / 100) * totalAfter - l.currentBRL;
    // Vender e comprar só o que saiu da faixa deixa sobra/falta: equilibra entre as classes que foram mexidas.
    const net = lines.reduce((a, l) => a + l.tradeBRL, 0);
    const moved = lines.filter((l) => l.tradeBRL !== 0);
    if (moved.length && Math.abs(net) > 0.01) {
      const buys = moved.filter((l) => l.tradeBRL > 0);
      const sells = moved.filter((l) => l.tradeBRL < 0);
      const adj = net > 0 ? buys : sells;
      const s = adj.reduce((a, l) => a + Math.abs(l.tradeBRL), 0) || 1;
      for (const l of adj) l.tradeBRL -= (net * Math.abs(l.tradeBRL)) / s;
    }
  }
  lines.forEach((l) => (l.tradeBRL = Math.round(l.tradeBRL)));
  lines.sort((a, b) => a.tradeBRL - b.tradeBRL); // vendas antes das compras
  const note = !outOfBand.length ? `Todas as classes estão a menos de ${bandPP} pontos do alvo: nada a fazer.` : undefined;
  return { lines, totalAfter, note };
}
