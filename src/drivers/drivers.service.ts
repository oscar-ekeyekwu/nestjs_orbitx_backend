import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriverProfile } from './entities/driver-profile.entity';

@Injectable()
export class DriversService {
  constructor(
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
  ) {}

  async createProfile(userId: string): Promise<DriverProfile> {
    const existingProfile = await this.findByUserId(userId);

    if (existingProfile) {
      return existingProfile;
    }

    const profile = this.driverProfileRepository.create({ userId });
    return this.driverProfileRepository.save(profile);
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
    const profile = await this.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
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
