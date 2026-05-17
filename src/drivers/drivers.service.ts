import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { DriverProfile } from './entities/driver-profile.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { UsersService } from '../users/users.service';

@Injectable()
export class DriversService {
  constructor(
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
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

    profile.isOnline = isOnline;
    return this.driverProfileRepository.save(profile);
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

    profile.totalEarnings = Number(profile.totalEarnings) + amount;
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
      totalEarnings: Number(profile.totalEarnings),
      isOnline: profile.isOnline,
      isOnDelivery: profile.isOnDelivery,
    };
  }
}
