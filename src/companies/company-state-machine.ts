import { StateMachine } from '../common/state-machine/transitions';
import { CompanyStatus } from './entities/company.entity';

/**
 * Company lifecycle (architecture §1.2).
 *
 *   pending → approved ↔ suspended
 *   pending → suspended (denial path; suspended doubles as "rejected")
 *
 * The minimal graph reflects v1's reality — companies are admin-approved
 * one at a time, suspensions are reversible, and there is no separate
 * "rejected" terminal state.
 */
export const companyStateMachine = new StateMachine<CompanyStatus>([
  {
    from: CompanyStatus.PENDING,
    to: CompanyStatus.APPROVED,
    requiredRole: 'admin',
  },
  {
    from: CompanyStatus.PENDING,
    to: CompanyStatus.SUSPENDED,
    requiredRole: 'admin',
  },
  {
    from: CompanyStatus.APPROVED,
    to: CompanyStatus.SUSPENDED,
    requiredRole: 'admin',
  },
  {
    from: CompanyStatus.SUSPENDED,
    to: CompanyStatus.APPROVED,
    requiredRole: 'admin',
  },
]);
