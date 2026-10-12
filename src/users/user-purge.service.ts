import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In, Not, QueryFailedError } from 'typeorm';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  ApprovalAction,
  ApprovalDecision,
  ApprovalTargetType,
} from '../approvals/entities/approval-decision.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { UserRole } from '../common/enums/user-role.enum';
import { Company } from '../companies/entities/company.entity';
import { CompanyMembership } from '../companies/entities/company-membership.entity';
import {
  Document,
  DocumentOwnerType,
} from '../documents/entities/document.entity';
import { DriverProfile } from '../drivers/entities/driver-profile.entity';
import { VerificationCode } from '../email/entities/verification-code.entity';
import { Incident } from '../incidents/entities/incident.entity';
import { DriverInvite } from '../invites/entities/driver-invite.entity';
import { DeviceToken } from '../notifications/entities/device-token.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { DispatchOffer } from '../order-requests/entities/dispatch-offer.entity';
import { OrderRequest } from '../order-requests/entities/order-request.entity';
import { Order } from '../orders/entities/order.entity';
import { Payout } from '../payouts/entities/payout.entity';
import { StorageRegistry } from '../storage/storage-registry.service';
import { SupportTicket } from '../support/entities/support-ticket.entity';
import { User } from './entities/user.entity';
import { Vehicle, VehicleOwnerType } from '../vehicles/entities/vehicle.entity';
import { VehicleAssignment } from '../vehicles/entities/vehicle-assignment.entity';
import { VehiclePendingUpdate } from '../vehicles/entities/vehicle-pending-update.entity';
import { Transaction } from '../wallet/entities/transaction.entity';
import { VirtualAccount } from '../wallet/entities/virtual-account.entity';
import { Wallet } from '../wallet/entities/wallet.entity';

export interface PurgeResult {
  id: string;
  /** Row counts removed per table — surfaced to the admin UI. */
  removed: Record<string, number>;
}

export interface BulkPurgeResult {
  deleted: string[];
  failed: Array<{ id: string; reason: string }>;
}

interface StoredFile {
  providerId: string;
  key: string;
}

type Where = Record<string, unknown>;

/**
 * Admin "clear this account" — a permanent, hard delete of a customer
 * or driver together with every row that references them. This is
 * deliberately NOT the NDPA soft path in `MeService` (30-day grace +
 * pseudonymisation): the admin wants the data gone, not anonymised.
 *
 * Every FK onto `users` is `ON DELETE NO ACTION` / `RESTRICT`, so the
 * dependency graph is walked explicitly, leaf-first, inside a single
 * transaction. Anything missed surfaces as an FK violation that rolls
 * the whole purge back — nothing is ever half-deleted.
 *
 * Refused outright for: admin accounts, the calling admin themselves,
 * and company owners whose company still has other members (deleting
 * the owner would cascade the company and orphan those drivers).
 *
 * On staging / prod the `orbit_app` role has DELETE revoked on
 * `transactions` and `approval_decisions` (NFR-S5). A purge of a user
 * with ledger rows therefore fails with 42501 there; it's translated
 * into a 409 that names the immutable ledger so the admin knows why.
 */
@Injectable()
export class UserPurgeService {
  private readonly logger = new Logger(UserPurgeService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly approvals: ApprovalsService,
    private readonly storage: StorageRegistry,
  ) {}

  async purge(id: string, admin: User): Promise<PurgeResult> {
    if (id === admin.id) {
      throw new BadRequestException('You cannot delete your own account.');
    }

    let files: StoredFile[] = [];
    let removed: Record<string, number> = {};

    try {
      await this.dataSource.transaction(async (manager) => {
        const outcome = await this.purgeInTransaction(manager, id, admin);
        files = outcome.files;
        removed = outcome.removed;
      });
    } catch (err) {
      throw this.translateDbError(err);
    }

    await this.deleteStoredFiles(files);
    this.logger.warn(
      `Admin ${admin.id} permanently deleted user ${id}: ${JSON.stringify(removed)}`,
    );
    return { id, removed };
  }

