import type { ValueTransformer } from 'typeorm';

/**
 * TypeORM column transformer for PostgreSQL `numeric`/`decimal` columns.
 *
 * Background: `pg` returns numeric values as **string** by default
 * (because JS doubles can't represent the full range/precision of arbitrary
 * decimals). Without a transformer, an entity declared as `balance: number`
 * actually holds a string at runtime — leading to gems like:
 *   wallet.balance + 100  // "1000" + 100 = "1000100"
 *
 * This transformer normalizes the read side to `number` so the TS type
 * matches reality. Math is still float-prone (this is a NUMBER) — full
 * correctness needs a `Decimal` type from decimal.js. Track in
 * project-context.md "Known Gaps" → "Money decimal handling".
 *
 * Write side: format with 2 decimals before sending to the DB so existing
 * `Number()` assignments don't lose precision.
 */
export const numericTransformer: ValueTransformer = {
  to: (value: number | string | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    return value.toFixed(2);
  },
  from: (value: string | number | null | undefined): number => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },
};
