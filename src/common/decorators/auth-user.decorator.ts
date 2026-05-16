import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthenticatedRequestUser } from '../../infra/keycloak/keycloak-auth.guard';

/**
 * Resolves the authenticated principal attached by `KeycloakAuthGuard`.
 * Throws when used on a public endpoint to keep call sites honest.
 */
export const AuthUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedRequestUser => {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedRequestUser }>();
    if (!req.user) {
      throw new Error(
        '@AuthUser() used on an endpoint without KeycloakAuthGuard — did you forget @Public()?',
      );
    }
    return req.user;
  },
);
