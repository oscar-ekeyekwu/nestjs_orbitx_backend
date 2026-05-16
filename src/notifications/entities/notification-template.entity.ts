import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
  CreateDateColumn,
} from 'typeorm';
import { NotificationType } from './notification.entity';

/**
 * Per-event message template the admin can edit. `eventType` doubles as the
 * primary key — there's exactly one template row per NotificationType.
 *
 * Template variables (e.g. `{{orderId}}`, `{{customerName}}`) are evaluated
 * by the notification dispatcher when the template is rendered. Editing the
 * template here changes future sends; it does not retroactively modify
 * previously-stored notifications.
 */
@Entity('notification_templates')
export class NotificationTemplate {
  @PrimaryColumn({
    type: 'enum',
    enum: NotificationType,
  })
  eventType: NotificationType;

  @Column()
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', nullable: true })
  emailSubject: string | null;

  @Column({ type: 'text', nullable: true })
  emailBody: string | null;

  @Column({ type: 'text', nullable: true })
  smsBody: string | null;

  @Column({ default: true })
  isEnabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
