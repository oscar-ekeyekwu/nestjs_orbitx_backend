import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FAQ } from './entities/faq.entity';
import { FaqsService } from './faqs.service';
import { FaqsController } from './faqs.controller';

@Module({
  imports: [TypeOrmModule.forFeature([FAQ])],
  controllers: [FaqsController],
  providers: [FaqsService],
})
export class FaqsModule {}
