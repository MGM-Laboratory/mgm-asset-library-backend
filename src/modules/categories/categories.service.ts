import { Injectable } from '@nestjs/common';
import { Category, Locale } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-code';
import { NotFoundDomainException } from '../../common/errors/problem.dto';
import { resolveLocalized, LocalizedJson } from '../../common/i18n/locale-resolver';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { CategoryDto } from './dto/category.dto';

const CACHE_KEY = (locale: Locale) => `categories:list:${locale}`;
const CACHE_TTL_SECONDS = 60;

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async findByIdOrThrow(id: string): Promise<Category> {
    const row = await this.prisma.category.findUnique({ where: { id } });
    if (!row) throw new NotFoundDomainException(ErrorCode.CATEGORY_NOT_FOUND, `Category ${id} not found.`);
    return row;
  }

  /**
   * Lists active categories with per-category `assetCount`. Result is cached
   * in Redis for 60 s (see `invalidateCache` below).
   */
  async list(locale: Locale): Promise<CategoryDto[]> {
    const cached = await this.redis.client.get(CACHE_KEY(locale));
    if (cached) return JSON.parse(cached) as CategoryDto[];

    const rows = await this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    const counts = await this.prisma.asset.groupBy({
      by: ['categoryId'],
      where: { status: 'PUBLISHED' },
      _count: { _all: true },
    });
    const countByCategory = new Map(counts.map((c) => [c.categoryId, c._count._all]));

    const dto: CategoryDto[] = rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: resolveLocalized(row.name as LocalizedJson, locale) ?? row.slug,
      iconKey: row.iconKey ?? undefined,
      sortOrder: row.sortOrder,
      assetCount: countByCategory.get(row.id) ?? 0,
    }));

    await this.redis.client.set(CACHE_KEY(locale), JSON.stringify(dto), 'EX', CACHE_TTL_SECONDS);
    return dto;
  }

  /** Drops the cached listings — call after an asset's category/publish state changes. */
  async invalidateCache(): Promise<void> {
    await Promise.all([this.redis.client.del(CACHE_KEY('en')), this.redis.client.del(CACHE_KEY('id'))]);
  }
}
