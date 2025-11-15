import { Module } from '@nestjs/common';
import { CaptureService } from './capture.service';

@Module({
  providers: [CaptureService],
  exports: [CaptureService],
})
export class CaptureModule {}

