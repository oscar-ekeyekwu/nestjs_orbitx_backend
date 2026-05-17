import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ARCH-2 — Consolidated v1 baseline migration.
 *
 * Replaces the prototype-era migrations (now archived under
 * `src/database/migrations/_archived/`). This migration is the single
 * source of truth for the v1 schema; everything that ships after it must
 * be additive and forward-only.
 *
 * Order of operations:
 *   1. Enable required Postgres extensions (uuid-ossp).
 *   2. DROP IF EXISTS every prototype table + enum so the migration is
 *      safe on either a fresh DB or a database carrying prototype state.
 *      Pre-launch reset means we don't need data preservation.
 *   3. CREATE every v1 enum, then every v1 table in FK dependency order.
 *   4. CREATE non-PK indexes (incl. the unique partial index on
 *      vehicle_assignments where unassignedAt IS NULL).
 *   5. GRANT INSERT/SELECT + REVOKE UPDATE/DELETE on the audit tables
 *      (transactions, approval_decisions) for the `orbit_app` role
 *      (NFR-S5). Wrapped in a DO block so dev environments that don't
 *      have the role still run cleanly.
 *
 * Down() drops every v1 table and enum and is provided for local rollback
 * only — production never reverts a baseline.
 */
export class InitialV1Migration1779840000000 implements MigrationInterface {
  name = 'InitialV1Migration1779840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── Extensions ─────────────────────────────────────────────────────
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ─── Drop prototype tables (FK-reverse order, IF EXISTS) ────────────
    const prototypeTables = [
      'notification_templates',
      'support_tickets',
      'verification_codes',
      'device_tokens',
      'refresh_tokens',
      'transactions',
      'virtual_accounts',
      'wallets',
      'notifications',
      'orders',
      'driver_profiles',
      'documents',
      'approval_decisions',
      'vehicle_assignments',
      'vehicles',
      'company_memberships',
      'companies',
      'faqs',
      'system_configs',
      'users',
    ];
    for (const table of prototypeTables) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    const prototypeEnums = [
      'users_role_enum',
      'orders_status_enum',
      'orders_packagesize_enum',
      'transactions_type_enum',
      'transactions_status_enum',
      'transactions_paymentmethod_enum',
      'notifications_type_enum',
      'notification_templates_eventtype_enum',
      'support_tickets_status_enum',
      'support_tickets_priority_enum',
      'verification_codes_type_enum',
      'companies_status_enum',
      'company_memberships_role_enum',
      'company_memberships_status_enum',
      'vehicles_ownertype_enum',
      'vehicles_type_enum',
      'vehicles_status_enum',
      'vehicle_assignments_status_enum',
      'documents_ownertype_enum',
      'documents_type_enum',
      'documents_status_enum',
      'approval_decisions_targettype_enum',
      'approval_decisions_action_enum',
      'driver_profiles_accounttype_enum',
      'driver_profiles_verificationstatus_enum',
      'device_tokens_platform_enum',
    ];
    for (const e of prototypeEnums) {
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."${e}" CASCADE`);
    }

    // ─── v1 ENUM types ──────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('customer', 'driver', 'admin')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_status_enum" AS ENUM('pending', 'accepted', 'picked_up', 'in_transit', 'delivered', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_packagesize_enum" AS ENUM('small', 'medium', 'large')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum" AS ENUM('credit', 'debit')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_status_enum" AS ENUM('pending', 'completed', 'failed', 'reversed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_paymentmethod_enum" AS ENUM('cash', 'card', 'bank_transfer', 'wallet')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_type_enum" AS ENUM('order_created', 'order_accepted', 'order_picked_up', 'order_in_transit', 'order_delivered', 'order_cancelled', 'payment_success', 'payment_failed', 'new_message')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."support_tickets_status_enum" AS ENUM('open', 'in_progress', 'resolved', 'closed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."support_tickets_priority_enum" AS ENUM('low', 'medium', 'high', 'urgent')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."verification_codes_type_enum" AS ENUM('email', 'phone', 'password_reset')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."companies_status_enum" AS ENUM('pending', 'approved', 'suspended')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."company_memberships_role_enum" AS ENUM('owner', 'employee')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."company_memberships_status_enum" AS ENUM('pending', 'active', 'inactive')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."vehicles_ownertype_enum" AS ENUM('individual_driver', 'company')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."vehicles_type_enum" AS ENUM('motorcycle', 'car', 'van', 'truck', 'bicycle')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."vehicles_status_enum" AS ENUM('draft', 'pending_approval', 'approved', 'active', 'rejected', 'suspended', 'retired')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."documents_ownertype_enum" AS ENUM('user', 'vehicle', 'company')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."documents_type_enum" AS ENUM('drivers_license', 'nin', 'proof_of_address', 'vehicle_registration', 'roadworthy', 'insurance', 'lasaa_permit', 'nipost_license', 'cac_certificate', 'tin_certificate')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."documents_status_enum" AS ENUM('pending', 'approved', 'rejected', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."approval_decisions_targettype_enum" AS ENUM('driver', 'company', 'vehicle', 'document')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."approval_decisions_action_enum" AS ENUM('approve', 'reject', 'suspend', 'resume')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."driver_profiles_accounttype_enum" AS ENUM('individual', 'company_owner', 'company_employee')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."driver_profiles_verificationstatus_enum" AS ENUM('setup_required', 'pending_approval', 'approved', 'active', 'rejected', 'suspended_docs_expired', 'suspended_admin')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."device_tokens_platform_enum" AS ENUM('ios', 'android', 'web')`,
    );

