import { BadRequestException } from '@nestjs/common';
import { companyStateMachine } from './company-state-machine';
import { CompanyStatus } from './entities/company.entity';

const C = CompanyStatus;

describe('companyStateMachine', () => {
  describe('declared transitions (positive cases)', () => {
    const legal: Array<[CompanyStatus, CompanyStatus]> = [
      [C.PENDING, C.APPROVED],
      [C.APPROVED, C.SUSPENDED],
      [C.SUSPENDED, C.APPROVED],
    ];

    it.each(legal)('%s → %s is allowed', (from, to) => {
      expect(companyStateMachine.canTransition(from, to)).toBe(true);
      expect(() =>
        companyStateMachine.assertTransition(from, to, 'COMPANY_001'),
      ).not.toThrow();
    });
  });

  describe('illegal transitions (negative cases)', () => {
    const illegal: Array<[CompanyStatus, CompanyStatus]> = [
      // B1 spec: suspension only from approved. A pending company that
      // fails review stays pending; admin re-runs the approval flow.
      [C.PENDING, C.SUSPENDED],
      // Approved cannot regress to pending without suspension first.
      [C.APPROVED, C.PENDING],
      // Suspended cannot return to pending — only to approved.
      [C.SUSPENDED, C.PENDING],
      // No self-loops.
      [C.PENDING, C.PENDING],
      [C.APPROVED, C.APPROVED],
      [C.SUSPENDED, C.SUSPENDED],
    ];

    it.each(illegal)('%s → %s is rejected', (from, to) => {
      expect(companyStateMachine.canTransition(from, to)).toBe(false);
      expect(() =>
        companyStateMachine.assertTransition(from, to, 'COMPANY_001'),
      ).toThrow(BadRequestException);
    });
  });

  describe('role metadata', () => {
    it('marks every company transition as admin-only', () => {
      for (const t of companyStateMachine.listTransitions()) {
        expect(t.requiredRole).toBe('admin');
      }
    });
  });
});
