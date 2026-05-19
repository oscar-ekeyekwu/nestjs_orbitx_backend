import { VehicleType } from '../vehicles/entities/vehicle.entity';
import { PackageSize } from './entities/order.entity';

/**
 * ARCH-12 — vehicle type → set of package sizes the driver can carry.
 *
 * Bicycle/motorcycle drivers see SMALL only. Cars + vans extend up to
 * MEDIUM (mid-sized parcels but not pallets). Vans and trucks can
 * handle LARGE. The set is open-coded rather than ordinal because
 * v1.1 will likely introduce non-linear capacity (e.g. a fridge truck
 * that can't carry small parcels for cold-chain reasons).
 */
const PACKAGE_SIZES_BY_VEHICLE: Record<VehicleType, readonly PackageSize[]> = {
  [VehicleType.BICYCLE]: [PackageSize.SMALL],
  [VehicleType.MOTORCYCLE]: [PackageSize.SMALL],
  [VehicleType.CAR]: [PackageSize.SMALL, PackageSize.MEDIUM],
  [VehicleType.VAN]: [PackageSize.SMALL, PackageSize.MEDIUM, PackageSize.LARGE],
  [VehicleType.TRUCK]: [
    PackageSize.SMALL,
    PackageSize.MEDIUM,
    PackageSize.LARGE,
  ],
};

export function packageSizesForVehicle(
  type: VehicleType,
): readonly PackageSize[] {
  return PACKAGE_SIZES_BY_VEHICLE[type] ?? [];
}
