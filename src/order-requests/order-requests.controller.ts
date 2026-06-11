import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { OrderRequestsService } from './order-requests.service';
import { CreateOrderRequestDto } from './dto/create-order-request.dto';
import { SubmitOfferDto } from './dto/submit-offer.dto';

@ApiTags('OrderRequests')
@ApiBearerAuth()
@Controller('order-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrderRequestsController {
  constructor(private readonly service: OrderRequestsService) {}

  @Post()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary:
      'Open a dispatch request (Customer only). Replaces direct order creation — drivers respond with offers, then customer picks.',
  })
  create(@Body() dto: CreateOrderRequestDto, @CurrentUser() user: User) {
    return this.service.create(dto, user.id);
  }

  // Placed BEFORE @Get(':id') so the static `admin/open` segment
  // takes precedence over the :id parameterized route.
  @Get('admin/open')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Admin Live-Requests view — open requests with pending-offer counts. Polled by the dispatcher UI.',
  })
  findOpenForAdmin() {
    return this.service.findOpenForAdmin();
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Read a single request. Customer owner, admin, and drivers who have offered are allowed.',
  })
  findOne(@Param('id') id: string, @CurrentUser() user: User) {
    return this.service.findOneScoped(id, user.id, user.role);
  }

  @Get(':id/offers')
  @ApiOperation({
    summary:
      'List offers on a request. Same scoping as the request read endpoint.',
  })
  findOffers(@Param('id') id: string, @CurrentUser() user: User) {
    return this.service.findOffers(id, user.id, user.role);
  }

  @Post(':id/offers')
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary:
      'Driver submits an offer — quote_accept (auto-wins) or counter (queued).',
  })
  submitOffer(
    @Param('id') id: string,
    @Body() dto: SubmitOfferDto,
    @CurrentUser() user: User,
  ) {
    return this.service.submitOffer(id, user.id, dto);
  }

  @Post(':id/offers/:offerId/accept')
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary:
      'Customer picks a counter offer. Creates an Order with the offer’s price and driver.',
  })
  acceptOffer(
    @Param('id') id: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: User,
  ) {
    return this.service.acceptOffer(id, offerId, user.id);
  }

  @Delete(':id')
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary:
      'Cancel an open request before resolution. Withdraws any pending offers and frees the affected drivers.',
  })
  cancel(@Param('id') id: string, @CurrentUser() user: User) {
    return this.service.cancel(id, user.id);
  }
}
