import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { AppConfigService } from '../../../../config/app-config.service';
import { PrismaService } from '../../../../infra/prisma/prisma.service';
import { RedisService } from '../../../../infra/redis/redis.service';
import { S3Service } from '../../../../infra/s3/s3.service';
import { SentryService } from '../../../../infra/sentry/sentry.service';
import { AvScanFileJob } from '../../contracts';
import { JobsProducer } from '../../jobs.producer';
import { QUEUE } from '../../queue-names';
import { JobWorkerBase } from '../../worker-base';
import { ClamdClient } from './clamd-client';

const FAN_IN_KEY = (versionId: string) => `av:version:${versionId}:remaining`;

/**
 * Per-file AV scan. Updates `AssetFile.meta.avResult`; decrements the
 * per-version fan-in counter and triggers the rollup when it hits zero.
 */
@Injectable()
export class AvWorker extends JobWorkerBase<AvScanFileJob> {
  private readonly clamd: ClamdClient;

  constructor(
    config: AppConfigService,
    sentry: SentryService,
    s3: S3Service,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly producer: JobsProducer,
  ) {
    super(QUEUE.AV_SCAN, config, sentry);
    this.clamd = new ClamdClient(s3, {
      host: config.get('CLAMD_HOST'),
      port: config.get('CLAMD_PORT'),
      timeoutMs: config.get('CLAMD_TIMEOUT_MS'),
      maxStreamBytes: config.get('CLAMD_MAX_STREAM_BYTES'),
    });
  }

  async process(job: Job<AvScanFileJob>): Promise<void> {
    const { versionId, fileId } = job.data;
    const file = await this.prisma.assetFile.findUnique({ where: { id: fileId } });
    if (!file || file.versionId !== versionId) {
      this.logger.warn(`AV: file ${fileId} missing or moved — dropping.`);
      return;
    }
    const result = await this.clamd.scanS3Object('assets', file.s3Key);

    const existingMeta = (file.meta as Record<string, unknown> | null) ?? {};
    await this.prisma.assetFile.update({
      where: { id: fileId },
      data: {
        meta: {
          ...existingMeta,
          avResult: {
            status: result.status,
            signature: result.status === 'FOUND' ? result.signature : undefined,
            message: result.status === 'ERROR' ? result.message : undefined,
            scannedAt: new Date().toISOString(),
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const remaining = await this.redis.client.decr(FAN_IN_KEY(versionId));
    if (remaining <= 0) {
      await this.redis.client.del(FAN_IN_KEY(versionId));
      await this.producer.enqueueAvScanVersion({ versionId });
    }
  }
}
