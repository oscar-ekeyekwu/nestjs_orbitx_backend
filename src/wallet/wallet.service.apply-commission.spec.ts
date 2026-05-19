import { WalletService } from './wallet.service';
import { ConfigKey } from '../config/enums/config-keys.enum';
import { naira } from '../common/money';

function buildService(configStub: { getNumber: jest.Mock }): WalletService {
  // Only the config dependency is exercised here; the rest of the
  // service's deps are unused by applyCommission so we pass tightly-typed
  // empty objects to satisfy the constructor.
  return new WalletService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    configStub as never,
    {} as never,
  );
}

describe('WalletService.applyCommission (G5)', () => {
  it('splits 1000 at 15% into driver 850 / commission 150', async () => {
    const service = buildService({
      getNumber: jest.fn().mockResolvedValue(15),
    });

    const split = await service.applyCommission(naira('1000'));

    expect(split.driverShare.toString()).toBe('850');
    expect(split.commission.toString()).toBe('150');
    expect(split.commissionPct).toBe(15);
  });

  it('honours an explicit override and skips the config read', async () => {
    const getNumber = jest.fn();
    const service = buildService({ getNumber });

    const split = await service.applyCommission(naira('1000'), 25);

    expect(split.driverShare.toString()).toBe('750');
    expect(split.commission.toString()).toBe('250');
    expect(split.commissionPct).toBe(25);
    expect(getNumber).not.toHaveBeenCalled();
  });

  it('0% commission gives the driver the full fee', async () => {
    const service = buildService({
      getNumber: jest.fn().mockResolvedValue(0),
    });
    const split = await service.applyCommission(naira('1000'));
    expect(split.driverShare.toString()).toBe('1000');
    expect(split.commission.toString()).toBe('0');
  });

  it('100% commission gives the driver nothing', async () => {
    const service = buildService({
      getNumber: jest.fn().mockResolvedValue(100),
    });
    const split = await service.applyCommission(naira('1000'));
    expect(split.driverShare.toString()).toBe('0');
    expect(split.commission.toString()).toBe('1000');
  });

  it('handles fractional rates with decimal precision', async () => {
    const service = buildService({
      getNumber: jest.fn().mockResolvedValue(17.5),
    });
    const split = await service.applyCommission(naira('1000'));
    expect(split.commission.toString()).toBe('175');
    expect(split.driverShare.toString()).toBe('825');
  });

  it('reads the live config when no override is passed', async () => {
    const getNumber = jest.fn().mockResolvedValue(12);
    const service = buildService({ getNumber });

    await service.applyCommission(naira('1000'));

    expect(getNumber).toHaveBeenCalledWith(
      ConfigKey.DRIVER_COMMISSION_PERCENTAGE,
      15,
    );
  });

  it('throws on a negative rate (tamper guard)', async () => {
    const service = buildService({
      getNumber: jest.fn().mockResolvedValue(-5),
    });
    await expect(service.applyCommission(naira('1000'))).rejects.toThrow(
      /in \[0, 100\]/,
    );
  });

  it('throws on a rate above 100%', async () => {
    const service = buildService({
      getNumber: jest.fn().mockResolvedValue(150),
    });
    await expect(service.applyCommission(naira('1000'))).rejects.toThrow(
      /in \[0, 100\]/,
    );
  });

  it('throws on NaN', async () => {
    const service = buildService({
      getNumber: jest.fn().mockResolvedValue(Number.NaN),
    });
    await expect(service.applyCommission(naira('1000'))).rejects.toThrow();
  });
});
