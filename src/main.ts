import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  const config = app.get(ConfigService);
  const port = parseInt(config.get<string>('PORT') || '3000', 10);

  app.use(helmet());

  await app.listen(port);
  console.log(`HTTP server listening on http://localhost:${port}`);
}
bootstrap();