import { ForbiddenException, Injectable } from '@nestjs/common';
import { SESSION_TTL_MS } from '../config';
import { PrismaService } from '../prisma.service';
import { hashToken, newSessionToken, verifyPassword } from './password';

export type SpaceAccess = {
  spaceId: string;
  spaceName: string;
  canInitiate: boolean;
  canApprove: boolean;
};

/** Пользователь запроса. Собирается только из базы по сессии, никогда из тела запроса. */
export type AuthUser = {
  id: string;
  email: string;
  name: string;
  memberships: SpaceAccess[];
};

/** Доступ к пространству или 403. Единая точка проверки изоляции пространств. */
export function requireSpace(user: AuthUser, spaceId: string): SpaceAccess {
  const access = user.memberships.find((m) => m.spaceId === spaceId);
  if (!access) throw new ForbiddenException('Нет доступа к этому пространству');
  return access;
}

const userInclude = { memberships: { include: { space: true } } } as const;

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(email: string, password: string): Promise<{ token: string; user: AuthUser } | null> {
    const user = await this.prisma.user.findUnique({ where: { email }, include: userInclude });
    if (!user || !verifyPassword(password, user.passwordHash)) return null;
    const token = newSessionToken();
    await this.prisma.session.create({
      data: {
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return { token, user: toAuthUser(user) };
  }

  async userByToken(token: string): Promise<AuthUser | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { include: userInclude } },
    });
    if (!session || session.expiresAt < new Date()) return null;
    return toAuthUser(session.user);
  }

  async logout(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
}

function toAuthUser(user: {
  id: string;
  email: string;
  name: string;
  memberships: {
    spaceId: string;
    canInitiate: boolean;
    canApprove: boolean;
    space: { name: string };
  }[];
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    memberships: user.memberships.map((m) => ({
      spaceId: m.spaceId,
      spaceName: m.space.name,
      canInitiate: m.canInitiate,
      canApprove: m.canApprove,
    })),
  };
}
