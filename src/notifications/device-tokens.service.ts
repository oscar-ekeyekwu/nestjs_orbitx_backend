import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DevicePlatform, DeviceToken } from './entities/device-token.entity';

/**
 * J1 — register / deregister device tokens from the mobile client.
 *
 * Idempotent: upserting the same token for the same user just bumps
 * `updatedAt` + flips `isActive=true` if it had been revoked.
 *
 * The PushFanoutService (ARCH-10) queries `isActive=true` rows by
 * userId for every push send. UNREGISTERED errors there flip
 * `isActive=false` so this service's `register` call can resurrect a
 * stale row without inserting a duplicate.
 */
@Injectable()
export class DeviceTokensService {
  private readonly logger = new Logger(DeviceTokensService.name);

  constructor(
    @InjectRepository(DeviceToken)
    private readonly repo: Repository<DeviceToken>,
  ) {}

  async register(
    userId: string,
    token: string,
    platform: DevicePlatform,
  ): Promise<DeviceToken> {
    const trimmed = token.trim();
    const existing = await this.repo.findOne({ where: { token: trimmed } });
    if (existing) {
      // Reassigning a token to a new user can legitimately happen on
      // a shared device (account switch). Re-point + reactivate.
      existing.userId = userId;
      existing.platform = platform;
      existing.isActive = true;
      return this.repo.save(existing);
    }
    const created = this.repo.create({
      userId,
      token: trimmed,
      platform,
      isActive: true,
    });
    return this.repo.save(created);
  }

  /**
   * Caller asserts they are the owner of the token (typically because
   * they're logging out). Anonymous deactivation by token is acceptable
   * because the token itself is a capability — possession proves
   * ownership for the bearer-style invalidation use case.
   */
  async remove(userId: string, token: string): Promise<void> {
    const trimmed = token.trim();
    await this.repo.update({ token: trimmed, userId }, { isActive: false });
  }
}
