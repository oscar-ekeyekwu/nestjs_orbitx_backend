import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DriversService } from './drivers.service';
import { DriverProfile } from './entities/driver-profile.entity';
import { UsersService } from '../users/users.service';
import { UserRole } from '../common/enums/user-role.enum';

type RepoMock = {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
};

describe('DriversService', () => {
  let service: DriversService;
  let driverRepo: RepoMock;
  let usersService: { findById: jest.Mock };

  beforeEach(async () => {
    driverRepo = {
      findOne: jest.fn(),
      create: jest.fn((dto: Record<string, unknown>) => ({ ...dto })),
      save: jest.fn((row: Record<string, unknown>) =>
        Promise.resolve({ id: 'profile-1', ...row }),
      ),
    };
    usersService = { findById: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriversService,
        { provide: getRepositoryToken(DriverProfile), useValue: driverRepo },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    service = module.get<DriversService>(DriversService);
  });

  describe('createProfile', () => {
    it('returns the existing profile when one is already present (idempotent)', async () => {
      const existing = { id: 'profile-existing', userId: 'user-1' };
      driverRepo.findOne.mockResolvedValue(existing);

      const result = await service.createProfile('user-1');

      expect(result).toEqual(existing);
      expect(driverRepo.create).not.toHaveBeenCalled();
      expect(driverRepo.save).not.toHaveBeenCalled();
    });

    it('creates a new profile when none exists', async () => {
      driverRepo.findOne.mockResolvedValue(null);

      const result = await service.createProfile('user-1');

      expect(driverRepo.create).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(driverRepo.save).toHaveBeenCalled();
      expect(result.userId).toBe('user-1');
    });

    it('uses the supplied EntityManager when provided', async () => {
      const managerRepo: RepoMock = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((dto: Record<string, unknown>) => ({ ...dto })),
        save: jest
          .fn()
          .mockImplementation((row: Record<string, unknown>) =>
            Promise.resolve({ id: 'tx-1', ...row }),
          ),
      };
      const manager = {
        getRepository: jest.fn().mockReturnValue(managerRepo),
      } as unknown as Parameters<DriversService['createProfile']>[1];

      const result = await service.createProfile('user-1', manager);

      expect(managerRepo.findOne).toHaveBeenCalled();
      expect(managerRepo.create).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(managerRepo.save).toHaveBeenCalled();
      // Default repo must NOT be touched when an EntityManager is supplied.
      expect(driverRepo.findOne).not.toHaveBeenCalled();
      expect(driverRepo.save).not.toHaveBeenCalled();
      expect(result.userId).toBe('user-1');
    });
  });

  describe('updateOnlineStatus', () => {
    it('updates is_online when the profile exists', async () => {
      const profile = { id: 'p1', userId: 'u1', isOnline: false };
      driverRepo.findOne.mockResolvedValue(profile);
      driverRepo.save.mockImplementation((p) => Promise.resolve(p));

      const result = await service.updateOnlineStatus('u1', true);

      expect(result.isOnline).toBe(true);
      expect(usersService.findById).not.toHaveBeenCalled();
    });

    it('backfills the profile for a driver-role user missing one (A3)', async () => {
      // First lookup: profile missing.
      driverRepo.findOne
        .mockResolvedValueOnce(null)
        // Second lookup: still missing (called inside createProfile).
        .mockResolvedValueOnce(null);
      driverRepo.save.mockImplementation((p) =>
        Promise.resolve({ id: 'backfilled', ...p }),
      );
      usersService.findById.mockResolvedValue({
        id: 'u1',
        role: UserRole.DRIVER,
      });

      const result = await service.updateOnlineStatus('u1', true);

      expect(usersService.findById).toHaveBeenCalledWith('u1');
      expect(driverRepo.create).toHaveBeenCalledWith({ userId: 'u1' });
      expect(result.isOnline).toBe(true);
    });

    it('throws NotFoundException when the user is not a driver', async () => {
      driverRepo.findOne.mockResolvedValue(null);
      usersService.findById.mockResolvedValue({
        id: 'u1',
        role: UserRole.CUSTOMER,
      });

      await expect(service.updateOnlineStatus('u1', true)).rejects.toThrow(
        NotFoundException,
      );
      expect(driverRepo.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the user does not exist at all', async () => {
      driverRepo.findOne.mockResolvedValue(null);
      usersService.findById.mockResolvedValue(null);

      await expect(service.updateOnlineStatus('u1', true)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
