import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LessThanOrEqual, Repository } from 'typeorm';
import {
  Document,
  DocumentOwnerType,
  DocumentStatus,
} from './entities/document.entity';
import { suspensionTriggerFor } from './documents.constants';
import {
  DriverProfile,
  DriverVerificationStatus,
} from '../drivers/entities/driver-profile.entity';
import { driverStateMachine } from '../drivers/driver-state-machine';
import { DriversService } from '../drivers/drivers.service';
import { BadRequestException } from '@nestjs/common';
import { Vehicle, VehicleStatus } from '../vehicles/entities/vehicle.entity';
import { vehicleStateMachine } from '../vehicles/vehicle-state-machine';
import { Company, CompanyStatus } from '../companies/entities/company.entity';
import { companyStateMachine } from '../companies/company-state-machine';

// Warning thresholds in days. The first time a doc enters one of these
// windows (counted by the sweep that lands on the boundary day) we
// emit `document.expiring_soon`. We don't try to dedupe — the cron
// runs once a day so two consecutive 7-day warnings can't fire for
// the same doc.
const WARNING_DAYS = [30, 7] as const;

export interface ExpiringSoonEvent {
  documentId: string;
  ownerType: DocumentOwnerType;
  ownerId: string;
  type: string;
  daysRemaining: number;
  expiryDate: string; // ISO date
}

export interface ExpiredEvent {
  documentId: string;
  ownerType: DocumentOwnerType;
  ownerId: string;
  type: string;
  expiryDate: string;
}

export interface OwnerSuspendedEvent {
  ownerType: DocumentOwnerType;
  ownerId: string;
  triggeringDocumentId: string;
  triggeringDocType: string;
}

export interface SweepSummary {
  asOf: string;
  warned: number;
  expired: number;
  suspended: number;
}

/**
 * C4 — daily document-expiry sweep.
 *
 * Runs at 02:00 Africa/Lagos. For each approved document with an
 * expiry date:
 *
 *   - `expiryDate ≤ today` → status flips to `expired`, and if the
 *     type is in SUSPENSION_TRIGGER_DOC_TYPES the owner entity is
 *     transitioned to a suspended state via its state machine.
 *   - `expiryDate = today + 30` or `today + 7` → emits
 *     `document.expiring_soon` with daysRemaining.
 *
 * Events are emitted via EventEmitter2. ARCH-10's push fan-out and
 * the email/SMS listeners (Sprint 3+) subscribe to fan out to the
 * owner. The cron itself is decoupled from delivery channels so a
 * misbehaving notifier can never block the state transition.
 */
@Injectable()
export class DocumentExpiryCron {
  private readonly logger = new Logger(DocumentExpiryCron.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(DriverProfile)
    private readonly driverProfileRepo: Repository<DriverProfile>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepo: Repository<Vehicle>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    private readonly events: EventEmitter2,
    private readonly driversService: DriversService,
  ) {}

  @Cron('0 2 * * *', {
    name: 'documents-expiry-sweep',
    timeZone: 'Africa/Lagos',
  })
  async scheduledSweep(): Promise<void> {
    const summary = await this.runSweep(new Date());
    this.logger.log(
      `expiry-sweep complete: warned=${summary.warned} expired=${summary.expired} suspended=${summary.suspended}`,
    );
  }

  /**
   * Run the sweep against an explicit "today" — exposed so unit
   * tests can pin the clock without monkey-patching `Date.now()`.
   * Returns a summary the caller can assert against.
   */
  async runSweep(asOf: Date): Promise<SweepSummary> {
    const today = startOfDay(asOf);
    const upperBound = addDays(today, WARNING_DAYS[0]);

    const candidates = await this.documentRepo.find({
      where: {
        status: DocumentStatus.APPROVED,
        expiryDate: LessThanOrEqual(upperBound),
      },
      order: { expiryDate: 'ASC' },
    });

    let warned = 0;
    let expired = 0;
    let suspended = 0;

    for (const doc of candidates) {
      if (!doc.expiryDate) continue;
      const expiry = startOfDay(new Date(doc.expiryDate));
      const days = diffInDays(today, expiry);

      if (days < 0) {
        await this.expireDocument(doc);
        expired += 1;
        if (suspensionTriggerFor(doc.type)) {
          const didSuspend = await this.suspendOwner(doc);
          if (didSuspend) suspended += 1;
        }
        continue;
      }

      if (WARNING_DAYS.includes(days as 30 | 7)) {
        this.emitExpiringSoon(doc, days);
        warned += 1;
      }
    }

    return {
      asOf: today.toISOString(),
      warned,
      expired,
      suspended,
    };
  }

  /**
   * C5 hook — after an admin approves a fresh document, call this to
   * lift a docs-expired suspension on the owner IF no other expired
   * required docs remain. Idempotent: it's safe to call even if the
   * owner is not currently suspended.
   */
  async recoverOwnerIfDocsClear(
    ownerType: DocumentOwnerType,
    ownerId: string,
  ): Promise<boolean> {
    const stillExpired = await this.documentRepo.count({
      where: {
        ownerType,
        ownerId,
        status: DocumentStatus.EXPIRED,
      },
    });
    if (stillExpired > 0) return false;

    switch (ownerType) {
      case DocumentOwnerType.USER:
        return this.reactivateDriverByUserId(ownerId);
      case DocumentOwnerType.VEHICLE:
        return this.reactivateVehicle(ownerId);
      case DocumentOwnerType.COMPANY:
        return this.reactivateCompany(ownerId);
    }
  }

