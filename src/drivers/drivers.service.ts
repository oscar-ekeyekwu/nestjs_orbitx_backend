import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import {
  DriverProfile,
  DriverVerificationStatus,
} from './entities/driver-profile.entity';
import { VehicleAssignment } from '../vehicles/entities/vehicle-assignment.entity';
import { Vehicle, VehicleStatus } from '../vehicles/entities/vehicle.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { UsersService } from '../users/users.service';
import { Naira, naira } from '../common/money';
import { ErrorCodes } from '../common/constants/error-codes';

/**
 * Eligible driver shape returned by `findEligibleDrivers`. Flattens the
 * useful columns from the driver_profile ⨝ vehicle_assignments ⨝ vehicles
 * join so the matching engine doesn't have to walk three relations.
 */
export interface EligibleDriver {
  driverId: string;
  userId: string;
  currentLatitude: number | null;
  currentLongitude: number | null;
  vehicleId: string;
  vehicleType: string;
  vehiclePlate: string;
  assignmentId: string;
}

@Injectable()
export class DriversService {
  constructor(
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
    @InjectRepository(VehicleAssignment)
    private assignmentRepository: Repository<VehicleAssignment>,
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    private usersService: UsersService,
  ) {}

  async createProfile(
    userId: string,
    manager?: EntityManager,
  ): Promise<DriverProfile> {
    // Optional EntityManager so callers (e.g. AuthService during driver
    // registration) can include this insert in their own transaction.
    const repo = manager
      ? manager.getRepository(DriverProfile)
      : this.driverProfileRepository;

    const existingProfile = await repo.findOne({ where: { userId } });

    if (existingProfile) {
      return existingProfile;
    }

    const profile = repo.create({ userId });
    return repo.save(profile);
  }

  async findByUserId(userId: string): Promise<DriverProfile | null> {
    return this.driverProfileRepository.findOne({
      where: { userId },
      relations: ['user'],
    });
  }

  async updateOnlineStatus(
    userId: string,
    isOnline: boolean,
  ): Promise<DriverProfile> {
    let profile = await this.findByUserId(userId);

    if (!profile) {
      // Backfill path: drivers registered before A3 shipped don't have a
      // profile row yet. Auto-create one — but only for users whose role is
      // actually 'driver'. Any other role missing a profile is a genuine
      // 404 and should surface as such.
      const user = await this.usersService.findById(userId);
      if (!user) {
        throw new NotFoundException('Driver profile not found');
      }
      if (user.role !== UserRole.DRIVER) {
        throw new NotFoundException('Driver profile not found');
      }
      profile = await this.createProfile(userId);
    }

    // B5: going online requires an active assignment to an APPROVED
    // vehicle. Going offline is unconditional — drivers must always be
    // able to drop out, even if their assignment is in flux.
    if (isOnline) {
      await this.assertHasActiveApprovedVehicle(profile.id);
    }

    profile.isOnline = isOnline;
    return this.driverProfileRepository.save(profile);
  }

  /**
   * Throws BadRequestException with DRIVER_003 if the driver has no
   * active assignment OR the assigned vehicle isn't APPROVED.
   */
  private async assertHasActiveApprovedVehicle(
    driverId: string,
  ): Promise<void> {
    const activeAssignment = await this.assignmentRepository.findOne({
      where: { driverId, unassignedAt: IsNull() },
    });
    if (!activeAssignment) {
      throw new BadRequestException({
        errorCode: ErrorCodes.DRIVER_003,
        message: 'Your assigned vehicle is not currently approved.',
      });
    }
    const vehicle = await this.vehicleRepository.findOne({
      where: { id: activeAssignment.vehicleId },
    });
    if (!vehicle || vehicle.status !== VehicleStatus.APPROVED) {
      throw new BadRequestException({
        errorCode: ErrorCodes.DRIVER_003,
        message: 'Your assigned vehicle is not currently approved.',
      });
    }
  }

  /**
   * B5 — order-matching eligibility query.
   *
   * Returns every active (driver, vehicle) pair that matches the four
   * filters from the architecture:
   *
   *   driver_profiles.verification_status = 'active'
   *   driver_profiles.is_online            = true
   *   vehicle_assignments.unassigned_at    IS NULL
   *   vehicles.status                      = 'approved'
   *
   * Multiple drivers can be online simultaneously — there's no implicit
   * "one driver per company" or "one driver per fleet" cap. Order
   * assignment (J4) adds distance / availability filtering on top of
   * this list.
   */
  async findEligibleDrivers(): Promise<EligibleDriver[]> {
    const rows = await this.driverProfileRepository
      .createQueryBuilder('dp')
      .innerJoin(
        VehicleAssignment,
        'va',
        'va."driverId" = dp.id AND va."unassignedAt" IS NULL',
      )
      .innerJoin(
        Vehicle,
        'v',
        'v.id = va."vehicleId" AND v.status = :approved',
        { approved: VehicleStatus.APPROVED },
      )
      .where('dp."verificationStatus" = :active', {
        active: DriverVerificationStatus.ACTIVE,
      })
      .andWhere('dp."isOnline" = true')
      .select([
        'dp.id AS "driverId"',
        'dp."userId" AS "userId"',
        'dp."currentLatitude" AS "currentLatitude"',
        'dp."currentLongitude" AS "currentLongitude"',
        'v.id AS "vehicleId"',
        'v.type AS "vehicleType"',
        'v.plate AS "vehiclePlate"',
        'va.id AS "assignmentId"',
      ])
      .getRawMany<EligibleDriver>();
    return rows;
  }

  async updateLocation(
    userId: string,
    latitude: number,
    longitude: number,
  ): Promise<DriverProfile> {
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    profile.currentLatitude = latitude;
    profile.currentLongitude = longitude;

    return this.driverProfileRepository.save(profile);
  }

  async updateDeliveryStatus(
    userId: string,
    isOnDelivery: boolean,
  ): Promise<DriverProfile> {
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    profile.isOnDelivery = isOnDelivery;

    if (!isOnDelivery) {
      // Delivery completed
      profile.totalDeliveries += 1;
    }

    return this.driverProfileRepository.save(profile);
  }

  async updateEarnings(userId: string, amount: number): Promise<DriverProfile> {
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    const delta = naira(String(amount));
    profile.totalEarnings = profile.totalEarnings.plus(delta) as Naira;
    return this.driverProfileRepository.save(profile);
  }

  async updateRating(userId: string, rating: number): Promise<DriverProfile> {
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    const totalScore = Number(profile.rating) * profile.totalRatings + rating;
    profile.totalRatings += 1;
    profile.rating = totalScore / profile.totalRatings;

    return this.driverProfileRepository.save(profile);
  }

  async getStats(userId: string) {
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    return {
      totalDeliveries: profile.totalDeliveries,
      rating: Number(profile.rating).toFixed(1),
      totalRatings: profile.totalRatings,
      totalEarnings: profile.totalEarnings.toFixed(2),
      isOnline: profile.isOnline,
      isOnDelivery: profile.isOnDelivery,
    };
  }
}
