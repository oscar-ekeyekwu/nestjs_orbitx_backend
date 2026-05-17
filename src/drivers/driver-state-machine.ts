import { StateMachine } from '../common/state-machine/transitions';
import { DriverVerificationStatus } from './entities/driver-profile.entity';

/**
 * Driver verification lifecycle (architecture §1.2).
 *
 *   setup_required → pending_approval → approved → active
 *                                   ↘ rejected → pending_approval (resubmit)
 *                                                     ↑
 *   active → suspended_docs_expired (system) → active
 *   active → suspended_admin       (admin)
 *
 * The `suspended_admin` state is intentionally terminal in v1 — bringing
 * a driver back from an admin suspension requires a fresh approval cycle
 * (re-enter the `pending_approval` lane).
 */
export const driverStateMachine = new StateMachine<DriverVerificationStatus>([
  {
    from: DriverVerificationStatus.SETUP_REQUIRED,
    to: DriverVerificationStatus.PENDING_APPROVAL,
  },
  {
    from: DriverVerificationStatus.PENDING_APPROVAL,
    to: DriverVerificationStatus.APPROVED,
    requiredRole: 'admin',
  },
  {
    from: DriverVerificationStatus.PENDING_APPROVAL,
    to: DriverVerificationStatus.REJECTED,
    requiredRole: 'admin',
  },
  {
    from: DriverVerificationStatus.REJECTED,
    to: DriverVerificationStatus.PENDING_APPROVAL,
  },
  {
    from: DriverVerificationStatus.APPROVED,
    to: DriverVerificationStatus.ACTIVE,
  },
  {
    from: DriverVerificationStatus.ACTIVE,
    to: DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED,
    requiredRole: 'system',
  },
  {
    from: DriverVerificationStatus.ACTIVE,
    to: DriverVerificationStatus.SUSPENDED_ADMIN,
    requiredRole: 'admin',
  },
  {
    from: DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED,
    to: DriverVerificationStatus.ACTIVE,
  },
  {
    from: DriverVerificationStatus.SUSPENDED_ADMIN,
    to: DriverVerificationStatus.PENDING_APPROVAL,
    requiredRole: 'admin',
  },
]);
