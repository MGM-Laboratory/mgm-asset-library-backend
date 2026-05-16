import { Global, Module } from '@nestjs/common';
import { JobsProducer } from './jobs.producer';
import { QueueDashboardController } from './queue-dashboard.controller';

/**
 * Producer-side wiring for BullMQ queues. Workers live in
 * `modules/jobs/processors/` and are imported only by `WorkerModule`. API
 * mode also mounts the Bull Board dashboard via `QueueDashboardController`.
 */
@Global()
@Module({
  controllers: [QueueDashboardController],
  providers: [JobsProducer],
  exports: [JobsProducer],
})
export class JobsModule {}
