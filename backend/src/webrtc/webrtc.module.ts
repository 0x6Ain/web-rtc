import { Module } from '@nestjs/common';
import { WebrtcService } from './webrtc.service';
import { CaptureModule } from '../capture/capture.module';

@Module({
  imports: [CaptureModule],
  providers: [WebrtcService],
  exports: [WebrtcService],
})
export class WebrtcModule {}

