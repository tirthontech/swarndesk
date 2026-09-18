import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import { partnersTable } from "./partner";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  shopName: text("shop_name").notNull(),
  mobile: text("mobile"),
  role: text("role").notNull().default("user"), // 'user' | 'admin'
  plan: text("plan").notNull().default("trial"), // 'trial' | 'active' | 'expired'
  trialEndsAt: timestamp("trial_ends_at").notNull(),
  subscriptionEndsAt: timestamp("subscription_ends_at"),
  // Which partner (if any) referred this shop in — set once, at whichever comes first
  // (signup with a ?ref= code, or later crediting a code at checkout), and never
  // overwritten afterward. Null means organic/unattributed. See partner.ts.
  partnerId: integer("partner_id").references(() => partnersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // Every partner dashboard load lists that partner's referred shops (routes/partner.ts).
  // Partial: the overwhelming majority of rows are organic signups with a null partnerId,
  // and excluding them keeps this index a small fraction of the table's size.
  index("users_partner_idx").on(t.partnerId).where(sql`${t.partnerId} is not null`),
]);

export const paymentRequestsTable = pgTable("payment_requests", {
  id: serial("id").primaryKey(),
  // Nullable + set-null-on-delete: deleting a user must not delete their payment history,
  // or revenue/MRR figures would retroactively shrink. Identity is preserved via the
  // snapshot columns below, captured at request-creation time.
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  userNameSnapshot: text("user_name_snapshot"),
  userEmailSnapshot: text("user_email_snapshot"),
  shopNameSnapshot: text("shop_name_snapshot"),
  amount: integer("amount").notNull().default(2500),
  // Which pricing tier the user claims to have paid for (see PLANS in
  // artifacts/api-server/src/plans.ts) — nullable because rows created before
  // this column existed never recorded one. `amount` above is always
  // server-derived from this at submission time, never taken from the client.
  planId: text("plan_id"),
  durationDays: integer("duration_days"),
  utrNumber: text("utr_number"),
  status: text("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
}, (t) => [
  // The billing page's "my requests, newest first".
  index("payment_requests_user_idx").on(t.userId, t.createdAt.desc()),
  // The admin queue polls for pending rows, and revenue stats scan approved ones.
  index("payment_requests_status_idx").on(t.status, t.createdAt.desc()),
]);

// Admin action audit trail — who did what to which account and when.
export const adminActivityLogTable = pgTable("admin_activity_log", {
  id: serial("id").primaryKey(),
  adminId: integer("admin_id").references(() => usersTable.id, { onDelete: "set null" }),
  adminEmailSnapshot: text("admin_email_snapshot").notNull(),
  action: text("action").notNull(), // e.g. 'approve_payment' | 'reject_payment' | 'plan_change' | 'delete_user'
  targetUserId: integer("target_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  targetLabelSnapshot: text("target_label_snapshot"), // e.g. "Jane Doe (jane@shop.com)" — kept even after target is deleted
  details: text("details"), // short human-readable summary, e.g. "Approved 30d, UTR 12345"
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // Admin audit view is always "most recent N" — this turns it into a limited index scan
  // rather than sorting an ever-growing log on every page load.
  index("admin_activity_created_idx").on(t.createdAt.desc()),
]);

// CRM-lite notes admins keep on a user's account (renewal follow-ups, support context, etc.)
export const userNotesTable = pgTable("user_notes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  adminId: integer("admin_id").references(() => usersTable.id, { onDelete: "set null" }),
  adminEmailSnapshot: text("admin_email_snapshot").notNull(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("user_notes_user_idx").on(t.userId, t.createdAt.desc()),
]);

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, passwordHash: true, role: true, plan: true, trialEndsAt: true, partnerId: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
