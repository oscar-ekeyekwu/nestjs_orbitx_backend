import { StateMachine } from '../common/state-machine/transitions';
import { VehicleStatus } from './entities/vehicle.entity';

/**
 * Vehicle lifecycle (architecture §1.2).
 *
 *   draft → pending_approval → approved → active
 *                          ↘ rejected → pending_approval (resubmit)
 *   active     → suspended  → active (admin lift)
 *   approved   → retired (owner)
 *   active     → retired (owner)
 *   suspended  → retired (admin / owner)
 *
 * `retired` is terminal — retired vehicles cannot re-enter the lifecycle.
 * Add a new row instead.
 */
export const vehicleStateMachine = new StateMachine<VehicleStatus>([
  { from: VehicleStatus.DRAFT, to: VehicleStatus.PENDING_APPROVAL },
  {
    from: VehicleStatus.PENDING_APPROVAL,
    to: VehicleStatus.APPROVED,
    requiredRole: 'admin',
  },
  {
    from: VehicleStatus.PENDING_APPROVAL,
    to: VehicleStatus.REJECTED,
    requiredRole: 'admin',
  },
  { from: VehicleStatus.REJECTED, to: VehicleStatus.PENDING_APPROVAL },
  { from: VehicleStatus.APPROVED, to: VehicleStatus.ACTIVE },
  {
    from: VehicleStatus.ACTIVE,
    to: VehicleStatus.SUSPENDED,
    requiredRole: 'admin',
  },
  {
    from: VehicleStatus.SUSPENDED,
    to: VehicleStatus.ACTIVE,
    requiredRole: 'admin',
  },
  { from: VehicleStatus.APPROVED, to: VehicleStatus.RETIRED },
  { from: VehicleStatus.ACTIVE, to: VehicleStatus.RETIRED },
  { from: VehicleStatus.SUSPENDED, to: VehicleStatus.RETIRED },
]);
