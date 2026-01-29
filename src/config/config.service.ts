import { Injectable, OnModuleInit, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemConfig } from './entities/system-config.entity';
import { ConfigKey, DEFAULT_CONFIG_VALUES } from './enums/config-keys.enum';
import { UpdateConfigDto } from './dto/update-config.dto';

@Injectable()
export class SystemConfigService implements OnModuleInit {
  private configCache: Map<string, any> = new Map();

  constructor(
    @InjectRepository(SystemConfig)
    private configRepository: Repository<SystemConfig>,
  ) {}

  async onModuleInit() {
    await this.seedDefaultConfigs();
    await this.loadConfigsIntoCache();
  }

  /**
   * Seed default configurations if they don't exist
   */
  private async seedDefaultConfigs(): Promise<void> {
    for (const [key, config] of Object.entries(DEFAULT_CONFIG_VALUES)) {
      const existing = await this.configRepository.findOne({ where: { key } });
      if (!existing) {
        await this.configRepository.save({
          key,
          value: config.value,
          description: config.description,
          dataType: config.dataType,
        });
      }
    }
  }

  /**
   * Load all configurations into memory cache
   */
  private async loadConfigsIntoCache(): Promise<void> {
    const configs = await this.configRepository.find();
    for (const config of configs) {
      this.configCache.set(config.key, this.parseValue(config.value, config.dataType));
    }
  }

  /**
   * Get a configuration value by key
   */
  async get<T = any>(key: ConfigKey | string, defaultValue?: T): Promise<T> {
    if (this.configCache.has(key)) {
      return this.configCache.get(key) as T;
    }

    const config = await this.configRepository.findOne({ where: { key } });
    if (!config) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new NotFoundException(`Configuration key '${key}' not found`);
    }

    const parsedValue = this.parseValue(config.value, config.dataType);
    this.configCache.set(key, parsedValue);
    return parsedValue as T;
  }

  /**
   * Get a number configuration value
   */
  async getNumber(key: ConfigKey | string, defaultValue?: number): Promise<number> {
    const value = await this.get(key, defaultValue);
    return Number(value);
  }

  /**
   * Get a boolean configuration value
   */
  async getBoolean(key: ConfigKey | string, defaultValue?: boolean): Promise<boolean> {
    const value = await this.get(key, defaultValue);
    return Boolean(value);
  }

  /**
   * Get a string configuration value
   */
  async getString(key: ConfigKey | string, defaultValue?: string): Promise<string> {
    const value = await this.get(key, defaultValue);
    return String(value);
  }

  /**
   * Get all configurations
   */
  async getAll(): Promise<SystemConfig[]> {
    return this.configRepository.find({
      order: { key: 'ASC' },
    });
  }

  /**
   * Update a configuration value
   */
  async update(key: string, updateDto: UpdateConfigDto): Promise<SystemConfig> {
    let config = await this.configRepository.findOne({ where: { key } });

    if (!config) {
      config = this.configRepository.create(updateDto);
    } else {
      config.value = updateDto.value;
      if (updateDto.description) {
        config.description = updateDto.description;
      }
      config.dataType = updateDto.dataType;
    }

    const saved = await this.configRepository.save(config);

    // Update cache
    this.configCache.set(key, this.parseValue(saved.value, saved.dataType));

    return saved;
  }

  /**
   * Bulk update configurations
   */
  async bulkUpdate(updates: UpdateConfigDto[]): Promise<SystemConfig[]> {
    const results: SystemConfig[] = [];
    for (const update of updates) {
      const result = await this.update(update.key, update);
      results.push(result);
    }
    return results;
  }

  /**
   * Delete a configuration
   */
  async delete(key: string): Promise<void> {
    const config = await this.configRepository.findOne({ where: { key } });
    if (!config) {
      throw new NotFoundException(`Configuration key '${key}' not found`);
    }

    await this.configRepository.remove(config);
    this.configCache.delete(key);
  }

  /**
   * Refresh the configuration cache
   */
  async refreshCache(): Promise<void> {
    this.configCache.clear();
    await this.loadConfigsIntoCache();
  }

  /**
   * Parse configuration value based on data type
   */
  private parseValue(value: string, dataType: string): any {
    switch (dataType) {
      case 'number':
        return parseFloat(value);
      case 'boolean':
        return value === 'true' || value === '1';
      case 'json':
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      default:
        return value;
    }
  }
}
