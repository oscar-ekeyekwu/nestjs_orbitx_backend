import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { DriversService } from '../drivers/drivers.service';
import { EmailService } from '../email/email.service';
import { InvitesService } from '../invites/invites.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { RegisterDto } from './dto/register.dto';
import { UserRole } from '../common/enums/user-role.enum';

describe('AuthService.register (A3 — transactional driver profile creation)', () => {
  let service: AuthService;
  let usersService: { create: jest.Mock };
  let driversService: { createProfile: jest.Mock };
  let jwtService: { sign: jest.Mock; decode: jest.Mock };
  let configService: { get: jest.Mock };
  let emailService: object;
  let refreshTokenRepo: {
    update: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  // The fake EntityManager the transaction callback receives. AuthService just
  // hands it down to UsersService and DriversService — these tests verify the
  // hand-off, not the manager's internals.
  const fakeManager = { __tx: true } as unknown;

  beforeEach(async () => {
    usersService = {
      create: jest.fn().mockImplementation((dto: RegisterDto) =>
        Promise.resolve({
          id: 'user-1',
          email: dto.email,
          role: dto.role ?? UserRole.CUSTOMER,
        }),
      ),
    };
    driversService = { createProfile: jest.fn().mockResolvedValue(undefined) };
    jwtService = {
      sign: jest.fn().mockReturnValue('access-token'),
      decode: jest.fn().mockReturnValue({ exp: 9999999999 }),
    };
    configService = { get: jest.fn().mockReturnValue(30) };
    emailService = {};
    refreshTokenRepo = {
      update: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation((row: object) => row),
      save: jest
        .fn()
        .mockImplementation((row: object) =>
          Promise.resolve({ token: 'refresh-token', ...row }),
        ),
    };
    dataSource = {
      // Real-shape transaction: invoke the callback with the fake manager and
      // return its resolved value, mirroring TypeORM's API.
      transaction: jest
        .fn()
        .mockImplementation((cb: (m: unknown) => Promise<unknown>) =>
          cb(fakeManager),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: DriversService, useValue: driversService },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
        { provide: EmailService, useValue: emailService },
        { provide: DataSource, useValue: dataSource },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: refreshTokenRepo,
        },
        // D4: AuthService now optionally redeems an invite. Existing
        // tests don't pass an inviteToken so this stays an inert mock;
        // the dedicated InvitesService spec covers the redeem path.
        {
          provide: InvitesService,
          useValue: {
            redeemInTransaction: jest.fn(),
            createInvite: jest.fn(),
            listForCompany: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('wraps register in a DataSource transaction', async () => {
    await service.register({
      email: 'a@b.com',
      password: 'pw',
      first_name: 'A',
      last_name: 'B',
      role: UserRole.CUSTOMER,
    } as RegisterDto);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('creates a DriverProfile inside the transaction for driver-role registrations', async () => {
    await service.register({
      email: 'driver@test.com',
      password: 'pw',
      first_name: 'D',
      last_name: 'River',
      role: UserRole.DRIVER,
    } as RegisterDto);

    // Both the user-create AND the profile-create receive the fake manager,
    // which proves the operations participate in the same transaction.
    expect(usersService.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: UserRole.DRIVER }),
      fakeManager,
    );
    expect(driversService.createProfile).toHaveBeenCalledWith(
      'user-1',
      fakeManager,
    );
  });

  it('does NOT create a DriverProfile for customer-role registrations', async () => {
    await service.register({
      email: 'cust@test.com',
      password: 'pw',
      first_name: 'C',
      last_name: 'X',
      role: UserRole.CUSTOMER,
    } as RegisterDto);

    expect(driversService.createProfile).not.toHaveBeenCalled();
  });

  it('rolls back fully when DriverProfile creation fails', async () => {
    driversService.createProfile.mockRejectedValueOnce(
      new Error('insert failed'),
    );

    await expect(
      service.register({
        email: 'driver-fail@test.com',
        password: 'pw',
        first_name: 'D',
        last_name: 'Fail',
        role: UserRole.DRIVER,
      } as RegisterDto),
    ).rejects.toThrow('insert failed');

    // The transaction callback threw, so generateAuthResponse must NOT have
    // run — no refresh token persisted means no orphan auth state.
    expect(refreshTokenRepo.save).not.toHaveBeenCalled();
  });
});
