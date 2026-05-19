import { packageSizesForVehicle } from './package-size.helper';
import { VehicleType } from '../vehicles/entities/vehicle.entity';
import { PackageSize } from './entities/order.entity';

describe('packageSizesForVehicle (ARCH-12)', () => {
  it.each([
    [VehicleType.BICYCLE, [PackageSize.SMALL]],
    [VehicleType.MOTORCYCLE, [PackageSize.SMALL]],
    [VehicleType.CAR, [PackageSize.SMALL, PackageSize.MEDIUM]],
    [
      VehicleType.VAN,
      [PackageSize.SMALL, PackageSize.MEDIUM, PackageSize.LARGE],
    ],
    [
      VehicleType.TRUCK,
      [PackageSize.SMALL, PackageSize.MEDIUM, PackageSize.LARGE],
    ],
  ])('vehicle %s maps to package sizes %j', (type, expected) => {
    expect([...packageSizesForVehicle(type)]).toEqual(expected);
  });
});
