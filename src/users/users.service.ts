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
  PaginationDto,
  PaginatedResult,
  createPaginatedResponse,
} from '../common/dto/pagination.dto';

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

  async findAll(
    paginationDto: PaginationDto,
    role?: UserRole,
  ): Promise<PaginatedResult<User>> {
    const query = this.usersRepository.createQueryBuilder('user');

    if (role) {
      query.where('user.role = :role', { role });
    }

    query
      .orderBy('user.createdAt', 'DESC')
      .skip(paginationDto.skip)
      .take(paginationDto.limit);

    const [users, total] = await query.getManyAndCount();

    return createPaginatedResponse(
      users,
      total,
      paginationDto.page!,
      paginationDto.limit!,
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