  private async expireDocument(doc: Document): Promise<void> {
    doc.status = DocumentStatus.EXPIRED;
    await this.documentRepo.save(doc);
    const payload: ExpiredEvent = {
      documentId: doc.id,
      ownerType: doc.ownerType,
      ownerId: doc.ownerId,
      type: doc.type,
      expiryDate: toIsoDate(doc.expiryDate),
    };
    this.events.emit('document.expired', payload);
  }

  private emitExpiringSoon(doc: Document, daysRemaining: number): void {
    const payload: ExpiringSoonEvent = {
      documentId: doc.id,
      ownerType: doc.ownerType,
      ownerId: doc.ownerId,
      type: doc.type,
      daysRemaining,
      expiryDate: toIsoDate(doc.expiryDate),
    };
    this.events.emit('document.expiring_soon', payload);
  }

  /**
   * Returns true if a state transition was actually applied. Returns
   * false when the owner is already suspended / retired / in any
   * state where the suspension transition isn't declared — those are
   * not errors, just no-ops for the cron.
   */
  private async suspendOwner(doc: Document): Promise<boolean> {
    let success = false;
    switch (doc.ownerType) {
      case DocumentOwnerType.USER:
        success = await this.suspendDriverByUserId(doc.ownerId);
        break;
      case DocumentOwnerType.VEHICLE:
        success = await this.suspendVehicle(doc.ownerId);
        break;
      case DocumentOwnerType.COMPANY:
        success = await this.suspendCompany(doc.ownerId);
        break;
    }
    if (success) {
      const payload: OwnerSuspendedEvent = {
        ownerType: doc.ownerType,
        ownerId: doc.ownerId,
        triggeringDocumentId: doc.id,
        triggeringDocType: doc.type,
      };
      this.events.emit('owner.suspended_docs_expired', payload);
    }
    return success;
  }

  private async suspendDriverByUserId(userId: string): Promise<boolean> {
    const profile = await this.driverProfileRepo.findOne({
      where: { userId },
    });
    if (!profile) return false;
    if (
      !driverStateMachine.canTransition(
        profile.verificationStatus,
        DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED,
      )
    ) {
      return false;
    }
    // D1 — route through transitionVerification so the audit ledger
    // records a row (reviewerId=NULL = system). isOnline=false is
    // set inside the canonical transition path.
    try {
      await this.driversService.transitionVerification(
        profile.id,
        { status: DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED },
        null,
      );
      return true;
    } catch (err) {
      // canTransition gated above, so the only realistic failures
      // are concurrent state flips. Log + skip.
      if (err instanceof BadRequestException) return false;
      throw err;
    }
  }

  private async suspendVehicle(vehicleId: string): Promise<boolean> {
    const vehicle = await this.vehicleRepo.findOne({
      where: { id: vehicleId },
    });
    if (!vehicle) return false;
    if (
      !vehicleStateMachine.canTransition(
        vehicle.status,
        VehicleStatus.SUSPENDED,
      )
    ) {
      return false;
    }
    vehicle.status = VehicleStatus.SUSPENDED;
    await this.vehicleRepo.save(vehicle);
    return true;
  }

  private async suspendCompany(companyId: string): Promise<boolean> {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) return false;
    if (
      !companyStateMachine.canTransition(
        company.status,
        CompanyStatus.SUSPENDED,
      )
    ) {
      return false;
    }
    company.status = CompanyStatus.SUSPENDED;
    await this.companyRepo.save(company);
    return true;
  }

  private async reactivateDriverByUserId(userId: string): Promise<boolean> {
    const profile = await this.driverProfileRepo.findOne({
      where: { userId },
    });
    if (!profile) return false;
    if (
      profile.verificationStatus !==
      DriverVerificationStatus.SUSPENDED_DOCS_EXPIRED
    ) {
      return false;
    }
    // D1 — system-driven reactivation via the canonical entry point.
    // approval_decisions row records RESUME with reviewerId=NULL.
    try {
      await this.driversService.transitionVerification(
        profile.id,
        { status: DriverVerificationStatus.ACTIVE },
        null,
      );
      return true;
    } catch (err) {
      if (err instanceof BadRequestException) return false;
      throw err;
    }
  }

  private async reactivateVehicle(vehicleId: string): Promise<boolean> {
    const vehicle = await this.vehicleRepo.findOne({
      where: { id: vehicleId },
    });
    if (!vehicle) return false;
    if (vehicle.status !== VehicleStatus.SUSPENDED) return false;
    vehicle.status = VehicleStatus.ACTIVE;
    await this.vehicleRepo.save(vehicle);
    return true;
  }

  private async reactivateCompany(companyId: string): Promise<boolean> {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) return false;
    if (company.status !== CompanyStatus.SUSPENDED) return false;
    company.status = CompanyStatus.APPROVED;
    await this.companyRepo.save(company);
    return true;
  }
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function diffInDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function toIsoDate(d: Date | null): string {
  if (!d) return '';
  const iso = d.toISOString();
  return iso.slice(0, 10);
}
