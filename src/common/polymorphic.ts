import type { EntityManager } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { Company } from '../companies/entities/company.entity';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';

/**
 * Polymorphic owner reference. Used by tables that bind to one of several
 * entity types via `(ownerType, ownerId)` rather than multiple nullable
 * FKs (documents, vehicles, etc.).
 *
 * `'individual_driver'` resolves to the driver_profile row (not the user
 * row) because an individual driver's identity is the profile — their
 * accountType + verificationStatus live there.
 *
 * approval_decisions uses a wider `targetType` set ('driver' | 'company'
 * | 'vehicle' | 'document') that's intentionally not a subset of this
 * union; that lookup belongs in an `approval-decisions` helper, not here.
 */
export type OwnerType = 'user' | 'vehicle' | 'company' | 'individual_driver';

export type LoadedOwner = User | Vehicle | Company | DriverProfile;

/**
 * Resolve a polymorphic `(ownerType, ownerId)` reference to the typed
 * entity instance.
 *
 * Returns the entity (typed via overloads so the caller doesn't need to
 * cast) or `null` if no row matches `ownerId`. Throws only if the caller
 * passes an `ownerType` outside the declared union — TypeScript should
 * catch that at compile time via the `never` narrowing in the default
 * branch.
 */
export function loadOwner(
  em: EntityManager,
  ownerType: 'user',
  ownerId: string,
): Promise<User | null>;
export function loadOwner(
  em: EntityManager,
  ownerType: 'vehicle',
  ownerId: string,
): Promise<Vehicle | null>;
export function loadOwner(
  em: EntityManager,
  ownerType: 'company',
  ownerId: string,
): Promise<Company | null>;
export function loadOwner(
  em: EntityManager,
  ownerType: 'individual_driver',
  ownerId: string,
): Promise<DriverProfile | null>;
export function loadOwner(
  em: EntityManager,
  ownerType: OwnerType,
  ownerId: string,
): Promise<LoadedOwner | null>;
export async function loadOwner(
  em: EntityManager,
  ownerType: OwnerType,
  ownerId: string,
): Promise<LoadedOwner | null> {
  switch (ownerType) {
    case 'user':
      return em.findOneBy(User, { id: ownerId });
    case 'vehicle':
      return em.findOneBy(Vehicle, { id: ownerId });
    case 'company':
      return em.findOneBy(Company, { id: ownerId });
    case 'individual_driver':
      return em.findOneBy(DriverProfile, { id: ownerId });
    default:
      // Exhaustiveness check — narrows to `never` if every case is
      // handled, so adding a new OwnerType without updating this switch
      // is a compile error.
      return assertNeverOwner(ownerType);
  }
}

function assertNeverOwner(value: never): never {
  throw new Error(
    `loadOwner: unhandled ownerType "${value as string}". Update OwnerType + the switch together.`,
  );
}
