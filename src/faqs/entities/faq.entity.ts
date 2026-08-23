import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('faqs')
export class FAQ {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  question: string;

  @Column('text')
  answer: string;

  @Column({ default: 'General' })
  category: string;

  @Column({ default: 0 })
  order: number;

  @Column({ default: true })
  isActive: boolean;

  /**
   * Independent of isActive (which gates mobile-app visibility) — lets
   * admins curate a smaller subset of FAQs to publish on the public
   * marketing landing page.
   */
  @Column({ default: false })
  showOnLanding: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
