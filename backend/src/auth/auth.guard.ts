import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, AuthUser } from './auth.service';

export const SESSION_COOKIE = 'sid';

const IS_PUBLIC = 'isPublic';
/** Помечает обработчик, доступный без входа (логин, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Достаёт пользователя, которого положил в запрос AuthGuard. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    // Токен — шестнадцатеричная строка, раскодировать нечего. Мусор в cookie просто не найдётся в базе.
    if (key === name) return rest.join('=');
  }
  return null;
}

/**
 * Глобальный охранник: закрыто всё, что явно не помечено @Public().
 * Новый обработчик нельзя случайно оставить открытым.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const request = ctx.switchToHttp().getRequest();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const user = token ? await this.auth.userByToken(token) : null;
    if (!user) throw new UnauthorizedException('Требуется вход');
    request.user = user;
    return true;
  }
}
