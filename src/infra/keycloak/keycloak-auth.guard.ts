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
import { RedisService } from '../redis/redis.service';
import { KeycloakClaims, KeycloakJwksProvider } from './keycloak-jwks.provider';
import { AppRole, RoleResolverService } from './role-resolver.service';

/** User with Date fields flattened to ISO strings for Redis JSON storage. */
type SerializedUser = Omit<User, 'createdAt' | 'updatedAt' | 'deletedAt'> & {
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

function serializeUser(u: User): SerializedUser {
  return {
    ...u,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    deletedAt: u.deletedAt ? u.deletedAt.toISOString() : null,
  };
}

function deserializeUser(u: SerializedUser): User {
  return {
    ...u,
    createdAt: new Date(u.createdAt),
    updatedAt: new Date(u.updatedAt),
    deletedAt: u.deletedAt ? new Date(u.deletedAt) : null,
  };
}

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
// Resolved-principal cache TTL. The token is ALWAYS verified (signature +
// expiry) on every request; this only skips the per-request user upsert +
// role query when we've resolved the same Keycloak subject very recently.
// A role/admin change therefore takes up to this long to take effect.
const PRINCIPAL_CACHE_TTL_SEC = 30;

@Injectable()
export class KeycloakAuthGuard implements CanActivate {
  private readonly logger = new Logger(KeycloakAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwks: KeycloakJwksProvider,
    private readonly prisma: PrismaService,
    private readonly roleResolver: RoleResolverService,
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
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

    const resolved = await this.resolvePrincipal(claims);

    (req as FastifyRequest & { user?: AuthenticatedRequestUser }).user = {
      user: resolved.user,
      role: resolved.role,
      claims,
    };
    return true;
  }

  /**
   * Resolves {user, role} for a verified token. Hot path is the navbar's
   * /auth/me call on every page navigation, so we cache the resolution in
   * Redis (keyed by the Keycloak subject) for a few seconds to avoid an
   * upsert + role query on every single authenticated request. Caching the
   * resolution — not the verification — keeps token expiry strictly enforced.
   */
  private async resolvePrincipal(claims: KeycloakClaims): Promise<{ user: User; role: AppRole }> {
    const cacheKey = `authz:principal:${claims.sub}`;
    try {
      const cached = await this.redis.client.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { user: SerializedUser; role: AppRole };
        return { user: deserializeUser(parsed.user), role: parsed.role };
      }
    } catch {
      /* cache miss / parse error — fall through to the DB */
    }
    const user = await this.upsertUser(claims);
    const role = await this.roleResolver.resolve(user);
    try {
      await this.redis.client.set(
        cacheKey,
        JSON.stringify({ user: serializeUser(user), role }),
        'EX',
        PRINCIPAL_CACHE_TTL_SEC,
      );
    } catch {
      /* non-fatal — caching is best-effort */
    }
    return { user, role };
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
    const displayName = claims.name ?? claims.preferred_username ?? email.split('@')[0];
    const isBootstrapAdmin = email === this.config.get('ADMIN_BOOTSTRAP_EMAIL').toLowerCase();

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
