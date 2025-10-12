import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DataSourceOptions } from 'typeorm';
import * as path from 'path';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        console.log(config);
        const isProd = config.get('NODE_ENV') === 'production';
        return {
          type: 'postgres',
          host: config.get<string>('DB_HOST'),
          port: config.get<number>('DB_PORT'),
          username: config.get<string>('DB_USERNAME'),
          password: config.get<string>('DB_PASSWORD'),
          database: config.get<string>('DB_NAME'),
          synchronize: false, // use migrations instead
          entities: [path.join(__dirname, '/../**/*.entity.{ts,js}')],
          migrations: [
            path.join(__dirname, '/../database/migrations/*.{ts,js}'),
          ],
          migrationsRun: false, // auto-run migrations on startup
          logging: !isProd,
          ssl: isProd ? { rejectUnauthorized: false } : false,
        } as DataSourceOptions;
      },
    }),
  ],
})
export class DatabaseModule {}
