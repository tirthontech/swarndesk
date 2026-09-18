import { pgTable, serial, numeric, timestamp, text, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const metalRatesTable = pgTable("metal_rates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().default(0),
  gold22k: numeric("gold22k", { precision: 10, scale: 2 }).notNull(),
  gold24k: numeric("gold24k", { precision: 10, scale: 2 }).notNull(),
  gold18k: numeric("gold18k", { precision: 10, scale: 2 }).notNull(),
  silver: numeric("silver", { precision: 10, scale: 2 }).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // Every read is "latest row for this shop" (order by id desc limit 1) — the descending
  // id makes that an index-only backwards scan of one row instead of a table scan + sort.
  index("metal_rates_user_idx").on(t.userId, t.id.desc()),
]);

export const rateHistoryTable = pgTable("rate_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().default(0),
  gold22k: numeric("gold22k", { precision: 10, scale: 2 }).notNull(),
  silver: numeric("silver", { precision: 10, scale: 2 }).notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
}, (t) => [
  index("rate_history_user_time_idx").on(t.userId, t.timestamp),
]);

export const insertMetalRatesSchema = createInsertSchema(metalRatesTable).omit({ id: true, updatedAt: true });
export type InsertMetalRates = z.infer<typeof insertMetalRatesSchema>;
export type MetalRates = typeof metalRatesTable.$inferSelect;
