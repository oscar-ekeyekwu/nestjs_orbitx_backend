import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialMigration1760242168697 implements MigrationInterface {
    name = 'InitialMigration1760242168697'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('customer', 'driver', 'admin')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "first_name" character varying NOT NULL, "last_name" character varying NOT NULL, "password" character varying, "phone" character varying, "avatar" character varying, "role" "public"."users_role_enum" NOT NULL DEFAULT 'customer', "googleId" character varying, "isEmailVerified" boolean NOT NULL DEFAULT false, "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."orders_status_enum" AS ENUM('pending', 'accepted', 'picked_up', 'in_transit', 'delivered', 'cancelled')`);
        await queryRunner.query(`CREATE TYPE "public"."orders_packagesize_enum" AS ENUM('small', 'medium', 'large')`);
        await queryRunner.query(`CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "customerId" uuid NOT NULL, "driverId" uuid, "status" "public"."orders_status_enum" NOT NULL DEFAULT 'pending', "pickupLatitude" numeric(10,7) NOT NULL, "pickupLongitude" numeric(10,7) NOT NULL, "pickupAddress" character varying NOT NULL, "deliveryLatitude" numeric(10,7) NOT NULL, "deliveryLongitude" numeric(10,7) NOT NULL, "deliveryAddress" character varying NOT NULL, "recipientName" character varying NOT NULL, "recipientPhone" character varying NOT NULL, "packageDescription" character varying NOT NULL, "packageWeight" numeric(5,2), "packageSize" "public"."orders_packagesize_enum" NOT NULL DEFAULT 'medium', "deliveryNotes" text, "estimatedPrice" numeric(10,2) NOT NULL, "finalPrice" numeric(10,2), "acceptedAt" TIMESTAMP, "pickedUpAt" TIMESTAMP, "deliveredAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "driverLatitude" numeric(10,7), "driverLongitude" numeric(10,7), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."notifications_type_enum" AS ENUM('order_created', 'order_accepted', 'order_picked_up', 'order_in_transit', 'order_delivered', 'order_cancelled', 'payment_success', 'payment_failed', 'new_message')`);
        await queryRunner.query(`CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "type" "public"."notifications_type_enum" NOT NULL, "title" character varying NOT NULL, "message" text NOT NULL, "data" json, "isRead" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "driver_profiles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "isOnline" boolean NOT NULL DEFAULT false, "isOnDelivery" boolean NOT NULL DEFAULT false, "currentLatitude" numeric(10,7), "currentLongitude" numeric(10,7), "vehicleType" character varying, "vehiclePlate" character varying, "licenseNumber" character varying, "totalDeliveries" integer NOT NULL DEFAULT '0', "rating" numeric(3,2) NOT NULL DEFAULT '0', "totalRatings" integer NOT NULL DEFAULT '0', "totalEarnings" numeric(12,2) NOT NULL DEFAULT '0', "isVerified" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "REL_c22d0ffc4bff60e9a39c003759" UNIQUE ("userId"), CONSTRAINT "PK_6e002fc8a835351e070978fcad4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_e5de51ca888d8b1f5ac25799dd1" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_18dc786cf29d6ef99980ba6ae63" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_692a909ee0fa9383e7859f9b406" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "driver_profiles" ADD CONSTRAINT "FK_c22d0ffc4bff60e9a39c0037590" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "driver_profiles" DROP CONSTRAINT "FK_c22d0ffc4bff60e9a39c0037590"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_692a909ee0fa9383e7859f9b406"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_18dc786cf29d6ef99980ba6ae63"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_e5de51ca888d8b1f5ac25799dd1"`);
        await queryRunner.query(`DROP TABLE "driver_profiles"`);
        await queryRunner.query(`DROP TABLE "notifications"`);
        await queryRunner.query(`DROP TYPE "public"."notifications_type_enum"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        await queryRunner.query(`DROP TYPE "public"."orders_packagesize_enum"`);
        await queryRunner.query(`DROP TYPE "public"."orders_status_enum"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
    }

}
