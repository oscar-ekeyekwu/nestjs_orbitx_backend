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
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const configService = app.get(ConfigService);

  // Serve static files from uploads directory
  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
  });

  // Enable CORS for mobile apps and web
  const allowedOrigins = [
    configService.get('FRONTEND_URL') || 'http://localhost:8081',
    configService.get('ADMIN_FRONTEND_URL'),
    'http://localhost:8081', // React Native dev
    'exp://localhost:8081', // Expo dev
    'http://10.0.2.2:8081', // Android emulator
    'http://192.168.*.*:8081', // Local network (React Native)
    'http://localhost:3000',
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

bootstrap();
