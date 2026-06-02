import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import {
  changePasswordSchema,
  loginSchema,
  type ChangePasswordInput,
  type LoginInput,
  type MeResponse,
} from '@app/shared';
import type { Env } from '../../config/env.schema';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, REFRESH_COOKIE_NAME } from './auth.constants';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CsrfGuard } from './guards/csrf.guard';
import type { AuthPrincipal } from '../../common/types/request.types';
import { UnauthorizedError } from '../../common/errors/domain.error';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Strict per-IP limit on the unauthenticated, argon2-heavy login path to
  // blunt brute-force / credential-stuffing and CPU-exhaustion attempts.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodPipe(loginSchema))
  async login(
    @Body() body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const { user, tokens } = await this.auth.login(body.email, body.password, {
      userAgent: req.headers['user-agent'] ?? undefined,
      ipAddress: req.ip,
    });

    this.setAuthCookies(res, tokens);
    return mapToMeResponse(user);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const refresh = (req as Request & { cookies?: Record<string, string> }).cookies?.[
      REFRESH_COOKIE_NAME
    ];
    if (!refresh) {
      res.clearCookie(ACCESS_COOKIE_NAME);
      res.clearCookie(REFRESH_COOKIE_NAME);
      res.clearCookie(CSRF_COOKIE_NAME);
      throw new UnauthorizedError();
    }
    const { user, tokens } = await this.auth.refresh(refresh, {
      userAgent: req.headers['user-agent'] ?? undefined,
      ipAddress: req.ip,
    });
    this.setAuthCookies(res, tokens);
    return mapToMeResponse(user);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const refresh =
      (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE_NAME] ??
      null;
    await this.auth.logout(refresh);
    this.clearAuthCookies(res);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() principal: AuthPrincipal): Promise<MeResponse> {
    const user = await this.auth.me(principal.userId);
    return mapToMeResponse(user);
  }

  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @Body(new ZodPipe(changePasswordSchema)) body: ChangePasswordInput,
    @CurrentUser() principal: AuthPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.changePassword(principal.userId, body);
    // The change revoked refresh tokens; clear the current ones so the
    // browser is forced through login again with the new password.
    this.clearAuthCookies(res);
  }

  /**
   * Issue a CSRF token cookie. The web app reads this cookie (which is
   * not httpOnly) and echoes the value back in the x-csrf-token header
   * on every mutating request.
   */
  @Public()
  @Get('csrf')
  csrf(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false,
      secure: this.config.get('COOKIE_SECURE', { infer: true }),
      sameSite: 'lax',
      domain: this.config.get('COOKIE_DOMAIN', { infer: true }),
      path: '/',
      maxAge: 24 * 3600 * 1000,
    });
    return { csrfToken: token };
  }

  private setAuthCookies(
    res: Response,
    tokens: {
      accessToken: string;
      refreshToken: string;
      accessTtlSec: number;
      refreshTtlSec: number;
    },
  ): void {
    const secure = this.config.get('COOKIE_SECURE', { infer: true });
    const domain = this.config.get('COOKIE_DOMAIN', { infer: true });
    const common = {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      domain,
      path: '/',
    };
    res.cookie(ACCESS_COOKIE_NAME, tokens.accessToken, {
      ...common,
      maxAge: tokens.accessTtlSec * 1000,
    });
    res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
      ...common,
      maxAge: tokens.refreshTtlSec * 1000,
    });
    // (Re-)issue a CSRF token so the web client can immediately call protected routes.
    const csrf = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE_NAME, csrf, {
      ...common,
      httpOnly: false,
      maxAge: tokens.refreshTtlSec * 1000,
    });
  }

  private clearAuthCookies(res: Response): void {
    const domain = this.config.get('COOKIE_DOMAIN', { infer: true });
    res.clearCookie(ACCESS_COOKIE_NAME, { domain, path: '/' });
    res.clearCookie(REFRESH_COOKIE_NAME, { domain, path: '/' });
    res.clearCookie(CSRF_COOKIE_NAME, { domain, path: '/' });
  }
}

function mapToMeResponse(user: {
  id: string;
  email: string;
  role: MeResponse['role'];
  companyId: string | null;
  mustChangePassword: boolean;
}): MeResponse {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: 'ACTIVE',
    companyId: user.companyId,
    mustChangePassword: user.mustChangePassword,
  };
}
