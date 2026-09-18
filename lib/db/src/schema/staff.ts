import { pgTable, serial, text, integer, timestamp, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A shop's staff logins — distinct from usersTable, which is the shop OWNER's own account.
// Every staff row is scoped to one owner (ownerUserId) and logs in with its own email/
// password, but all their work reads/writes the owner's data (every other table's userId
// still equals ownerUserId — see requireShopRole in middleware/auth.ts for how a staff JWT
// carries both its own staffId/role and the owner's userId for that scoping).
export const staffTable = pgTable("staff", {
  id: serial("id").primaryKey(),
  ownerUserId: integer("owner_user_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  mobile: text("mobile"),
  passwordHash: text("password_hash").notNull(),
  // admin: everything the owner can do, except managing other staff/deleting the shop.
  // accountant: full Accounting module access, no Settings/Staff access.
  // salesperson: Billing/Customers/Inventory/Repairs/Custom Orders — no Settings/Accounting/Staff.
  role: text("role").notNull().default("salesperson"), // admin | accountant | salesperson
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // Email only needs to be unique within one shop — two different shops can each have
  // their own "priya@gmail.com" salesperson without colliding.
  uniqueIndex("staff_owner_email_idx").on(t.ownerUserId, t.email),
  index("staff_owner_idx").on(t.ownerUserId),
  // Login looks a staff member up by email ALONE (routes/auth.ts loginAsStaff — the shop
  // isn't known until the row is found). The composite above can't serve that, because
  // email isn't its leading column, so without this every staff sign-in sequentially
  // scans the whole staff table across all shops.
  index("staff_email_idx").on(t.email),
]);

export const insertStaffSchema = createInsertSchema(staffTable).omit({ id: true, createdAt: true, passwordHash: true });
export type InsertStaff = z.infer<typeof insertStaffSchema>;
export type Staff = typeof staffTable.$inferSelect;
