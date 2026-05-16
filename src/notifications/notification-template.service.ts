import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationTemplate } from './entities/notification-template.entity';
import { NotificationType } from './entities/notification.entity';
import { UpdateNotificationTemplateDto } from './dto/update-notification-template.dto';

type DefaultTemplate = Pick<
  NotificationTemplate,
  'title' | 'body' | 'emailSubject' | 'emailBody' | 'smsBody'
>;

const DEFAULT_TEMPLATES: Record<NotificationType, DefaultTemplate> = {
  [NotificationType.ORDER_CREATED]: {
    title: 'Order placed',
    body: 'Your order #{{orderId}} has been placed.',
    emailSubject: 'Order #{{orderId}} placed',
    emailBody: 'Hi {{customerName}}, your delivery order #{{orderId}} is in. We will let you know when a driver accepts.',
    smsBody: 'OrbitX: order #{{orderId}} placed.',
  },
  [NotificationType.ORDER_ACCEPTED]: {
    title: 'Driver accepted',
    body: '{{driverName}} accepted your order #{{orderId}}.',
    emailSubject: 'A driver is on the way',
    emailBody: '{{driverName}} accepted your order #{{orderId}} and is heading to pickup.',
    smsBody: 'OrbitX: {{driverName}} accepted order #{{orderId}}.',
  },
  [NotificationType.ORDER_PICKED_UP]: {
    title: 'Package picked up',
    body: 'Your driver has picked up order #{{orderId}}.',
    emailSubject: 'Package picked up',
    emailBody: 'Your driver has picked up order #{{orderId}}. It is now en route.',
    smsBody: 'OrbitX: order #{{orderId}} picked up.',
  },
  [NotificationType.ORDER_IN_TRANSIT]: {
    title: 'Out for delivery',
    body: 'Order #{{orderId}} is on the way to {{recipientName}}.',
    emailSubject: 'Order in transit',
    emailBody: 'Order #{{orderId}} is in transit to {{recipientName}}.',
    smsBody: 'OrbitX: order #{{orderId}} is in transit.',
  },
  [NotificationType.ORDER_DELIVERED]: {
    title: 'Delivered',
    body: 'Order #{{orderId}} was delivered.',
    emailSubject: 'Delivered',
    emailBody: 'Order #{{orderId}} was delivered to {{recipientName}}. Thanks for using OrbitX.',
    smsBody: 'OrbitX: order #{{orderId}} delivered.',
  },
  [NotificationType.ORDER_CANCELLED]: {
    title: 'Order cancelled',
    body: 'Order #{{orderId}} was cancelled.',
    emailSubject: 'Order cancelled',
    emailBody: 'Order #{{orderId}} was cancelled. {{reason}}',
    smsBody: 'OrbitX: order #{{orderId}} cancelled.',
  },
  [NotificationType.PAYMENT_SUCCESS]: {
    title: 'Payment received',
    body: 'Payment of ₦{{amount}} received for order #{{orderId}}.',
    emailSubject: 'Payment received',
    emailBody: 'We received ₦{{amount}} for order #{{orderId}}.',
    smsBody: 'OrbitX: payment of ₦{{amount}} received.',
  },
  [NotificationType.PAYMENT_FAILED]: {
    title: 'Payment failed',
    body: 'Payment for order #{{orderId}} could not be processed.',
    emailSubject: 'Payment failed',
    emailBody: 'Payment for order #{{orderId}} could not be processed. Please try a different method.',
    smsBody: 'OrbitX: payment for order #{{orderId}} failed.',
  },
  [NotificationType.NEW_MESSAGE]: {
    title: 'New message',
    body: '{{senderName}}: {{preview}}',
    emailSubject: null,
    emailBody: null,
    smsBody: null,
  },
};

@Injectable()
export class NotificationTemplateService implements OnModuleInit {
  constructor(
    @InjectRepository(NotificationTemplate)
    private readonly templateRepo: Repository<NotificationTemplate>,
  ) {}

  /**
   * Seed any missing template rows on app boot. Idempotent — only inserts
   * rows for event types that don't yet have one. Edits made via the admin
   * API are not overwritten because the row already exists.
   */
  async onModuleInit(): Promise<void> {
    const existing = await this.templateRepo.find();
    const existingTypes = new Set(existing.map((t) => t.eventType));
    const inserts: NotificationTemplate[] = [];
    for (const type of Object.values(NotificationType)) {
      if (existingTypes.has(type)) continue;
      const defaults = DEFAULT_TEMPLATES[type];
      inserts.push(
        this.templateRepo.create({
          eventType: type,
          title: defaults.title,
          body: defaults.body,
          emailSubject: defaults.emailSubject,
          emailBody: defaults.emailBody,
          smsBody: defaults.smsBody,
          isEnabled: true,
        }),
      );
    }
    if (inserts.length) {
      await this.templateRepo.save(inserts);
    }
  }

  async findAll(): Promise<NotificationTemplate[]> {
    return this.templateRepo.find({ order: { eventType: 'ASC' } });
  }

  async findOne(eventType: NotificationType): Promise<NotificationTemplate> {
    const template = await this.templateRepo.findOne({ where: { eventType } });
    if (!template) {
      throw new NotFoundException(
        `Notification template for ${eventType} not found`,
      );
    }
    return template;
  }

  async update(
    eventType: NotificationType,
    dto: UpdateNotificationTemplateDto,
  ): Promise<NotificationTemplate> {
    const template = await this.findOne(eventType);
    Object.assign(template, dto);
    const saved = await this.templateRepo.save(template);
    this.cache.delete(eventType);
    return saved;
  }

  /**
   * Look up a template, expand `{{varName}}` placeholders, and return the
   * rendered text per channel. Returns null when the template is disabled
   * or missing — callers should short-circuit dispatch in that case.
   *
   * Unknown placeholders are left as-is in the output, which is intentional:
   * it makes a missing variable visible during testing instead of silently
   * dropping it.
   */
  async render(
    eventType: NotificationType,
    variables: TemplateVariables,
  ): Promise<RenderedTemplate | null> {
    const template = await this.getCached(eventType);
    if (!template || !template.isEnabled) return null;
    return {
      title: substitute(template.title, variables),
      body: substitute(template.body, variables),
      emailSubject: template.emailSubject
        ? substitute(template.emailSubject, variables)
        : null,
      emailBody: template.emailBody
        ? substitute(template.emailBody, variables)
        : null,
      smsBody: template.smsBody ? substitute(template.smsBody, variables) : null,
    };
  }

  private readonly cache = new Map<NotificationType, NotificationTemplate>();

  private async getCached(
    eventType: NotificationType,
  ): Promise<NotificationTemplate | null> {
    const hit = this.cache.get(eventType);
    if (hit) return hit;
    const template = await this.templateRepo.findOne({ where: { eventType } });
    if (template) this.cache.set(eventType, template);
    return template;
  }
}

export type TemplateVariables = Record<string, string | number | null | undefined>;

export interface RenderedTemplate {
  title: string;
  body: string;
  emailSubject: string | null;
  emailBody: string | null;
  smsBody: string | null;
}

function substitute(text: string, vars: TemplateVariables): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}
