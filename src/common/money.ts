import Decimal from 'decimal.js';
import type { ValueTransformer } from 'typeorm';

// ARCH-1 wire-format guarantee:
// Naira values must serialize to the canonical `"\d+\.\d{2}"` form when an
// entity (or any container of one) goes through JSON.stringify. Without an
// override, decimal.js's default toJSON drops trailing zeros (`naira('1500')`
// would serialize as `"1500"`, not `"1500.00"`).
//
// Decimal is only used in this codebase for Naira values (lat/lng and rating
// columns route through their own non-Decimal numericTransformer), so
// patching the prototype here keeps the override scoped in practice.
(Decimal.prototype as Decimal & { toJSON: () => string }).toJSON =
  function naira_toJSON(this: Decimal) {
    return this.toFixed(2);
  };

/**
 * Branded Naira amount.
 *
 * Always a `Decimal` at runtime, a string in `"\d+\.\d{2}"` form on the wire.
 * The phantom `__nairaBrand` field forbids implicit `number` arithmetic
 * (`naira + 100` is a compile error), forcing call sites through
 * `.plus`/`.minus`/`.times`/`.dividedBy`.
 */
export type Naira = Decimal & { readonly __nairaBrand: unique symbol };

/**
 * Construct a Naira value.
 *
 * Accepts `string` (preferred — e.g. `naira('1000.00')`) or `number`. The
 * lint rule in `eslint.config.mjs` forbids numeric literals at call sites
 * so the `number` overload only exists for runtime-untyped sources such
 * as `decimal.js` itself.
 */
export function naira(value: string | number | Decimal): Naira {
  return new Decimal(value) as Naira;
}

/**
 * TypeORM transformer for `decimal(12,2)` Naira columns.
 *
 * Read path: pg returns the column as `string` → we re-hydrate to a
 * branded `Decimal`. Write path: serialize back to `string` with exactly
 * two decimal places (matches column scale and the wire format).
 */
export const nairaTransformer: ValueTransformer = {
  to: (
    value: Naira | Decimal | string | number | null | undefined,
  ): string | null => {
    if (value === null || value === undefined) return null;
    return new Decimal(value as Decimal | string | number).toFixed(2);
  },
  from: (value: string | number | null | undefined): Naira | null => {
    if (value === null || value === undefined) return null;
    return new Decimal(value) as Naira;
  },
};

/** Serialize a Naira (or null) to the canonical wire string `"1500.00"`. */
export function nairaToJSON(value: Naira | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toFixed(2);
}

/** Convenience zero constant for default amounts. */
export const NAIRA_ZERO: Naira = naira('0.00');
