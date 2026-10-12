import { User } from './entities/user.entity';

/**
 * NDPA §34 pseudonymisation — scrubs every direct identifier on a
 * `users` row in place while keeping the primary key so orders,
 * transactions and audit rows retain referential integrity (DR-N3
 * permits anonymised retention for accounting).
 *
 * Shared by the self-service 30-day sweep (`MeService`) and the
 * admin "delete account" action (`UsersService.adminDelete`) so both
 * paths scrub exactly the same fields.
 *
 * `phone` goes to NULL rather than '' — `UQ_users_phone` treats NULLs
 * as distinct but an empty string is a value, so two scrubbed rows
 * with '' would collide on the unique constraint.
 */
export function pseudonymiseUser(user: User, now: Date): void {
  const tag = `deleted_user_${user.id.slice(0, 8)}`;
  user.email = `${tag}@deleted.invalid`;
  user.phone = null;
  user.first_name = 'Deleted';
  user.last_name = 'User';
  user.googleId = null;
  user.avatar = null;
  user.isActive = false;
  user.isEmailVerified = false;
  user.isPhoneVerified = false;
  user.paystackRecipientCode = null;
  user.bvnCipher = null;
  user.bvnNonce = null;
  user.bvnTag = null;
  user.bvnKeyVersion = null;
  user.bvnLast4 = null;
  user.bvnUpdatedAt = null;
  if (!user.deletionScheduledAt) user.deletionScheduledAt = now;
  user.pseudonymizedAt = now;
}
