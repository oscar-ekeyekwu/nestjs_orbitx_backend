import { WalletService } from './wallet.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { naira } from '../common/money';

/**
 * Stub config service driven by a key→value map so each test can declare
 * exactly the DRIVER_CHARGE_* knobs it cares about. getNumber/getString
 * fall back to the supplied default when a key is absent.
 */
function buildService(values: Record<string, string | number>): WalletService {
  const getNumber = jest.fn(
    (key: string, def: number): Promise<number> =>
      Promise.resolve(values[key] !== undefined ? Number(values[key]) : def),
  );
  const getString = jest.fn(
    (key: string, def: string): Promise<string> =>
      Promise.resolve(values[key] !== undefined ? String(values[key]) : def),
  );
  return new WalletService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getNumber, getString } as never,
    {} as never,
  );
}

describe('WalletService.computeOrderCharge', () => {
  it('flat mode returns the flat charge regardless of price', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'flat',
      [ConfigKey.DRIVER_CHARGE_FLAT]: 200,
    });
    expect((await service.computeOrderCharge(naira('1000'))).toString()).toBe(
      '200',
    );
    expect((await service.computeOrderCharge(naira('50000'))).toString()).toBe(
      '200',
    );
  });

  it('flat 0 yields a zero charge', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'flat',
      [ConfigKey.DRIVER_CHARGE_FLAT]: 0,
    });
    expect((await service.computeOrderCharge(naira('1000'))).toString()).toBe(
      '0',
    );
  });

  it('percentage mode takes a percent of the order price', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'percentage',
      [ConfigKey.DRIVER_CHARGE_PERCENTAGE]: 10,
    });
    expect((await service.computeOrderCharge(naira('1000'))).toString()).toBe(
      '100',
    );
  });

  it('percentage 0 yields a zero charge', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'percentage',
      [ConfigKey.DRIVER_CHARGE_PERCENTAGE]: 0,
    });
    expect((await service.computeOrderCharge(naira('1000'))).toString()).toBe(
      '0',
    );
  });

  it('applies the cap when the percentage charge exceeds it', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'percentage',
      [ConfigKey.DRIVER_CHARGE_PERCENTAGE]: 10,
      [ConfigKey.DRIVER_CHARGE_CAP]: 300,
    });
    // 10% of 5000 = 500, capped to 300.
    expect((await service.computeOrderCharge(naira('5000'))).toString()).toBe(
      '300',
    );
  });

  it('cap of 0 means no cap', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'percentage',
      [ConfigKey.DRIVER_CHARGE_PERCENTAGE]: 10,
      [ConfigKey.DRIVER_CHARGE_CAP]: 0,
    });
    expect((await service.computeOrderCharge(naira('5000'))).toString()).toBe(
      '500',
    );
  });

  it('clamps a percentage above 100 to 100 (no throw)', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'percentage',
      [ConfigKey.DRIVER_CHARGE_PERCENTAGE]: 150,
    });
    expect((await service.computeOrderCharge(naira('1000'))).toString()).toBe(
      '1000',
    );
  });

  it('rounds the percentage charge to whole Naira (HALF_UP)', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'percentage',
      [ConfigKey.DRIVER_CHARGE_PERCENTAGE]: 7.5,
    });
    // 7.5% of 1234 = 92.55 → 93.
    expect((await service.computeOrderCharge(naira('1234'))).toString()).toBe(
      '93',
    );
  });

  it('flat charge may exceed the order price (platform revenue, not clamped)', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'flat',
      [ConfigKey.DRIVER_CHARGE_FLAT]: 2000,
    });
    expect((await service.computeOrderCharge(naira('1000'))).toString()).toBe(
      '2000',
    );
  });

  it('falls back to flat for an unknown mode value', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'garbage',
      [ConfigKey.DRIVER_CHARGE_FLAT]: 150,
    });
    expect((await service.computeOrderCharge(naira('1000'))).toString()).toBe(
      '150',
    );
  });

  it('treats a negative flat as zero', async () => {
    const service = buildService({
      [ConfigKey.DRIVER_CHARGE_MODE]: 'flat',
      [ConfigKey.DRIVER_CHARGE_FLAT]: -50,
    });
    expect((await service.computeOrderCharge(naira('1000'))).toString()).toBe(
      '0',
    );
  });
});
