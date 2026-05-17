import Decimal from 'decimal.js';
import {
  Naira,
  NAIRA_ZERO,
  naira,
  nairaToJSON,
  nairaTransformer,
} from './money';

describe('common/money', () => {
  describe('naira()', () => {
    it('returns a Decimal-shaped value for a string input', () => {
      const amount = naira('1500.00');
      expect(amount).toBeInstanceOf(Decimal);
      expect(amount.toFixed(2)).toBe('1500.00');
    });

    it('accepts a number input at runtime (lint forbids it at call sites)', () => {
      const amount = naira(2500);
      expect(amount.toFixed(2)).toBe('2500.00');
    });

    it('preserves kobo precision that JS number arithmetic would lose', () => {
      const a = naira('0.10');
      const b = naira('0.20');
      const sum = a.plus(b);

      expect(sum.toFixed(2)).toBe('0.30');
      // The JS-number version of this addition is famously 0.30000000000000004.
      expect((0.1 + 0.2).toFixed(20)).not.toBe(sum.toFixed(20));
    });
  });

  describe('Decimal arithmetic', () => {
    it('plus / minus / times / dividedBy round-trip through Naira values', () => {
      const balance = naira('1000.00');
      const credit = naira('250.55');
      const fee = naira('10.25');
      const split = naira('3');

      const afterCredit = balance.plus(credit);
      const afterFee = afterCredit.minus(fee);
      const doubled = afterFee.times('2');
      const third = doubled.dividedBy(split);

      expect(afterCredit.toFixed(2)).toBe('1250.55');
      expect(afterFee.toFixed(2)).toBe('1240.30');
      expect(doubled.toFixed(2)).toBe('2480.60');
      // 2480.60 / 3 = 826.8666... → rounds half-up to 826.87
      expect(third.toFixed(2)).toBe('826.87');
    });

    it('keeps commission math kobo-precise (5%)', () => {
      const fare = naira('1234.56');
      const commissionPct = naira('0.05');

      const commission = fare.times(commissionPct);
      const driverShare = fare.minus(commission);

      expect(commission.toFixed(2)).toBe('61.73');
      expect(driverShare.toFixed(2)).toBe('1172.83');
    });
  });

  describe('nairaTransformer', () => {
    it('round-trips a Naira value through to/from (DB write then read)', () => {
      const original = naira('1500.00');

      const dbValue = nairaTransformer.to(original) as string;
      expect(dbValue).toBe('1500.00');

      const reHydrated = nairaTransformer.from(dbValue) as Naira;
      expect(reHydrated).toBeInstanceOf(Decimal);
      expect(reHydrated.toFixed(2)).toBe('1500.00');
    });

    it('to(): normalizes string / number / Decimal inputs to "x.xx"', () => {
      expect(nairaTransformer.to('1500')).toBe('1500.00');
      expect(nairaTransformer.to(1500.5)).toBe('1500.50');
      expect(nairaTransformer.to(new Decimal('1500.555'))).toBe('1500.56');
    });

    it('to(): returns null for null / undefined (column nullability)', () => {
      expect(nairaTransformer.to(null)).toBeNull();
      expect(nairaTransformer.to(undefined)).toBeNull();
    });

    it('from(): hydrates DB strings into Naira and tolerates null', () => {
      const hydrated = nairaTransformer.from('250.55') as Naira;
      expect(hydrated.toFixed(2)).toBe('250.55');

      expect(nairaTransformer.from(null)).toBeNull();
      expect(nairaTransformer.from(undefined)).toBeNull();
    });
  });

  describe('JSON serialization (wire format)', () => {
    it('nairaToJSON emits the canonical "\\d+\\.\\d{2}" pattern', () => {
      const amount = naira('1500');

      const wire = nairaToJSON(amount);

      expect(wire).toBe('1500.00');
      expect(wire).toMatch(/^\d+\.\d{2}$/);
    });

    it('nairaToJSON returns null for null / undefined', () => {
      expect(nairaToJSON(null)).toBeNull();
      expect(nairaToJSON(undefined)).toBeNull();
    });

    it('JSON.stringify emits "x.xx" thanks to the Decimal.toJSON override', () => {
      const amount = naira('1500');
      const payload = { balance: amount };

      const wire = JSON.stringify(payload);

      expect(wire).toBe('{"balance":"1500.00"}');
    });

    it('nested Naira inside an entity-like object serializes with two decimals', () => {
      const transactionLike = {
        amount: naira('250'),
        commission: naira('12.5'),
        balanceAfter: naira('1737.5'),
      };

      const wire = JSON.parse(JSON.stringify(transactionLike)) as Record<
        string,
        unknown
      >;

      expect(wire.amount).toBe('250.00');
      expect(wire.commission).toBe('12.50');
      expect(wire.balanceAfter).toBe('1737.50');
    });
  });

  describe('type-system + lint guarantees', () => {
    // Pure TypeScript can't make `Naira + number` a compile error on its
    // own — Decimal.valueOf() returns a string, so TS accepts `decimal +
    // number` as `string + number` (string concatenation). The brand stops
    // a Naira from being **assigned** to a `number` slot, and the
    // `@typescript-eslint/restrict-plus-operands` rule (already in the
    // recommendedTypeChecked preset) catches `+`/`-` on Naira at lint
    // time. The combination matches the spirit of the ARCH-1 AC.
    it('forbids assigning Naira to a number-typed slot', () => {
      const amount = naira('1000.00');

      // Compile-time assertion: the line below must not type-check. It is
      // not executed; the act of compiling this file proves the brand.
      const _check = (): never => {
        // @ts-expect-error Naira is not assignable to number (brand guard)
        const asNumber: number = amount;
        return asNumber as never;
      };
      void _check;

      expect(amount.plus(100).toFixed(2)).toBe('1100.00');
    });

    it('NAIRA_ZERO is a Naira', () => {
      expect(NAIRA_ZERO.toFixed(2)).toBe('0.00');
      expect(NAIRA_ZERO).toBeInstanceOf(Decimal);
    });
  });
});
