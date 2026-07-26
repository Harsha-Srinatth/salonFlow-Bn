import { bigint, boolean, doublePrecision, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar, } from "drizzle-orm/pg-core";
export const userRoleEnum = pgEnum("user_role", [
    "USER",
    "ADMIN",
    "STAFF",
    "RECEPTIONIST",
]);
/** STAFF = Employee. Firebase customers default ACTIVE; staff onboarding uses PENDING_VERIFICATION → ACTIVE. */
export const accountStatusEnum = pgEnum("account_status", [
    "ACTIVE",
    "PENDING_VERIFICATION",
]);
export const referralStatusEnum = pgEnum("referral_status", [
    "PENDING",
    "FIRST_ACTION_DONE",
    "COOLING",
    "APPROVED",
    "REWARDED",
    "REJECTED",
]);
export const walletTransactionTypeEnum = pgEnum("wallet_transaction_type", [
    "CREDIT",
    "DEBIT",
]);
export const walletTransactionSourceEnum = pgEnum("wallet_transaction_source", [
    "REFERRAL",
    "BOOKING",
    "ADMIN",
    "ADJUSTMENT",
]);
export const walletTransactionStatusEnum = pgEnum("wallet_transaction_status", [
    "PENDING",
    "COMPLETED",
    "FAILED",
    "REVERSED",
]);
export const users = pgTable("users", {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    phone: varchar("phone", { length: 20 }).notNull().unique(),
    firebaseUid: varchar("firebase_uid", { length: 255 }).unique(),
    role: userRoleEnum("role").notNull().default("USER"),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),
    deviceId: varchar("device_id", { length: 255 }).unique(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    referralCode: varchar("referral_code", { length: 64 }).unique(),
    referredBy: uuid("referred_by").references(() => users.id, {
        onDelete: "set null",
    }),
    walletBalance: bigint("wallet_balance", { mode: "number" }).notNull().default(0),
    isFirstBookingDone: boolean("is_first_booking_done").notNull().default(false),
    isUnderReview: boolean("is_under_review").notNull().default(false),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }).unique(),
    accountStatus: accountStatusEnum("account_status").notNull().default("ACTIVE"),
    passwordHash: varchar("password_hash", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    index("users_email_idx").on(table.email),
    index("users_phone_idx").on(table.phone),
    index("users_role_idx").on(table.role),
    index("users_created_at_idx").on(table.createdAt),
    index("users_referred_by_idx").on(table.referredBy),
    index("users_device_id_idx").on(table.deviceId),
    uniqueIndex("users_referral_code_uq").on(table.referralCode),
]);
export const salons = pgTable("salons", {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    address: text("address").notNull(),
    pincode: varchar("pincode", { length: 20 }).notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    ownerId: uuid("owner_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
    phone: varchar("phone", { length: 20 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    index("salons_pincode_idx").on(table.pincode),
    index("salons_owner_id_idx").on(table.ownerId),
    index("salons_created_at_idx").on(table.createdAt),
]);
export const salonMembers = pgTable("salon_members", {
    id: uuid("id").defaultRandom().primaryKey(),
    salonId: uuid("salon_id")
        .notNull()
        .references(() => salons.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    role: userRoleEnum("role").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    uniqueIndex("salon_members_salon_user_uq").on(table.salonId, table.userId),
    index("salon_members_user_id_idx").on(table.userId),
    index("salon_members_role_idx").on(table.role),
]);
export const sessions = pgTable("sessions", {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 512 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    deviceId: varchar("device_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
    index("sessions_ip_address_idx").on(table.ipAddress),
    index("sessions_device_id_idx").on(table.deviceId),
]);
export const accounts = pgTable("accounts", {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 100 }).notNull(),
    providerAccountId: varchar("provider_account_id", { length: 255 }).notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    uniqueIndex("accounts_provider_provider_account_uq").on(table.provider, table.providerAccountId),
    index("accounts_user_id_idx").on(table.userId),
]);
export const verifications = pgTable("verifications", {
    id: uuid("id").defaultRandom().primaryKey(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    value: varchar("value", { length: 255 }).notNull(),
    type: varchar("type", { length: 64 }).notNull().default("otp"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    index("verifications_identifier_idx").on(table.identifier),
    index("verifications_expires_at_idx").on(table.expiresAt),
]);
export const referrals = pgTable("referrals", {
    id: uuid("id").defaultRandom().primaryKey(),
    referrerId: uuid("referrer_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    referredUserId: uuid("referred_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    status: referralStatusEnum("status").notNull().default("PENDING"),
    firstActionAt: timestamp("first_action_at", { withTimezone: true }),
    coolingUntil: timestamp("cooling_until", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rewardedAt: timestamp("rewarded_at", { withTimezone: true }),
    rejectedReason: text("rejected_reason"),
    rewardAmount: integer("reward_amount").notNull().default(100),
    rewardGiven: boolean("reward_given").notNull().default(false),
    ipAddress: varchar("ip_address", { length: 64 }),
    deviceId: varchar("device_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    uniqueIndex("referrals_referrer_referred_uq").on(table.referrerId, table.referredUserId),
    index("referrals_referred_user_id_idx").on(table.referredUserId),
    index("referrals_status_idx").on(table.status),
    index("referrals_created_at_idx").on(table.createdAt),
    index("referrals_device_id_idx").on(table.deviceId),
]);
export const devices = pgTable("devices", {
    id: uuid("id").defaultRandom().primaryKey(),
    deviceId: varchar("device_id", { length: 255 }).notNull().unique(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    firstSeenIp: varchar("first_seen_ip", { length: 64 }),
    lastSeenIp: varchar("last_seen_ip", { length: 64 }),
    isSuspicious: boolean("is_suspicious").notNull().default(false),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    index("devices_user_id_idx").on(table.userId),
    index("devices_is_suspicious_idx").on(table.isSuspicious),
]);
export const walletTransactions = pgTable("wallet_transactions", {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    type: walletTransactionTypeEnum("type").notNull(),
    source: walletTransactionSourceEnum("source").notNull(),
    status: walletTransactionStatusEnum("status").notNull().default("COMPLETED"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    referralId: uuid("referral_id").references(() => referrals.id, { onDelete: "set null" }),
    description: text("description"),
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    index("wallet_transactions_user_id_idx").on(table.userId),
    index("wallet_transactions_status_idx").on(table.status),
    index("wallet_transactions_created_at_idx").on(table.createdAt),
]);
export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: varchar("event_id", { length: 255 }).notNull().unique(),
    eventType: varchar("event_type", { length: 255 }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    index("stripe_webhook_events_event_id_idx").on(table.eventId),
    index("stripe_webhook_events_processed_at_idx").on(table.processedAt),
]);
