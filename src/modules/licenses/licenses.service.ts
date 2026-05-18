import { Injectable } from '@nestjs/common';
import { License, Locale } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-code';
import { NotFoundDomainException } from '../../common/errors/problem.dto';
import { LocalizedJson, resolveLocalized } from '../../common/i18n/locale-resolver';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { LicenseDetailDto, LicenseSummaryDto } from './dto/license.dto';

@Injectable()
export class LicensesService {
  constructor(private readonly prisma: PrismaService) {}

  async findByIdOrThrow(id: string): Promise<License> {
    const row = await this.prisma.license.findUnique({ where: { id } });
    if (!row)
      throw new NotFoundDomainException(ErrorCode.LICENSE_NOT_FOUND, `License ${id} not found.`);
    return row;
  }

  async list(locale: Locale): Promise<LicenseSummaryDto[]> {
    const rows = await this.prisma.license.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return rows.map((row) => this.toSummary(row, locale));
  }

  async getDetail(id: string, locale: Locale): Promise<LicenseDetailDto> {
    const row = await this.findByIdOrThrow(id);
    const summary = this.toSummary(row, locale);
    return {
      ...summary,
      fullText: resolveLocalized(row.fullText as LocalizedJson, locale) ?? '',
    };
  }

  private toSummary(row: License, locale: Locale): LicenseSummaryDto {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: resolveLocalized(row.description as LocalizedJson, locale) ?? '',
      sortOrder: row.sortOrder,
    };
  }
}
