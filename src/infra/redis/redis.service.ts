import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Single Redis client shared by BullMQ producers and any ad-hoc cache use.
 * Workers in Part 3 will instantiate their own connections from REDIS_URL.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public readonly client: Redis;

  constructor(config: AppConfigService) {
    this.client = new Redis(config.get('REDIS_URL'), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log('Connected to Redis.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch (err) {
      this.logger.error('Redis ping failed', err as Error);
      return false;
    }
  }
}
