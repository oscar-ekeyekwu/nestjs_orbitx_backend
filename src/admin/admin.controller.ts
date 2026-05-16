import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('dashboard/stats')
  @ApiOperation({ summary: 'Dashboard counts + week-over-week trends (Admin only)' })
  async getStats() {
    return this.adminService.getDashboardStats();
  }

  @Get('dashboard/timeseries')
  @ApiOperation({ summary: 'Last 7 days of orders and revenue (Admin only)' })
  async getTimeseries() {
    return this.adminService.getTimeseries();
  }

  @Get('export/users')
  @ApiOperation({ summary: 'Export all users as CSV (Admin only)' })
  async exportUsers(@Res() res: Response) {
    const csv = await this.adminService.exportUsersCsv();
    sendCsv(res, csv, `users-${stamp()}.csv`);
  }

  @Get('export/orders')
  @ApiOperation({ summary: 'Export all orders as CSV (Admin only)' })
  async exportOrders(@Res() res: Response) {
    const csv = await this.adminService.exportOrdersCsv();
    sendCsv(res, csv, `orders-${stamp()}.csv`);
  }

  @Get('export/transactions')
  @ApiOperation({ summary: 'Export all transactions as CSV (Admin only)' })
  async exportTransactions(@Res() res: Response) {
    const csv = await this.adminService.exportTransactionsCsv();
    sendCsv(res, csv, `transactions-${stamp()}.csv`);
  }
}

function sendCsv(res: Response, body: string, filename: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"`,
  );
  res.send(body);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}
