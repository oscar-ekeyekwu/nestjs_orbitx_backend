import type { EntityManager } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { Company } from '../companies/entities/company.entity';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';
import { loadOwner, OwnerType } from './polymorphic';

interface FindOneByCall {
  entity: unknown;
  where: { id: string };
}

function buildEm(response: unknown): {
  em: EntityManager;
  calls: FindOneByCall[];
} {
  const calls: FindOneByCall[] = [];
  const em = {
    findOneBy: jest.fn((entity: unknown, where: { id: string }) => {
      calls.push({ entity, where });
      return Promise.resolve(response);
    }),
  } as unknown as EntityManager;
  return { em, calls };
}

describe('loadOwner (ARCH-4)', () => {
  const ID = 'b6f1a3a7-1d11-4a83-9e2c-7f7a4f0d6e88';

  it("resolves ownerType='user' via User repository", async () => {
    const fake = { id: ID, email: 'a@b.c' };
    const { em, calls } = buildEm(fake);

    const result = await loadOwner(em, 'user', ID);

    expect(calls[0].entity).toBe(User);
    expect(calls[0].where).toEqual({ id: ID });
    expect(result).toBe(fake);
  });

  it("resolves ownerType='vehicle' via Vehicle repository", async () => {
    const fake = { id: ID, plate: 'LAG-123-AA' };
    const { em, calls } = buildEm(fake);

    const result = await loadOwner(em, 'vehicle', ID);

    expect(calls[0].entity).toBe(Vehicle);
    expect(result).toBe(fake);
  });

  it("resolves ownerType='company' via Company repository", async () => {
    const fake = { id: ID, legalName: 'Acme Logistics Ltd' };
    const { em, calls } = buildEm(fake);

    const result = await loadOwner(em, 'company', ID);

    expect(calls[0].entity).toBe(Company);
    expect(result).toBe(fake);
  });

  it("resolves ownerType='individual_driver' via DriverProfile repository", async () => {
    const fake = { id: ID, accountType: 'individual' };
    const { em, calls } = buildEm(fake);

    const result = await loadOwner(em, 'individual_driver', ID);

    expect(calls[0].entity).toBe(DriverProfile);
    expect(result).toBe(fake);
  });

  it('returns null when the underlying row does not exist', async () => {
    const { em } = buildEm(null);
    const result = await loadOwner(em, 'company', ID);
    expect(result).toBeNull();
  });

  it('throws if a caller bypasses TypeScript with an unknown ownerType (runtime safety net)', async () => {
    const { em } = buildEm(null);
    // Casting through unknown simulates the only way this can happen at
    // runtime — JSON payloads, dynamic dispatch, etc.
    const bogus = 'document' as unknown as OwnerType;
    await expect(loadOwner(em, bogus, ID)).rejects.toThrow(
      /unhandled ownerType/i,
    );
  });
});
