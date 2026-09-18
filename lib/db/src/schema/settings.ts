import { pgTable, serial, text, numeric, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const businessSettingsTable = pgTable("business_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().default(0),
  businessName: text("business_name").notNull().default("My Jewellery Store"),
  gstin: text("gstin").notNull().default(""),
  address: text("address").notNull().default(""),
  mobile: text("mobile").notNull().default(""),
  email: text("email"),
  logo: text("logo"),
  gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull().default("3"),
  // 2-digit GST state code (e.g. "27" = Maharashtra) — compared against a customer's own
  // stateCode to decide CGST+SGST (same state) vs IGST (different state) on a sale.
  stateCode: text("state_code"),
  // Whether old-gold-exchange value nets down a sale's GST-taxable base (current/legacy
  // behavior) or the sale is taxed on its full pre-exchange value instead. Left as a
  // per-shop toggle rather than a hardcoded legal interpretation — confirm with your CA.
  gstOnExchangeEnabled: boolean("gst_on_exchange_enabled").notNull().default(true),
  // Same-day cash-receipt threshold to flag for TCS/Sec.269ST awareness (informational only).
  cashTransactionLimit: numeric("cash_transaction_limit", { precision: 12, scale: 2 }).notNull().default("200000"),
  defaultBranch: text("default_branch").notNull().default("Main"),
  branches: text("branches").notNull().default("Main"),
  whatsappApiEnabled: boolean("whatsapp_api_enabled").notNull().default(false),
  whatsappPhoneNumberId: text("whatsapp_phone_number_id"),
  whatsappAccessToken: text("whatsapp_access_token"),
  // Optional loyalty points program for purchases (Sales only — not Girvi loans).
  // loyaltyPointsRate = rupees a customer must spend to earn 1 point.
  loyaltyPointsEnabled: boolean("loyalty_points_enabled").notNull().default(true),
  loyaltyPointsRate: numeric("loyalty_points_rate", { precision: 10, scale: 2 }).notNull().default("1000"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // Read on nearly every request that touches settings, WhatsApp, girvi/accounting lazy
  // init or a GST report, always as "latest row for this shop" — and until now with no
  // index at all, so each of those was a sequential scan of every shop's settings.
  index("business_settings_user_idx").on(t.userId, t.id.desc()),
]);

export const insertBusinessSettingsSchema = createInsertSchema(businessSettingsTable).omit({ id: true, updatedAt: true });
export type InsertBusinessSettings = z.infer<typeof insertBusinessSettingsSchema>;
export type BusinessSettings = typeof businessSettingsTable.$inferSelect;
