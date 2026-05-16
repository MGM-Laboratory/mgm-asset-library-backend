import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Locale, User } from '@prisma/client';
import { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakClaims, KeycloakJwksProvider } from './keycloak-jwks.provider';
import { AppRole, RoleResolverService } from './role-resolver.service';

export interface AuthenticatedRequestUser {
  user: User;
  role: AppRole;
  claims: KeycloakClaims;
}

/**
 * Verifies the `Authorization: Bearer <token>` header against Keycloak's JWKS,
 * upserts the local `User` row, resolves the effective application role, and
 * attaches everything to `request.user`.
 *
 * Endpoints decorated with `@Public()` bypass verification entirely.
 */
@Injectable()
export class KeycloakAuthGuard implements CanActivate {
  private readonly logger = new Logger(KeycloakAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwks: KeycloakJwksProvider,
    private readonly prisma: PrismaService,
    private readonly roleResolver: RoleResolverService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const token = this.extractBearer(req);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    let claims: KeycloakClaims;
    try {
      claims = await this.jwks.verify(token);
    } catch (err) {
      this.logger.debug(`Token verification failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid or expired token.');
    }

    const user = await this.upsertUser(claims);
    const role = await this.roleResolver.resolve(user);

    (req as FastifyRequest & { user?: AuthenticatedRequestUser }).user = {
      user,
      role,
      claims,
    };
    return true;
  }

  private extractBearer(req: FastifyRequest): string | null {
    const raw = req.headers.authorization;
    if (!raw) return null;
    const [scheme, value] = raw.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
    return value.trim();
  }

  /**
   * First-sight upsert of the application's User row. Bootstraps the admin
   * flag when the email matches `ADMIN_BOOTSTRAP_EMAIL`; otherwise leaves the
   * stored `isAdmin` value untouched on subsequent logins.
   */
  private async upsertUser(claims: KeycloakClaims): Promise<User> {
    const email = (claims.email ?? '').toLowerCase();
    if (!email) {
      throw new UnauthorizedException('Keycloak token has no email claim.');
    }
    const displayName =
      claims.name ?? claims.preferred_username ?? email.split('@')[0];
    const isBootstrapAdmin =
      email === this.config.get('ADMIN_BOOTSTRAP_EMAIL').toLowerCase();

    return this.prisma.user.upsert({
      where: { keycloakSub: claims.sub },
      create: {
        keycloakSub: claims.sub,
        email,
        displayName,
        locale: Locale.en,
        isAdmin: isBootstrapAdmin,
      },
      update: {
        email,
        displayName,
        ...(isBootstrapAdmin ? { isAdmin: true } : {}),
      },
    });
  }
}
