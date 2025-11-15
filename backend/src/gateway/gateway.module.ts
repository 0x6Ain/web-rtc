import { Module } from '@nestjs/common';
import { SignalingGateway } from './signaling.gateway';
import { WebrtcModule } from '../webrtc/webrtc.module';

@Module({
  imports: [WebrtcModule],
  providers: [SignalingGateway],
  exports: [SignalingGateway],
})
export class GatewayModule {}