  async purgeMany(ids: string[], admin: User): Promise<BulkPurgeResult> {
    const result: BulkPurgeResult = { deleted: [], failed: [] };
    for (const id of Array.from(new Set(ids))) {
      try {
        await this.purge(id, admin);
        result.deleted.push(id);
      } catch (err) {
        const reason =
          err instanceof HttpException
            ? this.extractMessage(err)
            : 'Unexpected error while deleting this account.';
        result.failed.push({ id, reason });
      }
    }
    return result;
  }

  private async purgeInTransaction(
    manager: EntityManager,
    id: string,
    admin: User,
  ): Promise<{ files: StoredFile[]; removed: Record<string, number> }> {
    const user = await manager.findOne(User, { where: { id } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role === UserRole.ADMIN) {
      throw new ForbiddenException(
        'Admin accounts cannot be deleted from this screen.',
      );
    }

    const removed: Record<string, number> = {};
    const count = (table: string, affected: number | null | undefined) => {
      if (affected) removed[table] = (removed[table] ?? 0) + affected;
    };
    const del = async (
      table: string,
      entity: new () => object,
      where: Where,
    ) => {
      count(table, (await manager.delete(entity, where)).affected);
    };

    // ── Companies this user created ────────────────────────────────────
    const companies = await manager.find(Company, {
      where: { createdBy: id },
    });
    const companyIds = companies.map((c) => c.id);
    for (const company of companies) {
      const others = await manager.count(CompanyMembership, {
        where: { companyId: company.id, driverId: Not(id) },
      });
      if (others > 0) {
        throw new ConflictException(
          `${user.name} owns the company "${company.legalName}" which still has ${others} other member(s). Remove them from the company first.`,
        );
      }
    }

    // ── Collect ids the leaf deletes key off ───────────────────────────
    const wallets = await manager.find(Wallet, { where: { userId: id } });
    const walletIds = wallets.map((w) => w.id);

    const orders = await manager.find(Order, {
      where: [{ customerId: id }, { driverId: id }],
      select: ['id'],
    });
    const orderIds = orders.map((o) => o.id);

    const vehicleWhere: Where[] = [
      { ownerType: VehicleOwnerType.INDIVIDUAL_DRIVER, ownerId: id },
    ];
    if (companyIds.length) {
      vehicleWhere.push({
        ownerType: VehicleOwnerType.COMPANY,
        ownerId: In(companyIds),
      });
    }
    const vehicles = await manager.find(Vehicle, {
      where: vehicleWhere,
      select: ['id'],
    });
    const vehicleIds = vehicles.map((v) => v.id);

    // ── Documents (DB rows now, object-storage files after commit) ─────
    const docWhere: Where[] = [
      { uploadedBy: id },
      { ownerType: DocumentOwnerType.USER, ownerId: id },
    ];
    if (vehicleIds.length) {
      docWhere.push({
        ownerType: DocumentOwnerType.VEHICLE,
        ownerId: In(vehicleIds),
      });
    }
    if (companyIds.length) {
      docWhere.push({
        ownerType: DocumentOwnerType.COMPANY,
        ownerId: In(companyIds),
      });
    }
    const documents = await manager.find(Document, { where: docWhere });
    const files: StoredFile[] = documents
      .filter((d) => d.fileKey && d.storageProviderId)
      .map((d) => ({ providerId: d.storageProviderId!, key: d.fileKey! }));
    if (documents.length) {
      await del('documents', Document, {
        id: In(documents.map((d) => d.id)),
      });
    }

    // ── Dispatch / order requests ──────────────────────────────────────
    await del('dispatch_offers', DispatchOffer, { driverId: id });
    // dispatch_offers.requestId cascades from order_requests.
    await del('order_requests', OrderRequest, { customerId: id });

    // ── Orders and everything hanging off them ─────────────────────────
    if (orderIds.length) {
      await del('incidents', Incident, { orderId: In(orderIds) });
      await del('transactions', Transaction, { orderId: In(orderIds) });
      await manager.update(
        SupportTicket,
        { orderId: In(orderIds) },
        { orderId: null },
      );
      await manager.update(
        OrderRequest,
        { resolvedOrderId: In(orderIds) },
        { resolvedOrderId: null },
      );
    }
    await del('incidents', Incident, { driverId: id });
    if (walletIds.length) {
      await del('transactions', Transaction, { walletId: In(walletIds) });
      await del('payouts', Payout, { walletId: In(walletIds) });
    }
    await del('payouts', Payout, { recipientUserId: id });
    if (orderIds.length) {
      // order_share_tokens cascade from orders.
      await del('orders', Order, { id: In(orderIds) });
    }
    await del('support_tickets', SupportTicket, { userId: id });

    // ── Wallet ─────────────────────────────────────────────────────────
    await del('virtual_accounts', VirtualAccount, { userId: id });
    if (walletIds.length) {
      await del('wallets', Wallet, { id: In(walletIds) });
    }

    // ── Vehicles ───────────────────────────────────────────────────────
    await del('vehicle_pending_updates', VehiclePendingUpdate, {
      submittedBy: id,
    });
    await del('vehicle_assignments', VehicleAssignment, { driverId: id });
    if (vehicleIds.length) {
      await del('vehicle_assignments', VehicleAssignment, {
        vehicleId: In(vehicleIds),
      });
      // vehicle_pending_updates cascade from vehicles.
      await del('vehicles', Vehicle, { id: In(vehicleIds) });
    }

    // ── Company graph ──────────────────────────────────────────────────
    await manager.update(
      DriverInvite,
      { redeemedByUserId: id },
      { redeemedByUserId: null },
    );
    await del('driver_invites', DriverInvite, { createdBy: id });
    await del('company_memberships', CompanyMembership, { driverId: id });
    if (companyIds.length) {
      await del('driver_invites', DriverInvite, {
        companyId: In(companyIds),
      });
      await del('company_memberships', CompanyMembership, {
        companyId: In(companyIds),
      });
      await manager.update(
        DriverProfile,
        { companyId: In(companyIds) },
        { companyId: null },
      );
      await del('companies', Company, { id: In(companyIds) });
    }
    await del('driver_profiles', DriverProfile, { userId: id });

    // ── Auth / messaging leaves ────────────────────────────────────────
    await del('notifications', Notification, { userId: id });
    await del('device_tokens', DeviceToken, { userId: id });
    await del('refresh_tokens', RefreshToken, { userId: id });
    await del('verification_codes', VerificationCode, { userId: id });
    // The self-service NDPA path records the user as their own reviewer.
    await del('approval_decisions', ApprovalDecision, { reviewerId: id });

    // ── The user row itself ────────────────────────────────────────────
    await del('users', User, { id });

    await this.approvals.recordDecision(manager, {
      targetType: ApprovalTargetType.USER,
      targetId: id,
      action: ApprovalAction.DELETE,
      reviewerId: admin.id,
      reason: `Permanent deletion of ${user.role} ${user.email} by admin. Removed: ${JSON.stringify(removed)}`,
    });

    return { files, removed };
  }

  /**
   * Object-storage cleanup is best-effort and runs after the DB commit:
   * a missing or unreachable bucket must not resurrect a purged user.
   */
  private async deleteStoredFiles(files: StoredFile[]): Promise<void> {
    for (const file of files) {
      try {
        const adapter = await this.storage.get(file.providerId);
        await adapter.delete(file.key);
      } catch (err) {
        this.logger.warn(
          `Could not delete stored file ${file.key} on provider ${file.providerId}: ${(err as Error).message}`,
        );
      }
    }
  }

  private translateDbError(err: unknown): unknown {
    if (err instanceof HttpException) return err;
    if (err instanceof QueryFailedError) {
      const code = (err as QueryFailedError & { code?: string }).code;
      if (code === '42501') {
        return new ConflictException(
          'This account has financial-ledger or audit rows that the database role is not permitted to delete (NFR-S5 immutability). Deactivate the account instead, or purge it with the migrator role.',
        );
      }
      if (code === '23503') {
        return new ConflictException(
          `Deletion blocked by a database reference that is not handled yet: ${err.message}`,
        );
      }
    }
    return err;
  }

  private extractMessage(err: HttpException): string {
    const body = err.getResponse();
    if (typeof body === 'string') return body;
    const message = (body as { message?: string | string[] }).message;
    if (Array.isArray(message)) return message.join('; ');
    return message ?? err.message;
  }
}
