import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import {
  Order,
  OrderPaymentStatus,
  OrderStatus,
  PackageSize,
} from './entities/order.entity';
import { UserRole } from '../common/enums/user-role.enum';

type Mut = {
  order: Order | null;
};

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    customerId: 'cust-1',
    driverId: 'driver-1',
    status: OrderStatus.ACCEPTED,
    packageSize: PackageSize.MEDIUM,
    paymentStatus: OrderPaymentStatus.PENDING_TRANSFER,
    customerMarkedPaidAt: null,
    paymentConfirmedAt: null,
    ...overrides,
  } as unknown as Order;
}

function buildService(mut: Mut): {
  service: OrdersService;
  realtimeGateway: {
    emitOrderStatusUpdate: jest.Mock;
  };
  eventEmitter: { emit: jest.Mock };
  driverBankRows: Array<{
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
  }>;
  configService: {
    getBoolean: jest.Mock;
    getNumber: jest.Mock;
    getString: jest.Mock;
  };
} {
  const driverBankRows: Array<{
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
  }> = [];

  const ordersRepo = {
    findOne: jest.fn(async () => mut.order),
    save: jest.fn(async (entity: Order) => {
      mut.order = { ...mut.order, ...entity } as Order;
      return mut.order;
    }),
    query: jest.fn(async () => driverBankRows),
  } as unknown as Repository<Order>;

  const realtimeGateway = { emitOrderStatusUpdate: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  const configService = {
    // Default proof-required to OFF so existing tests keep passing.
    // Tests that need the gate ON override this on the returned mock.
    getBoolean: jest.fn().mockResolvedValue(false),
    getNumber: jest.fn().mockResolvedValue(0),
    getString: jest.fn().mockResolvedValue(''),
  };

  const service = new OrdersService(
    ordersRepo,
    {} as never,
    configService as never,
    realtimeGateway as never,
    {} as never,
    eventEmitter as never,
    {} as never,
    {} as never,
    undefined,
  );

  return {
    service,
    realtimeGateway,
    eventEmitter,
    driverBankRows,
    configService,
  };
}

describe('OrdersService.markCustomerPaid', () => {
  it('flips PENDING_TRANSFER → CUSTOMER_MARKED_PAID + stamps timestamp', async () => {
    const mut: Mut = { order: makeOrder() };
    const { service, realtimeGateway } = buildService(mut);

    const result = await service.markCustomerPaid('order-1', 'cust-1');

    expect(result.paymentStatus).toBe(
      OrderPaymentStatus.CUSTOMER_MARKED_PAID,
    );
    expect(result.customerMarkedPaidAt).toBeInstanceOf(Date);
    expect(realtimeGateway.emitOrderStatusUpdate).toHaveBeenCalled();
  });

  it('rejects when caller is not the order owner', async () => {
    const mut: Mut = { order: makeOrder() };
    const { service } = buildService(mut);
    await expect(
      service.markCustomerPaid('order-1', 'someone-else'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when paymentStatus isn’t PENDING_TRANSFER', async () => {
    const mut: Mut = {
      order: makeOrder({ paymentStatus: OrderPaymentStatus.PENDING_CASH }),
    };
    const { service } = buildService(mut);
    await expect(
      service.markCustomerPaid('order-1', 'cust-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is idempotent on an already-marked order', async () => {
    const stamp = new Date('2026-01-01');
    const mut: Mut = {
      order: makeOrder({
        paymentStatus: OrderPaymentStatus.CUSTOMER_MARKED_PAID,
        customerMarkedPaidAt: stamp,
      }),
    };
    const { service, realtimeGateway } = buildService(mut);

    const result = await service.markCustomerPaid('order-1', 'cust-1');
    expect(result.paymentStatus).toBe(
      OrderPaymentStatus.CUSTOMER_MARKED_PAID,
    );
    expect(result.customerMarkedPaidAt).toBe(stamp);
    expect(realtimeGateway.emitOrderStatusUpdate).not.toHaveBeenCalled();
  });

  it('404s when the order does not exist', async () => {
    const mut: Mut = { order: null };
    const { service } = buildService(mut);
    await expect(
      service.markCustomerPaid('missing', 'cust-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('proof-required gate (ORDER_PAYMENT_PROOF_REQUIRED)', () => {
    it('rejects when the flag is ON and no proofUrl is passed', async () => {
      const mut: Mut = { order: makeOrder() };
      const { service, configService } = buildService(mut);
      configService.getBoolean.mockResolvedValue(true);

      await expect(
        service.markCustomerPaid('order-1', 'cust-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts the mark when the flag is ON and a proofUrl is passed', async () => {
      const mut: Mut = { order: makeOrder() };
      const { service, configService } = buildService(mut);
      configService.getBoolean.mockResolvedValue(true);

      const result = await service.markCustomerPaid(
        'order-1',
        'cust-1',
        'https://storage/proof.jpg',
      );
      expect(result.paymentStatus).toBe(
        OrderPaymentStatus.CUSTOMER_MARKED_PAID,
      );
      expect(result.paymentProofUrl).toBe('https://storage/proof.jpg');
    });

    it('treats whitespace-only proofUrl as missing when flag is ON', async () => {
      const mut: Mut = { order: makeOrder() };
      const { service, configService } = buildService(mut);
      configService.getBoolean.mockResolvedValue(true);

      await expect(
        service.markCustomerPaid('order-1', 'cust-1', '   '),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts mark without proof when the flag is OFF (default)', async () => {
      const mut: Mut = { order: makeOrder() };
      const { service } = buildService(mut); // getBoolean defaults false

      const result = await service.markCustomerPaid('order-1', 'cust-1');
      expect(result.paymentStatus).toBe(
        OrderPaymentStatus.CUSTOMER_MARKED_PAID,
      );
    });

    it('still persists a volunteered proof when flag is OFF', async () => {
      const mut: Mut = { order: makeOrder() };
      const { service } = buildService(mut);

      const result = await service.markCustomerPaid(
        'order-1',
        'cust-1',
        'https://storage/proof.jpg',
      );
      expect(result.paymentProofUrl).toBe('https://storage/proof.jpg');
    });
  });
});

describe('OrdersService.confirmPaymentReceived', () => {
  it('flips CUSTOMER_MARKED_PAID → COMPLETED + stamps timestamp', async () => {
    const mut: Mut = {
      order: makeOrder({
        paymentStatus: OrderPaymentStatus.CUSTOMER_MARKED_PAID,
        customerMarkedPaidAt: new Date(),
      }),
    };
    const { service, realtimeGateway } = buildService(mut);

    const result = await service.confirmPaymentReceived('order-1', 'driver-1');

    expect(result.paymentStatus).toBe(OrderPaymentStatus.COMPLETED);
    expect(result.paymentConfirmedAt).toBeInstanceOf(Date);
    expect(realtimeGateway.emitOrderStatusUpdate).toHaveBeenCalled();
  });

  it('rejects when caller is not the assigned driver', async () => {
    const mut: Mut = {
      order: makeOrder({
        paymentStatus: OrderPaymentStatus.CUSTOMER_MARKED_PAID,
      }),
    };
    const { service } = buildService(mut);
    await expect(
      service.confirmPaymentReceived('order-1', 'other-driver'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when the customer hasn’t marked paid yet', async () => {
    const mut: Mut = { order: makeOrder() }; // still PENDING_TRANSFER
    const { service } = buildService(mut);
    await expect(
      service.confirmPaymentReceived('order-1', 'driver-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is idempotent on an already-completed order', async () => {
    const stamp = new Date('2026-01-01');
    const mut: Mut = {
      order: makeOrder({
        paymentStatus: OrderPaymentStatus.COMPLETED,
        paymentConfirmedAt: stamp,
      }),
    };
    const { service, realtimeGateway } = buildService(mut);

    const result = await service.confirmPaymentReceived('order-1', 'driver-1');
    expect(result.paymentStatus).toBe(OrderPaymentStatus.COMPLETED);
    expect(result.paymentConfirmedAt).toBe(stamp);
    expect(realtimeGateway.emitOrderStatusUpdate).not.toHaveBeenCalled();
  });
});

describe('OrdersService.getDriverBankAccount', () => {
  it('returns the driver bank account when set (source=driver)', async () => {
    const mut: Mut = { order: makeOrder() };
    const built = buildService(mut);
    built.driverBankRows.push({
      bankName: 'GTBank',
      bankAccountName: 'Tunde Bello',
      bankAccountNumber: '0123456789',
    });

    const result = await built.service.getDriverBankAccount(
      'order-1',
      'cust-1',
      UserRole.CUSTOMER,
    );
    expect(result.source).toBe('driver');
    expect(result.bankName).toBe('GTBank');
    expect(result.accountNumber).toBe('0123456789');
  });

  it('falls back to the platform account when driver hasn’t set bank details', async () => {
    const mut: Mut = { order: makeOrder() };
    const built = buildService(mut);
    // driverBankRows empty → falls back

    const result = await built.service.getDriverBankAccount(
      'order-1',
      'cust-1',
      UserRole.CUSTOMER,
    );
    expect(result.source).toBe('platform');
  });

  it('rejects non-owner customers', async () => {
    const mut: Mut = { order: makeOrder() };
    const { service } = buildService(mut);

    await expect(
      service.getDriverBankAccount(
        'order-1',
        'someone-else',
        UserRole.CUSTOMER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when no driver has been assigned yet', async () => {
    const mut: Mut = { order: makeOrder({ driverId: undefined as never }) };
    const { service } = buildService(mut);
    await expect(
      service.getDriverBankAccount('order-1', 'cust-1', UserRole.CUSTOMER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
