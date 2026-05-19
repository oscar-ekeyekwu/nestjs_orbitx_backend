import { StateMachine } from '../common/state-machine/transitions';
import { CompanyStatus } from './entities/company.entity';

/**
 * Company lifecycle (architecture §1.2, narrowed by B1 AC).
 *
 *   pending → approved ↔ suspended
 *
 * Only three edges:
 *   - pending   → approved   (admin approves a new company)
 *   - approved  → suspended  (admin pulls operating privileges)
 *   - suspended → approved   (admin restores)
 *
 * pending → suspended is intentionally NOT a transition. B1 reads:
 * "only `pending → approved` is valid; suspension only from
 * `approved`." A pending company that fails review just stays
 * `pending` until the admin re-runs the approval flow.
 */
export const companyStateMachine = new StateMachine<CompanyStatus>([
  {
    from: CompanyStatus.PENDING,
    to: CompanyStatus.APPROVED,
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
