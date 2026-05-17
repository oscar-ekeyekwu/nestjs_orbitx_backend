import { BadRequestException } from '@nestjs/common';

/**
 * Role bound to a transition. `'admin'` requires an admin user driving the
 * mutation; `'system'` is used for transitions driven by scheduled jobs
 * (e.g., document-expiry cron flipping a driver to `suspended_docs_expired`)
 * and must NOT be reachable from user-driven controllers.
 *
 * `requiredRole` is purely declarative metadata — the helper itself does
 * not check who is calling. Services layer their own guard on top using
 * the role exposed by the request context.
 */
export type TransitionRole = 'admin' | 'system';

export interface Transition<S extends string> {
  readonly from: S;
  readonly to: S;
  readonly requiredRole?: TransitionRole;
}

/**
 * Generic, audit-friendly state machine for entities backed by a status
 * column. Pattern is the same for every entity:
 *
 *   1. `assertTransition(current, target, errorCode)` BEFORE the save.
 *   2. Persist the new status inside a database transaction.
 *   3. Insert an `approval_decisions` row inside the **same** transaction
 *      so audit and state always agree.
 *
 * The helper only owns step 1. Steps 2 and 3 are the calling service's
 * responsibility — keeping this class free of TypeORM keeps it
 * unit-testable without a database and reusable wherever a small state
 * graph is needed.
 */
export class StateMachine<S extends string> {
  private readonly allowed: Map<S, Set<S>> = new Map();

  constructor(private readonly transitions: ReadonlyArray<Transition<S>>) {
    for (const t of transitions) {
      let bucket = this.allowed.get(t.from);
      if (!bucket) {
        bucket = new Set();
        this.allowed.set(t.from, bucket);
      }
      bucket.add(t.to);
    }
  }

  /** True if `from → to` is one of the declared transitions. */
  canTransition(from: S, to: S): boolean {
    return this.allowed.get(from)?.has(to) ?? false;
  }

  /**
   * Look up the metadata for a given `from → to` edge. Returns `undefined`
   * if the transition is not declared (use `canTransition` to gate first).
   */
  getTransition(from: S, to: S): Transition<S> | undefined {
    return this.transitions.find((t) => t.from === from && t.to === to);
  }

  /**
   * Throw a typed `BadRequestException` if the transition is not allowed.
   * Pass the entity-specific error code (e.g. `'DRIVER_002'`,
   * `'VEHICLE_001'`, `'COMPANY_001'`) so the API surface stays uniform.
   */
  assertTransition(from: S, to: S, errorCode: string): void {
    if (!this.canTransition(from, to)) {
      throw new BadRequestException({
        errorCode,
        message: `Invalid transition: ${from} → ${to}`,
      });
    }
  }

  /** Every legal `to` state from `from`. Useful for admin UIs. */
  nextStates(from: S): readonly S[] {
    const bucket = this.allowed.get(from);
    return bucket ? [...bucket] : [];
  }

  /** All declared transitions — handy for snapshot tests + admin tooling. */
  listTransitions(): readonly Transition<S>[] {
    return this.transitions;
  }
}
