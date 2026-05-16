import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TagDto } from './dto/tag.dto';

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Normalise a free-form display name into a slug. */
  toSlug(displayName: string): string {
    return displayName
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 50);
  }

  /**
   * Autocomplete during publish: prefix match on slug or displayName, ranked
   * by current usage count. Limit hard-capped at 20 to keep responses small.
   */
  async autocomplete(q: string, limit: number): Promise<TagDto[]> {
    const needle = q.trim();
    if (!needle) return [];
    const cappedLimit = Math.min(Math.max(limit, 1), 20);
    const where: Prisma.TagWhereInput = {
      OR: [
        { slug: { startsWith: needle.toLowerCase() } },
        { displayName: { contains: needle, mode: 'insensitive' } },
      ],
    };
    const tags = await this.prisma.tag.findMany({
      where,
      take: cappedLimit,
      include: { _count: { select: { assets: true } } },
      orderBy: [{ assets: { _count: 'desc' } }, { displayName: 'asc' }],
    });
    return tags.map((t) => ({
      id: t.id,
      slug: t.slug,
      displayName: t.displayName,
      usageCount: t._count.assets,
    }));
  }

  /** Upserts a set of display names into Tag rows, returning the persisted rows. */
  async upsertMany(displayNames: string[], tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    const unique = Array.from(new Set(displayNames.map((d) => d.trim()).filter(Boolean)));
    return Promise.all(
      unique.map((displayName) => {
        const slug = this.toSlug(displayName);
        return client.tag.upsert({
          where: { slug },
          create: { slug, displayName },
          update: { displayName },
        });
      }),
    );
  }
}
