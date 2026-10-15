/** Scores use decimal rounding to hundredths, including binary half-way cases. */
export function roundRating(score: number): number {
  return Math.round(score * 100 + 1e-10) / 100;
}

export function formatRating(score: number | null | undefined): string {
  return score == null || !Number.isFinite(score) ? "—" : roundRating(score).toFixed(2);
}
