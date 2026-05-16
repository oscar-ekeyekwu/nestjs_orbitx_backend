import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from './entities/notification.entity';
import {
  NotificationTemplateService,
  type TemplateVariables,
} from './notification-template.service';
import { PushNotificationService } from './push-notification.service';
import { SmsService } from './sms.service';
import { EmailService } from './email.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

interface OrderDetailsInterface {
  id: string;
  pickupAddress: string;
  deliveryAddress: string;
  estimatedPrice: number;
  recipientName?: string;
}

interface CustomerDetailsInterface {
  id: string;
  email?: string | null;
  phone?: string | null;
  fcmToken?: string | null;
  name?: string;
}

interface DriverDetailsInterface {
  id: string;
  name: string;
  phone: string;
}

interface PaymentDetailsInterface {
  id: string;
  orderId: string;
  amount: number;
}

function stringifyForFcm(
  data: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private notificationsRepository: Repository<Notification>,
    private templateService: NotificationTemplateService,
    private pushNotificationService: PushNotificationService,
    private smsService: SmsService,
    private emailService: EmailService,
    private realtimeGateway: RealtimeGateway,
  ) {}

  async create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<Notification> {
    const notification = this.notificationsRepository.create({
      userId,
      type,
      title,
      message,
      data,
    });

    return this.notificationsRepository.save(notification);
  }

  async findUserNotifications(userId: string, unreadOnly = false) {
    const query = this.notificationsRepository
      .createQueryBuilder('notification')
      .where('notification.userId = :userId', { userId });

    if (unreadOnly) {
      query.andWhere('notification.isRead = :isRead', { isRead: false });
    }

    return query.orderBy('notification.createdAt', 'DESC').getMany();
  }

  async markAsRead(notificationId: string, userId: string) {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId, userId },
    });

    if (notification) {
      notification.isRead = true;
      await this.notificationsRepository.save(notification);
    }

    return notification;
  }

  async markAllAsRead(userId: string) {
    await this.notificationsRepository.update(
      { userId, isRead: false },
      { isRead: true },
    );

    return { success: true };
  }

  /**
   * Render the template for `type` and dispatch through every channel the
   * recipient is reachable on. Returns silently if the admin has disabled
   * the template — the realtime broadcast is the one exception, since that
   * is the only delivery the app UI relies on for live updates.
   */
  private async dispatch(
    type: NotificationType,
    recipient: CustomerDetailsInterface,
    variables: TemplateVariables,
    data: Record<string, unknown>,
    realtimeEvent: { name: string; payload: Record<string, unknown> },
  ): Promise<void> {
    // Realtime always fires — it's the live socket update for the in-app UI.
    this.realtimeGateway.notifyUser(
      recipient.id,
      realtimeEvent.name,
      realtimeEvent.payload,
    );

    const rendered = await this.templateService.render(type, variables);
    if (!rendered) return;

    await this.create(
      recipient.id,
      type,
      rendered.title,
      rendered.body,
      data,
    );

    if (recipient.fcmToken) {
      await this.pushNotificationService.sendToDevice(
        recipient.fcmToken,
        rendered.title,
        rendered.body,
        stringifyForFcm(data),
      );
    }

    if (recipient.email && rendered.emailSubject && rendered.emailBody) {
      await this.emailService.sendEmail(
        recipient.email,
        rendered.emailSubject,
        rendered.emailBody,
      );
    }

    if (recipient.phone && rendered.smsBody) {
      await this.smsService.sendSms(recipient.phone, rendered.smsBody);
    }
  }

  async notifyOrderCreated(
    order: OrderDetailsInterface,
    customer: CustomerDetailsInterface,
  ) {
    await this.dispatch(
      NotificationType.ORDER_CREATED,
      customer,
      {
        orderId: order.id,
        customerName: customer.name ?? '',
        pickupAddress: order.pickupAddress,
        deliveryAddress: order.deliveryAddress,
        estimatedPrice: order.estimatedPrice,
      },
      { orderId: order.id },
      { name: 'order_created', payload: { order } },
    );
  }

  async notifyOrderAccepted(
    order: OrderDetailsInterface,
    customer: CustomerDetailsInterface,
    driver: DriverDetailsInterface,
  ) {
    await this.dispatch(
      NotificationType.ORDER_ACCEPTED,
      customer,
      {
        orderId: order.id,
        customerName: customer.name ?? '',
        driverName: driver.name,
        driverPhone: driver.phone,
      },
      { orderId: order.id, driverId: driver.id },
      { name: 'order_accepted', payload: { order, driver } },
    );
  }

  async notifyOrderPickedUp(
    order: OrderDetailsInterface,
    customer: CustomerDetailsInterface,
  ) {
    await this.dispatch(
      NotificationType.ORDER_PICKED_UP,
      customer,
      {
        orderId: order.id,
        customerName: customer.name ?? '',
      },
      { orderId: order.id },
      { name: 'order_picked_up', payload: { order } },
    );
  }

  async notifyOrderInTransit(
    order: OrderDetailsInterface,
    customer: CustomerDetailsInterface,
  ) {
    await this.dispatch(
      NotificationType.ORDER_IN_TRANSIT,
      customer,
      {
        orderId: order.id,
        customerName: customer.name ?? '',
        recipientName: order.recipientName ?? '',
      },
      { orderId: order.id },
      { name: 'order_in_transit', payload: { order } },
    );
  }

  async notifyOrderDelivered(
    order: OrderDetailsInterface,
    customer: CustomerDetailsInterface,
  ) {
    await this.dispatch(
      NotificationType.ORDER_DELIVERED,
      customer,
      {
        orderId: order.id,
        customerName: customer.name ?? '',
        recipientName: order.recipientName ?? '',
      },
      { orderId: order.id },
      { name: 'order_delivered', payload: { order } },
    );
  }

  async notifyOrderCancelled(
    order: OrderDetailsInterface,
    customer: CustomerDetailsInterface,
    reason?: string,
  ) {
    await this.dispatch(
      NotificationType.ORDER_CANCELLED,
      customer,
      {
        orderId: order.id,
        customerName: customer.name ?? '',
        reason: reason ?? '',
      },
      { orderId: order.id, reason },
      { name: 'order_cancelled', payload: { order, reason } },
    );
  }

  async notifyNewOrderToDrivers(order: OrderDetailsInterface) {
    // Broadcast to all online drivers via WebSocket
    this.realtimeGateway.emitNewOrderToDrivers(order);

    // You can also send push notifications to nearby drivers
    // Get online drivers within radius and send notifications
    await Promise.resolve();
  }

  async notifyPaymentSuccess(
    payment: PaymentDetailsInterface,
    user: CustomerDetailsInterface,
  ) {
    await this.dispatch(
      NotificationType.PAYMENT_SUCCESS,
      user,
      {
        orderId: payment.orderId,
        customerName: user.name ?? '',
        amount: payment.amount,
      },
      { paymentId: payment.id, orderId: payment.orderId },
      { name: 'payment_success', payload: { payment } },
    );
  }

  async notifyPaymentFailed(
    payment: PaymentDetailsInterface,
    user: CustomerDetailsInterface,
  ) {
    await this.dispatch(
      NotificationType.PAYMENT_FAILED,
      user,
      {
        orderId: payment.orderId,
        customerName: user.name ?? '',
        amount: payment.amount,
      },
      { paymentId: payment.id, orderId: payment.orderId },
      { name: 'payment_failed', payload: { payment } },
    );
  }
}
