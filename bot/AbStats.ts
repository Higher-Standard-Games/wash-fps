/** Statistics for `bot:ab`: telling a stronger bot from luck. */

/** Two-sided binomial sign test: the chance of a split at least this uneven if both arms were equal. */
export function signTest(winsA: number, winsB: number): number {
  const n = winsA + winsB;
  if (n === 0) return 1;
  const k = Math.max(winsA, winsB);
  let tail = 0;
  let choose = 1;
  for (let i = 0; i <= n; i++) {
    if (i > 0) choose = (choose * (n - i + 1)) / i;
    if (i >= k) tail += choose;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}
