import { Module } from '@nestjs/common';
import { GatewayModule } from './gateway/gateway.module';
import { WebrtcModule } from './webrtc/webrtc.module';
import { CaptureModule } from './capture/capture.module';
import { AppController } from './app.controller';

@Module({
  imports: [GatewayModule, WebrtcModule, CaptureModule],
  controllers: [AppController],
})
export class AppModule {}

