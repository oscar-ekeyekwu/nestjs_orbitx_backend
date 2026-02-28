import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FAQ } from './entities/faq.entity';
import { CreateFaqDto } from './dto/create-faq.dto';
import { UpdateFaqDto } from './dto/update-faq.dto';

@Injectable()
export class FaqsService {
  constructor(
    @InjectRepository(FAQ)
    private readonly faqRepo: Repository<FAQ>,
  ) {}

  async findAll(onlyActive = false): Promise<FAQ[]> {
    const where = onlyActive ? { isActive: true } : {};
    return this.faqRepo.find({
      where,
      order: { order: 'ASC', createdAt: 'ASC' },
    });
  }

  async findOne(id: string): Promise<FAQ> {
    const faq = await this.faqRepo.findOne({ where: { id } });
    if (!faq) throw new NotFoundException(`FAQ ${id} not found`);
    return faq;
  }

  async create(dto: CreateFaqDto): Promise<FAQ> {
    const faq = this.faqRepo.create({
      ...dto,
      order: dto.order ?? 0,
      isActive: dto.isActive ?? true,
    });
    return this.faqRepo.save(faq);
  }

  async update(id: string, dto: UpdateFaqDto): Promise<FAQ> {
    const faq = await this.findOne(id);
    Object.assign(faq, dto);
    return this.faqRepo.save(faq);
  }

  async remove(id: string): Promise<void> {
    const faq = await this.findOne(id);
    await this.faqRepo.remove(faq);
  }

  async reorder(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map((id, index) =>
        this.faqRepo.update(id, { order: index }),
      ),
    );
  }
}
