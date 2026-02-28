import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { RegisterDto } from '../auth/dto/register.dto';
import { UserRole } from '../common/enums/user-role.enum';
import {
  PaginatedResult,
  createPaginatedResponse,
} from '../common/dto/pagination.dto';
import { GetUsersQueryDto } from './dto/get-users-query.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async create(registerDto: RegisterDto): Promise<User> {
    const existingUser = await this.findByEmail(registerDto.email);

    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    const user = this.usersRepository.create(registerDto);
    return this.usersRepository.save(user);
  }

  async findAll(queryDto: GetUsersQueryDto): Promise<PaginatedResult<User>> {
    const { role, search } = queryDto;
    const query = this.usersRepository.createQueryBuilder('user');

    if (role) {
      query.andWhere('user.role = :role', { role });
    }

    if (search) {
      query.andWhere(
        '(user.first_name ILIKE :search OR user.last_name ILIKE :search OR user.email ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    query
      .orderBy('user.createdAt', 'DESC')
      .skip(queryDto.skip)
      .take(queryDto.limit);

    const [users, total] = await query.getManyAndCount();

    return createPaginatedResponse(
      users,
      total,
      queryDto.page!,
      queryDto.limit!,
    );
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { googleId } });
  }

  async createOrUpdateGoogleUser(
    email: string,
    firstName: string,
    lastName: string,
    googleId: string,
    avatar: string,
    role?: UserRole,
  ): Promise<User> {
    let user = await this.findByGoogleId(googleId);

    if (user) {
      user.first_name = firstName;
      user.last_name = lastName;
      user.avatar = avatar;
      return this.usersRepository.save(user);
    }

    user = await this.findByEmail(email);

    if (user) {
      user.googleId = googleId;
      user.avatar = avatar;
      user.isEmailVerified = true;
      return this.usersRepository.save(user);
    }

    user = this.usersRepository.create({
      email,
      first_name: firstName,
      last_name: lastName,
      googleId,
      avatar,
      role,
      isEmailVerified: true,
      password: undefined,
    });

    return this.usersRepository.save(user);
  }

  async update(id: string, updateData: Partial<User>): Promise<User> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    Object.assign(user, updateData);
    return this.usersRepository.save(user);
  }

  async updateEmailVerificationStatus(
    userId: string,
    isVerified: boolean,
  ): Promise<void> {
    await this.usersRepository.update(
      { id: userId },
      { isEmailVerified: isVerified },
    );
  }

  async updatePhoneVerificationStatus(
    userId: string,
    isVerified: boolean,
  ): Promise<void> {
    await this.usersRepository.update(
      { id: userId },
      { isPhoneVerified: isVerified },
    );
  }

  async remove(id: string): Promise<void> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.usersRepository.remove(user);
  }
}
