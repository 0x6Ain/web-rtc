import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // CORS 설정 (프론트엔드와 통신을 위해)
  // 개발 환경에서는 모든 origin 허용 (다른 와이파이에서 접근 가능하도록)
  const isDevelopment = true
  app.enableCors({
    origin: isDevelopment 
      ? true 
      : [
          'http://localhost:5173',
          'http://localhost:5000',
          'http://localhost:5200',
          'http://127.0.0.1:5173',
          'http://127.0.0.1:5000',
          'http://127.0.0.1:5200',
          'https://gina-nonconfiscable-monodically.ngrok-free.dev'
        ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // 0.0.0.0에 바인딩하여 모든 네트워크 인터페이스에서 접근 가능하게 설정
  await app.listen(3000, '0.0.0.0');
  console.log('백엔드 서버가 포트 3000에서 실행 중입니다.');
  console.log('로컬 접속: http://localhost:3000');
  console.log('네트워크 접속: http://<로컬IP>:3000');
}
bootstrap();

