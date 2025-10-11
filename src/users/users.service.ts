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
    role: UserRole,
  ): Promise<User> {
    let user = await this.findByGoogleId(googleId);

    if (user) {
      // Update existing user
      user.first_name = firstName;
      user.last_name = lastName;
      user.avatar = avatar;
      return this.usersRepository.save(user);
    }

    // Check if email exists (user registered with email/password)
    user = await this.findByEmail(email);

    if (user) {
      // Link Google account to existing user
      user.googleId = googleId;
      user.avatar = avatar;
      user.isEmailVerified = true;
      return this.usersRepository.save(user);
    }

    // Create new user
    user = this.usersRepository.create({
      email,
      first_name: firstName,
      last_name: lastName,
      googleId,
      avatar,
      role,
      isEmailVerified: true,
      password: undefined, // Google users don't have password
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

  async remove(id: string): Promise<void> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.usersRepository.remove(user);
  }
}
