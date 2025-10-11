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
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { OrderStatus } from './entities/order.entity';

@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @Roles(UserRole.CUSTOMER)
  create(@Body() createOrderDto: CreateOrderDto, @CurrentUser() user: User) {
    return this.ordersService.create(createOrderDto, user.id);
  }

  @Get()
  findAll(@CurrentUser() user: User, @Query('status') status?: OrderStatus) {
    return this.ordersService.findAll(user.id, user.role, status);
  }

  @Get('available')
  @Roles(UserRole.DRIVER)
  findAvailable(
    @Query('latitude') latitude: string,
    @Query('longitude') longitude: string,
  ) {
    return this.ordersService.findAvailableOrders(
      parseFloat(latitude),
      parseFloat(longitude),
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
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
}
