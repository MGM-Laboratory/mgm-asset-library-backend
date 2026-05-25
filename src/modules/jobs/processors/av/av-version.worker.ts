import { Injectable } from '@nestjs/common';
import { AvStatus, NotificationType } from '@prisma/client';
import { Job } from 'bullmq';
import { AppConfigService } from '../../../../config/app-config.service';
import { PrismaService } from '../../../../infra/prisma/prisma.service';
import { SentryService } from '../../../../infra/sentry/sentry.service';
import { AvScanVersionJob } from '../../contracts';
import { JobsProducer } from '../../jobs.producer';
import { QUEUE } from '../../queue-names';
import { JobWorkerBase } from '../../worker-base';

/**
 * Per-version AV rollup. Determines the overall verdict, persists it, and
 * fans out the owner-warning / admin-alert notifications if any file landed
 * as INFECTED. Asset is *not* auto-removed per spec.
 */
@Injectable()
export class AvVersionWorker extends JobWorkerBase<AvScanVersionJob> {
  constructor(
    config: AppConfigService,
    sentry: SentryService,
    private readonly prisma: PrismaService,
    private readonly producer: JobsProducer,
  ) {
    super(QUEUE.AV_SCAN_VERSION, config, sentry);
  }

  async process(job: Job<AvScanVersionJob>): Promise<void> {
    const { versionId } = job.data;
    const version = await this.prisma.assetVersion.findUnique({
      where: { id: versionId },
      include: { files: true, asset: { include: { owner: true } } },
    });
    if (!version) return;

    const fileVerdicts = version.files.map((f) => {
      const meta = (f.meta as Record<string, unknown> | null) ?? {};
      return {
        path: f.relativePath,
        result: meta.avResult as
          | {
              status: 'OK' | 'FOUND' | 'ERROR' | 'SKIPPED';
              signature?: string;
              message?: string;
              skipReason?: string;
            }
          | undefined,
      };
    });

    const infected = fileVerdicts.filter((v) => v.result?.status === 'FOUND');
    const errored = fileVerdicts.filter((v) => v.result?.status === 'ERROR');
    const skipped = fileVerdicts.filter((v) => v.result?.status === 'SKIPPED');
    const cleanish = fileVerdicts.filter((v) => v.result?.status === 'OK');
    let avStatus: AvStatus;
    if (infected.length > 0) avStatus = AvStatus.INFECTED;
    else if (errored.length > 0) avStatus = AvStatus.ERROR;
    // If every non-skipped file is clean and at least one file was skipped for
    // size, mark the version SKIPPED_SIZE so the UI explains why no scan ran.
    else if (skipped.length > 0 && cleanish.length === 0) avStatus = AvStatus.SKIPPED_SIZE;
    else avStatus = AvStatus.CLEAN;

    await this.prisma.assetVersion.update({
      where: { id: versionId },
      data: { avStatus },
    });

    if (avStatus === AvStatus.INFECTED) {
      const payload = {
        assetId: version.asset.id,
        assetSlug: version.asset.slug,
        assetTitle: version.asset.title,
        versionId,
        affectedFilePaths: infected.map((i) => i.path),
      };
      // Owner gets a warning.
      await this.producer.enqueueNotify({
        recipientUserId: version.asset.ownerId,
        type: NotificationType.AV_INFECTED_WARNING,
        payload,
      });
      // All admins get the alert.
      const admins = await this.prisma.user.findMany({
        where: { isAdmin: true, deletedAt: null },
        select: { id: true },
      });
      await Promise.all(
        admins.map((a) =>
          this.producer.enqueueNotify({
            recipientUserId: a.id,
            type: NotificationType.AV_INFECTED_ADMIN_ALERT,
            payload: {
              ...payload,
              owner: {
                id: version.asset.owner.id,
                displayName: version.asset.owner.displayName,
                email: version.asset.owner.email,
              },
            },
          }),
        ),
      );
    } else if (avStatus === AvStatus.ERROR) {
      // Quietly notify admins only — owner doesn't need to see scanner errors.
      const admins = await this.prisma.user.findMany({
        where: { isAdmin: true, deletedAt: null },
        select: { id: true },
      });
      await Promise.all(
        admins.map((a) =>
          this.producer.enqueueNotify({
            recipientUserId: a.id,
            type: NotificationType.AV_INFECTED_ADMIN_ALERT,
            payload: {
              assetId: version.asset.id,
              assetSlug: version.asset.slug,
              assetTitle: version.asset.title,
              versionId,
              affectedFilePaths: errored.map((e) => e.path),
              owner: {
                id: version.asset.owner.id,
                displayName: version.asset.owner.displayName,
                email: version.asset.owner.email,
              },
            },
          }),
        ),
      );
    }
  }
}