    // ─── users ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying NOT NULL,
        "first_name" character varying NOT NULL,
        "last_name" character varying NOT NULL,
        "password" character varying,
        "phone" character varying,
        "avatar" character varying,
        "role" "public"."users_role_enum" NOT NULL DEFAULT 'customer',
        "googleId" character varying,
        "isEmailVerified" boolean NOT NULL DEFAULT false,
        "isPhoneVerified" boolean NOT NULL DEFAULT false,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);

    // ─── companies + memberships ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "companies" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "legalName" character varying NOT NULL,
        "cacNumber" character varying,
        "tin" character varying,
        "address" text,
        "status" "public"."companies_status_enum" NOT NULL DEFAULT 'pending',
        "createdBy" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_companies" PRIMARY KEY ("id"),
        CONSTRAINT "FK_companies_createdBy" FOREIGN KEY ("createdBy")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_companies_status" ON "companies" ("status")`,
    );

    await queryRunner.query(`
      CREATE TABLE "company_memberships" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "driverId" uuid NOT NULL,
        "companyId" uuid NOT NULL,
        "role" "public"."company_memberships_role_enum" NOT NULL DEFAULT 'employee',
        "status" "public"."company_memberships_status_enum" NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_company_memberships" PRIMARY KEY ("id"),
        CONSTRAINT "FK_company_memberships_driver" FOREIGN KEY ("driverId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_company_memberships_company" FOREIGN KEY ("companyId")
          REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_company_memberships_driver" ON "company_memberships" ("driverId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_company_memberships_company" ON "company_memberships" ("companyId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_company_memberships_status" ON "company_memberships" ("status")`,
    );

    // ─── driver_profiles ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "driver_profiles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "accountType" "public"."driver_profiles_accounttype_enum" NOT NULL DEFAULT 'individual',
        "verificationStatus" "public"."driver_profiles_verificationstatus_enum" NOT NULL DEFAULT 'setup_required',
        "companyId" uuid,
        "isOnline" boolean NOT NULL DEFAULT false,
        "isOnDelivery" boolean NOT NULL DEFAULT false,
        "currentLatitude" numeric(10,7),
        "currentLongitude" numeric(10,7),
        "vehicleType" character varying,
        "vehiclePlate" character varying,
        "licenseNumber" character varying,
        "totalDeliveries" integer NOT NULL DEFAULT 0,
        "rating" numeric(3,2) NOT NULL DEFAULT 0,
        "totalRatings" integer NOT NULL DEFAULT 0,
        "totalEarnings" numeric(12,2) NOT NULL DEFAULT 0,
        "isVerified" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_driver_profiles_userId" UNIQUE ("userId"),
        CONSTRAINT "PK_driver_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "FK_driver_profiles_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_driver_profiles_company" FOREIGN KEY ("companyId")
          REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_profiles_accountType" ON "driver_profiles" ("accountType")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_profiles_verificationStatus" ON "driver_profiles" ("verificationStatus")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_profiles_companyId" ON "driver_profiles" ("companyId")`,
    );

    // ─── vehicles + assignments ─────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "vehicles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ownerType" "public"."vehicles_ownertype_enum" NOT NULL,
        "ownerId" uuid NOT NULL,
        "type" "public"."vehicles_type_enum" NOT NULL,
        "plate" character varying NOT NULL,
        "color" character varying,
        "photoUrl" character varying,
        "status" "public"."vehicles_status_enum" NOT NULL DEFAULT 'draft',
        "approvedAt" TIMESTAMP,
        "approvedBy" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_vehicles_plate" UNIQUE ("plate"),
        CONSTRAINT "PK_vehicles" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_vehicles_ownerType" ON "vehicles" ("ownerType")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vehicles_ownerId" ON "vehicles" ("ownerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vehicles_status" ON "vehicles" ("status")`,
    );

    await queryRunner.query(`
      CREATE TABLE "vehicle_assignments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "driverId" uuid NOT NULL,
        "vehicleId" uuid NOT NULL,
        "assignedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "unassignedAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vehicle_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_vehicle_assignments_driver" FOREIGN KEY ("driverId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_vehicle_assignments_vehicle" FOREIGN KEY ("vehicleId")
          REFERENCES "vehicles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_vehicle_assignments_driver" ON "vehicle_assignments" ("driverId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vehicle_assignments_vehicle" ON "vehicle_assignments" ("vehicleId")`,
    );
    // Partial unique index — one OPEN assignment per vehicle. Historic
    // (unassignedAt IS NOT NULL) rows are unconstrained.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_vehicle_assignments_open_per_vehicle"
        ON "vehicle_assignments" ("vehicleId")
        WHERE "unassignedAt" IS NULL
    `);

    // ─── documents + approval_decisions ─────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "documents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ownerType" "public"."documents_ownertype_enum" NOT NULL,
        "ownerId" uuid NOT NULL,
        "type" "public"."documents_type_enum" NOT NULL,
        "fileUrl" character varying NOT NULL,
        "fileKey" character varying,
        "expiryDate" date,
        "status" "public"."documents_status_enum" NOT NULL DEFAULT 'pending',
        "uploadedBy" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_documents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_documents_uploadedBy" FOREIGN KEY ("uploadedBy")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_ownerType" ON "documents" ("ownerType")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_ownerId" ON "documents" ("ownerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_type" ON "documents" ("type")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_documents_status" ON "documents" ("status")`,
    );

    await queryRunner.query(`
      CREATE TABLE "approval_decisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "targetType" "public"."approval_decisions_targettype_enum" NOT NULL,
        "targetId" uuid NOT NULL,
        "action" "public"."approval_decisions_action_enum" NOT NULL,
        "reviewerId" uuid NOT NULL,
        "reason" text,
        "decidedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_approval_decisions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_approval_decisions_reviewer" FOREIGN KEY ("reviewerId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_approval_decisions_targetType" ON "approval_decisions" ("targetType")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_approval_decisions_targetId" ON "approval_decisions" ("targetId")`,
    );

    // ─── orders ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "orders" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "customerId" uuid NOT NULL,
        "driverId" uuid,
        "status" "public"."orders_status_enum" NOT NULL DEFAULT 'pending',
        "pickupLatitude" numeric(10,7) NOT NULL,
        "pickupLongitude" numeric(10,7) NOT NULL,
        "pickupAddress" character varying NOT NULL,
        "deliveryLatitude" numeric(10,7) NOT NULL,
        "deliveryLongitude" numeric(10,7) NOT NULL,
        "deliveryAddress" character varying NOT NULL,
        "recipientName" character varying NOT NULL,
        "recipientPhone" character varying NOT NULL,
        "packageDescription" character varying NOT NULL,
        "packageWeight" numeric(5,2),
        "packageSize" "public"."orders_packagesize_enum" NOT NULL DEFAULT 'medium',
        "deliveryNotes" text,
        "estimatedPrice" numeric(10,2) NOT NULL,
        "finalPrice" numeric(10,2),
        "acceptedAt" TIMESTAMP,
        "pickedUpAt" TIMESTAMP,
        "deliveredAt" TIMESTAMP,
        "driverLatitude" numeric(10,7),
        "driverLongitude" numeric(10,7),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_orders" PRIMARY KEY ("id"),
        CONSTRAINT "FK_orders_customer" FOREIGN KEY ("customerId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_orders_driver" FOREIGN KEY ("driverId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_status" ON "orders" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_customer" ON "orders" ("customerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_driver" ON "orders" ("driverId")`,
    );

    // ─── wallets + transactions + virtual_accounts ──────────────────────
    await queryRunner.query(`
      CREATE TABLE "wallets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "balance" numeric(12,2) NOT NULL DEFAULT 0,
        "totalEarnings" numeric(12,2) NOT NULL DEFAULT 0,
        "totalWithdrawals" numeric(12,2) NOT NULL DEFAULT 0,
        "pendingBalance" numeric(12,2) NOT NULL DEFAULT 0,
        "isLocked" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_wallets_userId" UNIQUE ("userId"),
        CONSTRAINT "PK_wallets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_wallets_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "walletId" uuid NOT NULL,
        "orderId" uuid,
        "type" "public"."transactions_type_enum" NOT NULL,
        "amount" numeric(12,2) NOT NULL,
        "commission" numeric(12,2) NOT NULL DEFAULT 0,
        "balanceAfter" numeric(12,2) NOT NULL,
        "status" "public"."transactions_status_enum" NOT NULL DEFAULT 'pending',
        "paymentMethod" "public"."transactions_paymentmethod_enum" NOT NULL DEFAULT 'cash',
        "description" text,
        "reference" text,
        "metadata" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_transactions_wallet" FOREIGN KEY ("walletId")
          REFERENCES "wallets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_transactions_order" FOREIGN KEY ("orderId")
          REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_transactions_wallet" ON "transactions" ("walletId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_transactions_order" ON "transactions" ("orderId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "virtual_accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "accountNumber" character varying NOT NULL,
        "bankName" character varying NOT NULL,
        "accountName" character varying NOT NULL,
        "providerReference" character varying NOT NULL,
        "provider" character varying NOT NULL DEFAULT 'paystack',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_virtual_accounts_userId" UNIQUE ("userId"),
        CONSTRAINT "PK_virtual_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_virtual_accounts_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);

    // ─── auth + push artefacts ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "token" character varying NOT NULL,
        "expiresAt" TIMESTAMP NOT NULL,
        "isRevoked" boolean NOT NULL DEFAULT false,
        "deviceId" character varying,
        "ipAddress" character varying,
        "userAgent" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_refresh_tokens_token" UNIQUE ("token"),
        CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "device_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "token" character varying NOT NULL,
        "platform" "public"."device_tokens_platform_enum" NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_device_tokens_token" UNIQUE ("token"),
        CONSTRAINT "PK_device_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_device_tokens_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_device_tokens_user" ON "device_tokens" ("userId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "verification_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "email" character varying,
        "phone" character varying,
        "code" character varying NOT NULL,
        "type" "public"."verification_codes_type_enum" NOT NULL,
        "expiresAt" TIMESTAMP NOT NULL,
        "isUsed" boolean NOT NULL DEFAULT false,
        "usedAt" TIMESTAMP,
        "attempts" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_verification_codes" PRIMARY KEY ("id")
      )
    `);

    // ─── notifications + templates ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "type" "public"."notifications_type_enum" NOT NULL,
        "title" character varying NOT NULL,
        "message" text NOT NULL,
        "data" json,
        "isRead" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notifications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notifications_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "notification_templates" (
        "eventType" "public"."notifications_type_enum" NOT NULL,
        "title" character varying NOT NULL,
        "body" text NOT NULL,
        "emailSubject" character varying,
        "emailBody" text,
        "smsBody" text,
        "isEnabled" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_templates" PRIMARY KEY ("eventType")
      )
    `);

    // ─── support_tickets ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "support_tickets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "subject" character varying NOT NULL,
        "description" text NOT NULL,
        "status" "public"."support_tickets_status_enum" NOT NULL DEFAULT 'open',
        "priority" "public"."support_tickets_priority_enum" NOT NULL DEFAULT 'medium',
        "orderId" uuid,
        "assignedTo" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_tickets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_support_tickets_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_support_tickets_user" ON "support_tickets" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_tickets_status" ON "support_tickets" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_tickets_priority" ON "support_tickets" ("priority")`,
    );

    // ─── system_configs + faqs ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "system_configs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "key" character varying NOT NULL,
        "value" text NOT NULL,
        "description" character varying,
        "dataType" character varying NOT NULL DEFAULT 'string',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_system_configs_key" UNIQUE ("key"),
        CONSTRAINT "PK_system_configs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "faqs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "question" character varying NOT NULL,
        "answer" text NOT NULL,
        "category" character varying NOT NULL DEFAULT 'General',
        "order" integer NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_faqs" PRIMARY KEY ("id")
      )
    `);

    // ─── Audit immutability (NFR-S5) ────────────────────────────────────
    // REVOKE UPDATE/DELETE on transactions + approval_decisions for the
    // `orbit_app` role. Wrapped in a DO block so dev/CI environments that
    // don't provision the role still get a clean migration run; in prod,
    // the GRANTs are what enforce the immutability contract.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbit_app') THEN
          REVOKE UPDATE, DELETE ON TABLE approval_decisions FROM orbit_app;
          REVOKE UPDATE, DELETE ON TABLE transactions FROM orbit_app;
          GRANT INSERT, SELECT ON TABLE approval_decisions TO orbit_app;
          GRANT INSERT, SELECT ON TABLE transactions TO orbit_app;
        ELSE
          RAISE NOTICE 'role orbit_app not found — skipping audit-table GRANT/REVOKE. Configure it before deploying to staging or prod.';
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables in reverse FK dependency order. CASCADE handles any
    // residual indexes / constraints.
    const tablesReverse = [
      'faqs',
      'system_configs',
      'support_tickets',
      'notification_templates',
      'notifications',
      'verification_codes',
      'device_tokens',
      'refresh_tokens',
      'virtual_accounts',
      'transactions',
      'wallets',
      'orders',
      'approval_decisions',
      'documents',
      'vehicle_assignments',
      'vehicles',
      'driver_profiles',
      'company_memberships',
      'companies',
      'users',
    ];
    for (const table of tablesReverse) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    const enums = [
      'device_tokens_platform_enum',
      'driver_profiles_verificationstatus_enum',
      'driver_profiles_accounttype_enum',
      'approval_decisions_action_enum',
      'approval_decisions_targettype_enum',
      'documents_status_enum',
      'documents_type_enum',
      'documents_ownertype_enum',
      'vehicles_status_enum',
      'vehicles_type_enum',
      'vehicles_ownertype_enum',
      'company_memberships_status_enum',
      'company_memberships_role_enum',
      'companies_status_enum',
      'verification_codes_type_enum',
      'support_tickets_priority_enum',
      'support_tickets_status_enum',
      'notifications_type_enum',
      'transactions_paymentmethod_enum',
      'transactions_status_enum',
      'transactions_type_enum',
      'orders_packagesize_enum',
      'orders_status_enum',
      'users_role_enum',
    ];
    for (const e of enums) {
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."${e}" CASCADE`);
    }
  }
}
