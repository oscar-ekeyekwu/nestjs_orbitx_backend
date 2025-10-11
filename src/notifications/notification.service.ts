import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from './entities/notification.entity';
import { PushNotificationService } from './push-notification.service';
import { SmsService } from './sms.service';
import { EmailService } from './email.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

interface OrderDetailsInterface {
  id: string;
  pickupAddress: string;
  deliveryAddress: string;
  estimatedPrice: number;
}

interface CustomerDetailsInterface {
  id: string;
  fcmToken: string;
  email: string;
  phone: string;
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

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private notificationsRepository: Repository<Notification>,
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
    data?: any,
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

  async notifyOrderCreated(
    order: OrderDetailsInterface,
    customer: CustomerDetailsInterface,
  ) {
    const title = 'Order Created';
    const message = `Your order #${order.id} has been created successfully.`;

    // Save notification
    await this.create(
      customer.id,
      NotificationType.ORDER_CREATED,
      title,
      message,
      {
        orderId: order.id,
      },
    );

    // Send push notification (if FCM token available)
    if (customer.fcmToken) {
      await this.pushNotificationService.sendToDevice(
        customer.fcmToken,
        title,
        message,
        { orderId: order.id },
      );
    }

    // Send email
    await this.emailService.sendOrderCreatedEmail(customer.email, order);

    // Real-time notification
    this.realtimeGateway.notifyUser(customer.id, 'order_created', { order });
  }

  async notifyOrderAccepted(
    order: OrderDetailsInterface,
    customer: CustomerDetailsInterface,
    driver: DriverDetailsInterface,
  ) {
    const title = 'Driver Assigned';
    const message = `${driver.name} has accepted your order #${order.id}.`;

    await this.create(
      customer.id,
      NotificationType.ORDER_ACCEPTED,
      title,
      message,
      {
        orderId: order.id,
        driverId: driver.id,
      },
    );

    if (customer.fcmToken) {
      await this.pushNotificationService.sendToDevice(
        customer.fcmToken,
        title,
        message,
        { orderId: order.id },
      );
    }

    await this.emailService.sendOrderAcceptedEmail(
      customer.email,
      order,
      driver,
    );

    // Send SMS
    if (customer.phone) {
      await this.smsService.sendSms(
        customer.phone,
        `Driver ${driver.name} has been assigned to your order. Track: ${order.id}`,
      );
    }

    this.realtimeGateway.notifyUser(customer.id, 'order_accepted', {
      order,
      driver,
    });
  }

  async notifyOrderPickedUp(
    order: OrderDetailsInterface,
    customer: CustomerDetailsInterface,
  ) {
    const title = 'Package Picked Up';
    const message = `Your package has been picked up and is on the way.`;

    await this.create(
      customer.id,
      NotificationType.ORDER_PICKED_UP,
      title,
      message,
      {
        orderId: order.id,
      },
    );

    if (customer.fcmToken) {
      await this.pushNotificationService.sendToDevice(
        customer.fcmToken,
        title,
        message,
        { orderId: order.id },
      );
    }

    this.realtimeGateway.notifyUser(customer.id, 'order_picked_up', { order });
  }

  async notifyOrderDelivered(
    order: OrderDetailsInterface,
    customer: CustomerDetailsInterface,
  ) {
    const title = 'Order Delivered';
    const message = `Your order #${order.id} has been delivered successfully!`;

    await this.create(
      customer.id,
      NotificationType.ORDER_DELIVERED,
      title,
      message,
      {
        orderId: order.id,
      },
    );

    if (customer.fcmToken) {
      await this.pushNotificationService.sendToDevice(
        customer.fcmToken,
        title,
        message,
        { orderId: order.id },
      );
    }

    await this.emailService.sendOrderDeliveredEmail(customer.email, order);

    if (customer.phone) {
      await this.smsService.sendSms(
        customer.phone,
        `Your order #${order.id} has been delivered. Thank you for using our service!`,
      );
    }

    this.realtimeGateway.notifyUser(customer.id, 'order_delivered', { order });
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
    const title = 'Payment Successful';
    const message = `Your payment of ₦${payment.amount} was successful.`;

    await this.create(
      user.id,
      NotificationType.PAYMENT_SUCCESS,
      title,
      message,
      {
        paymentId: payment.id,
        orderId: payment.orderId,
      },
    );

    if (user.fcmToken) {
      await this.pushNotificationService.sendToDevice(
        user.fcmToken,
        title,
        message,
        { paymentId: payment.id },
      );
    }

    this.realtimeGateway.notifyUser(user.id, 'payment_success', { payment });
  }

  async notifyPaymentFailed(
    payment: PaymentDetailsInterface,
    user: CustomerDetailsInterface,
  ) {
    const title = 'Payment Failed';
    const message = `Your payment of ₦${payment.amount} failed. Please try again.`;

    await this.create(
      user.id,
      NotificationType.PAYMENT_FAILED,
      title,
      message,
      {
        paymentId: payment.id,
        orderId: payment.orderId,
      },
    );

    if (user.fcmToken) {
      await this.pushNotificationService.sendToDevice(
        user.fcmToken,
        title,
        message,
        { paymentId: payment.id },
      );
    }

    this.realtimeGateway.notifyUser(user.id, 'payment_failed', { payment });
  }
}
