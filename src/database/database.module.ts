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
        const isProd = config.get('NODE_ENV') === 'production';
        // TypeORM's per-query dump (logging: true / !isProd) drowns
        // out app logs and makes real errors hard to find. Default
        // to schema events + slow / failed queries only, which is
        // what you actually want to see day-to-day. Set
        // DB_LOGGING=verbose in the environment when you need the
        // raw query stream back for a debugging session.
        const dbLogging = config.get<string>('DB_LOGGING');
        const verbose = dbLogging === 'verbose' || dbLogging === 'all';
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
          logging: verbose ? 'all' : ['error', 'warn', 'schema', 'migration'],
          // Surface any query taking longer than 500ms as a warning
          // so genuinely slow queries still stand out without the
          // every-query noise.
          maxQueryExecutionTime: 500,
          ssl: isProd ? { rejectUnauthorized: false } : false,
        } as DataSourceOptions;
      },
    }),
  ],
})
export class DatabaseModule {}
