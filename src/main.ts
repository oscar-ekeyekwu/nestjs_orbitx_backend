import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  const configService = app.get(ConfigService);

  // Serve static files from uploads directory
  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
  });

  // Enable CORS for mobile apps and web.
  //
  // Origins are sourced from env where possible — hardcoded localhost ports
  // only stay in the list as developer-convenience defaults. To add or
  // change an origin without touching code, set CORS_ALLOWED_ORIGINS as a
  // comma-separated list in the backend .env, e.g.:
  //   CORS_ALLOWED_ORIGINS=https://admin.orbitx.app,https://app.orbitx.app
  //
  // Mobile apps (React Native / Expo) ship requests with no Origin header,
  // so they're allowed unconditionally below — this list is for browsers.
  const envOrigins =
    configService
      .get<string>('CORS_ALLOWED_ORIGINS')
      ?.split(',')
      .map((o) => o.trim())
      .filter(Boolean) ?? [];

  const allowedOrigins = [
    configService.get<string>('FRONTEND_URL') || 'http://localhost:8081',
    configService.get<string>('ADMIN_FRONTEND_URL'),
    ...envOrigins,
    // Local dev convenience defaults — safe because they cannot reach prod.
    'http://localhost:8081', // React Native dev
    'exp://localhost:8081', // Expo dev
    'http://10.0.2.2:8081', // Android emulator
    'http://192.168.*.*:8081', // Local LAN (physical device on dev network)
    'http://localhost:3000', // Admin Vite dev server
    'http://localhost:4100',
    'http://localhost:8000',
  ].filter(Boolean) as string[];

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      // Check if origin matches allowed patterns
      const isAllowed = allowedOrigins.some((allowedOrigin) => {
        if (allowedOrigin.includes('*')) {
          const regex = new RegExp(
            '^' + allowedOrigin.replace(/\*/g, '.*') + '$',
          );
          return regex.test(origin);
        }
        return allowedOrigin === origin;
      });

      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'User-Agent',
    ],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 3600,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global prefix with versioning
  app.setGlobalPrefix('api/v1');

  // ✅ Global interceptor for success responses
  app.useGlobalInterceptors(new ResponseInterceptor());

  // ✅ Global filter for errors
  app.useGlobalFilters(new AllExceptionsFilter());

  // --- Swagger Config ---
  const config = new DocumentBuilder()
    .setTitle('OrbitX Dispatch API')
    .setDescription('API documentation for the OrbitX Dispatch Application')
    .setVersion('1.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      in: 'header',
      name: 'Authorization',
      description: 'Enter your JWT token in the format: Bearer <token>',
    }) // Enables JWT authentication header support
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true, // Keep JWT auth after reload
    },
  });

  const port = (configService.get('PORT') as number) || 3000;
  const IP = (configService.get('IP') as string) || '0.0.0.0';
  await app.listen(port, IP);

  console.log(`🚀 Application is running on: http://localhost:${port}/api/v1`);
  console.log(
    `📚 Swagger docs available at: http://localhost:${port}/api/v1/docs`,
  );
}

void bootstrap();
