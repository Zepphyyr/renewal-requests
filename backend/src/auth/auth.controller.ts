import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SESSION_TTL_MS } from '../config';
import { CurrentUser, Public, readCookie, SESSION_COOKIE } from './auth.guard';
import { AuthService, AuthUser } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, password } = (body ?? {}) as Record<string, unknown>;
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      throw new BadRequestException('Укажите email и пароль');
    }
    const result = await this.auth.login(email.trim().toLowerCase(), password);
    if (!result) throw new UnauthorizedException('Неверный email или пароль');
    // httpOnly: скрипт страницы не может прочитать токен. sameSite=lax: чужой сайт
    // не отправит cookie с POST-запросом. secure не ставим: приложение локальное, без HTTPS.
    res.cookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
    return result.user;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) await this.auth.logout(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
