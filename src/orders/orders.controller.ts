import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { OrderShareService } from './order-share.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { EstimateOrderDto } from './dto/estimate-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { GetOrdersQueryDto } from './dto/get-orders-query.dto';

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly orderShareService: OrderShareService,
  ) {}

  @Post()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: 'Create a new order (Customer only)' })
  create(@Body() createOrderDto: CreateOrderDto, @CurrentUser() user: User) {
    return this.ordersService.create(createOrderDto, user.id);
  }

  @Post('estimate')
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary:
      'Estimate the price + insurance for a tentative order (Customer only). No DB writes, no broadcast.',
  })
  estimate(@Body() dto: EstimateOrderDto) {
    return this.ordersService.estimate(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get user orders' })
  findAll(@CurrentUser() user: User, @Query() query: GetOrdersQueryDto) {
    return this.ordersService.findAll(user.id, user.role, query);
  }

  // G3 — static platform bank account for the mobile checkout. Placed
  // BEFORE @Get(':id') so the static `payment/bank-account` segment
  // takes precedence over the :id parameterized route.
  @Get('payment/bank-account')
  bankAccount() {
    return this.ordersService.getPlatformBankAccount();
  }

  @Get('available')
  @Roles(UserRole.DRIVER)
  findAvailable(
    @Query('latitude') latitude: string,
    @Query('longitude') longitude: string,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.findAvailableOrders(
      parseFloat(latitude),
      parseFloat(longitude),
      user.id,
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: User) {
    // E2 — scoped lookup so a customer cannot enumerate other customers'
    // orders and read the assigned driver's phone number. Drivers are
    // similarly limited to their own orders; admins pass.
    return this.ordersService.findOneScoped(id, user.id, user.role);
  }

  @Post(':id/accept')
  @Roles(UserRole.DRIVER)
  acceptOrder(@Param('id') id: string, @CurrentUser() user: User) {
    return this.ordersService.acceptOrder(id, user.id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateOrderStatusDto,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.updateStatus(
      id,
      updateStatusDto,
      user.id,
      user.role,
    );
  }

  @Patch(':id/location')
  @Roles(UserRole.DRIVER)
  updateDriverLocation(
    @Param('id') id: string,
    @Body('latitude') latitude: number,
    @Body('longitude') longitude: number,
  ) {
    return this.ordersService.updateDriverLocation(id, latitude, longitude);
  }

  @Post(':id/cancel')
  cancelOrder(@Param('id') id: string, @CurrentUser() user: User) {
    return this.ordersService.cancelOrder(id, user.id, user.role);
  }

  // G2 — driver confirms they collected cash on a delivered order.
  // Settles the driver's wallet (fee net of commission), inserts a
  // Transaction row, flips order.paymentStatus to completed. Idempotent.
  @Post(':id/mark-paid')
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary: 'Mark a delivered cash-on-delivery order as paid (driver only).',
  })
  markCashCollected(@Param('id') id: string, @CurrentUser() user: User) {
    return this.ordersService.markCashCollected(id, user.id);
  }

  // E3 — customer mints a share token for the recipient. Idempotent;
  // a second call for the same order returns the same token.
  @Post(':id/share-token')
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary: 'Create or reuse a public share token (Customer only)',
  })
  createShareToken(@Param('id') id: string, @CurrentUser() user: User) {
    return this.orderShareService.issueToken(id, user.id);
  }
}
