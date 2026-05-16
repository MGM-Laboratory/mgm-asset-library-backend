import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction } from '../../common/audit/audit-action.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { ErrorCode } from '../../common/errors/error-code';
import { NotFoundDomainException } from '../../common/errors/problem.dto';
import { AdminGuard } from '../../common/guards/admin.guard';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor';
import { resolvePageSize } from '../../common/pagination/list-query.dto';
import { ListQueryDto } from '../../common/pagination/list-query.dto';
import { AuthenticatedRequestUser } from '../../infra/keycloak/keycloak-auth.guard';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { JobsProducer } from '../jobs/jobs.producer';
import { AdminAssetsModerationService } from './assets-moderation.service';

class AvActionBodyDto {
  note?: string;
}

@ApiTags('Admin')
@ApiBearerAuth('keycloak')
@Controller('admin/av')
@UseGuards(AdminGuard)
export class AdminAvQueueController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: JobsProducer,
    private readonly moderation: AdminAssetsModerationService,
    private readonly audit: AuditService,
  ) {}

  @Get('infected')
  @ApiOperation({ summary: 'List versions whose AV scanner flagged a file.' })
  @ApiOkResponse()
  async list(@Query() query: ListQueryDto) {
    const limit = resolvePageSize(query.limit);
    const cursor = decodeCursor(query.cursor ?? null);
    const rows = await this.prisma.assetVersion.findMany({
      where: { avStatus: 'INFECTED' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor.id } } : {}),
      include: {
        asset: { include: { owner: true } },
        files: true,
      },
    });
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    return {
      items: slice.map((v) => ({
        versionId: v.id,
        semver: v.semver,
        asset: { id: v.asset.id, slug: v.asset.slug, title: v.asset.title, status: v.asset.status },
        owner: { id: v.asset.owner.id, displayName: v.asset.owner.displayName, email: v.asset.owner.email },
        infectedFiles: v.files
          .filter((f) => {
            const meta = (f.meta as Record<string, unknown> | null) ?? {};
            const av = meta.avResult as { status?: string } | undefined;
            return av?.status === 'FOUND';
          })
          .map((f) => {
            const meta = (f.meta as Record<string, unknown> | null) ?? {};
            const av = meta.avResult as { status?: string; signature?: string } | undefined;
            return { id: f.id, relativePath: f.relativePath, signature: av?.signature };
          }),
        scannedAt: v.updatedAt.toISOString(),
      })),
      pageInfo: {
        nextCursor:
          hasMore && slice.length
            ? encodeCursor({ id: slice[slice.length - 1].id, createdAt: slice[slice.length - 1].createdAt.toISOString() })
            : null,
        hasMore,
      },
    };
  }

  @Post(':versionId/quarantine')
  @AuditAction({ action: 'av.quarantine_request', subjectType: 'AssetVersion', subjectParam: 'params.versionId' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive the parent asset with reason = "AV quarantine".' })
  async quarantine(
    @AuthUser() principal: AuthenticatedRequestUser,
    @Param('versionId') versionId: string,
    @Body() _dto: AvActionBodyDto,
  ): Promise<void> {
    const version = await this.prisma.assetVersion.findUnique({
      where: { id: versionId },
      select: { assetId: true },
    });
    if (!version) throw new NotFoundDomainException(ErrorCode.VERSION_NOT_FOUND, `Version ${versionId} not found.`);
    await this.moderation.archive(version.assetId, principal.user, 'AV quarantine');
  }

  @Post(':versionId/acknowledge')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark a false positive — flips avStatus back to CLEAN.' })
  async acknowledge(
    @AuthUser() principal: AuthenticatedRequestUser,
    @Param('versionId') versionId: string,
    @Body() dto: AvActionBodyDto,
  ): Promise<void> {
    const version = await this.prisma.assetVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundDomainException(ErrorCode.VERSION_NOT_FOUND, `Version ${versionId} not found.`);
    await this.prisma.assetVersion.update({ where: { id: versionId }, data: { avStatus: 'CLEAN' } });
    await this.audit.record({
      actorId: principal.user.id,
      action: 'av.acknowledge',
      subjectType: 'AssetVersion',
      subjectId: versionId,
      metadata: { note: dto.note, assetId: version.assetId },
    });
  }

  @Post(':versionId/rescan')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Re-enqueue an AV scan for every file in this version.' })
  async rescan(
    @AuthUser() principal: AuthenticatedRequestUser,
    @Param('versionId') versionId: string,
  ): Promise<void> {
    const version = await this.prisma.assetVersion.findUnique({
      where: { id: versionId },
      include: { files: true },
    });
    if (!version) throw new NotFoundDomainException(ErrorCode.VERSION_NOT_FOUND, `Version ${versionId} not found.`);
    if (version.files.length === 0) return;
    await this.prisma.assetVersion.update({ where: { id: versionId }, data: { avStatus: 'PENDING' } });
    await Promise.all(
      version.files.map((f) => this.producer.enqueueAvScanFile({ versionId, fileId: f.id })),
    );
    await this.audit.record({
      actorId: principal.user.id,
      action: 'av.rescan',
      subjectType: 'AssetVersion',
      subjectId: versionId,
    });
  }
}
