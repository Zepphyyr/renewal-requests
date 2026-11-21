import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.service';
import { RequestsService } from './requests.service';

@Controller()
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get('spaces/:spaceId/requests')
  list(@CurrentUser() user: AuthUser, @Param('spaceId') spaceId: string) {
    return this.requests.listForSpace(user, spaceId);
  }

  @Get('requests/:id')
  getOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.getOne(user, id);
  }

  // В теле только id ресурса. Автор, пространство, сумма и даты определяются сервером.
  @Post('requests')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const resourceId = (body as Record<string, unknown> | null)?.resourceId;
    if (typeof resourceId !== 'string' || !resourceId.trim() || resourceId.length > 255) {
      throw new BadRequestException('Укажите resourceId');
    }
    return this.requests.create(user, resourceId);
  }

  @Post('requests/:id/approve')
  @HttpCode(200)
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.approve(user, id);
  }

  @Post('requests/:id/reject')
  @HttpCode(200)
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.reject(user, id);
  }

  @Post('requests/:id/retry')
  @HttpCode(200)
  retry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.retry(user, id);
  }
}
