import { Controller, ForbiddenException, Get, Query, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthenticatedRequestUser, KeycloakAuthGuard } from '../../infra/keycloak/keycloak-auth.guard';
import { WebhookDelivery } from '../jobs/processors/webhook/webhook-delivery.schema';

interface WebhookDeliveryDto {
  deliveryId: string;
  event: string;
  attempt: number;
  status: 'queued' | 'success' | 'failure';
  httpStatus?: number;
  durationMs?: number;
  error?: string;
  responseBody?: string;
  createdAt: string;
}

@ApiTags('Admin')
@ApiBearerAuth('keycloak')
@Controller('admin/webhook-deliveries')
@UseGuards(KeycloakAuthGuard)
export class WebhookDeliveriesController {
  constructor(@InjectModel(WebhookDelivery.name) private readonly model: Model<WebhookDelivery>) {}

  @Get()
  @ApiOperation({ summary: 'Recent n8n webhook delivery attempts (admin only).' })
  @ApiQuery({ name: 'status', required: false, enum: ['success', 'failure'] })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse()
  async list(
    @AuthUser() principal: AuthenticatedRequestUser,
    @Query('status') status?: 'success' | 'failure',
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ): Promise<WebhookDeliveryDto[]> {
    if (!principal.user.isAdmin) throw new ForbiddenException('Admins only.');
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (type) where.event = type;
    const take = Math.min(Math.max(Number(limit ?? '50'), 1), 200);
    const rows = await this.model
      .find(where)
      .sort({ createdAt: -1 })
      .limit(take)
      .lean()
      .exec();
    return rows.map((r) => ({
      deliveryId: r.deliveryId,
      event: r.event,
      attempt: r.attempt,
      status: r.status,
      httpStatus: r.httpStatus,
      durationMs: r.durationMs,
      error: r.error,
      responseBody: r.responseBody,
      createdAt: (r.createdAt as Date).toISOString(),
    }));
  }
}
