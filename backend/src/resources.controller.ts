import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { CurrentUser, Public } from './auth/auth.guard';
import { AuthUser, requireSpace } from './auth/auth.service';
import { toDateString } from './dates';
import { PrismaService } from './prisma.service';

const ACTIVE_STATUSES = ['pending', 'executing', 'needs_attention'] as const;

@Controller()
export class ResourcesController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('spaces/:spaceId/resources')
  async list(@CurrentUser() user: AuthUser, @Param('spaceId') spaceId: string) {
    requireSpace(user, spaceId);
    const resources = await this.prisma.resource.findMany({
      where: { spaceId },
      orderBy: { id: 'asc' },
      include: {
        requests: { where: { status: { in: [...ACTIVE_STATUSES] } }, select: { id: true, status: true } },
      },
    });
    return resources.map((resource) => ({
      ...toResourceView(resource),
      activeRequest: resource.requests[0] ?? null,
    }));
  }

  /** Ресурс с текущим сроком и историей его заявок. */
  @Get('resources/:id')
  async getOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id },
      include: {
        requests: {
          orderBy: { createdAt: 'desc' },
          include: { createdBy: { select: { name: true } }, decidedBy: { select: { name: true } } },
        },
      },
    });
    if (!resource) throw new NotFoundException('Ресурс не найден');
    requireSpace(user, resource.spaceId);
    return {
      ...toResourceView(resource),
      requests: resource.requests.map((request) => ({
        id: request.id,
        status: request.status,
        createdBy: request.createdBy.name,
        decidedBy: request.decidedBy?.name ?? null,
        amountMinor: request.amountMinor,
        currency: request.currency,
        oldExpiresOn: toDateString(request.oldExpiresOn),
        newExpiresOn: toDateString(request.newExpiresOn),
        createdAt: request.createdAt.toISOString(),
      })),
    };
  }
}

function toResourceView(resource: {
  id: string;
  spaceId: string;
  name: string;
  expiresOn: Date;
  priceMinor: number;
  currency: string;
}) {
  return {
    id: resource.id,
    spaceId: resource.spaceId,
    name: resource.name,
    expiresOn: toDateString(resource.expiresOn),
    priceMinor: resource.priceMinor,
    currency: resource.currency,
  };
}
