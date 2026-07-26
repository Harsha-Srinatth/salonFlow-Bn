import { db } from "../../drizzle/db.js";
import { users } from "../../drizzle/schema.js";
import { asc, count, eq, inArray } from "drizzle-orm";
export class UserRepository {
    async findByFirebaseUid(firebaseUid) {
        return db.query.users.findFirst({ where: eq(users.firebaseUid, firebaseUid) });
    }
    async findByPhone(phone) {
        return db.query.users.findFirst({ where: eq(users.phone, phone) });
    }
    async findByEmail(email) {
        return db.query.users.findFirst({ where: eq(users.email, email) });
    }
    async findById(id) {
        return db.query.users.findFirst({ where: eq(users.id, id) });
    }
    async createFromFirebase(data) {
        const created = await db
            .insert(users)
            .values({
            firebaseUid: data.firebaseUid,
            email: data.email,
            name: data.name,
            role: data.role ?? "USER",
            phone: data.phone,
            latitude: data.latitude ?? 0,
            longitude: data.longitude ?? 0,
            accountStatus: "ACTIVE",
        })
            .returning();
        return created[0] ?? null;
    }
    async listPaginated(limit, offset) {
        const [rows, totalResult] = await Promise.all([
            db.select().from(users).orderBy(asc(users.createdAt)).limit(limit).offset(offset),
            db.select({ value: count() }).from(users),
        ]);
        return { rows, total: totalResult[0]?.value ?? 0 };
    }
    async updateRole(userId, role) {
        const updated = await db
            .update(users)
            .set({ role })
            .where(eq(users.id, userId))
            .returning();
        return updated[0] ?? null;
    }
    async updatePhone(userId, phone) {
        const updated = await db
            .update(users)
            .set({ phone })
            .where(eq(users.id, userId))
            .returning();
        return updated[0] ?? null;
    }
    async createStaffRecord(data) {
        const created = await db
            .insert(users)
            .values({
            name: data.name,
            email: data.email,
            phone: data.phone,
            role: data.role,
            latitude: 0,
            longitude: 0,
            accountStatus: "PENDING_OTP",
            firebaseUid: null,
            passwordHash: null,
        })
            .returning();
        return created[0] ?? null;
    }
    async listStaff(limit, offset) {
        const [rows, totalResult] = await Promise.all([
            db
                .select()
                .from(users)
                .where(inArray(users.role, ["STAFF", "RECEPTIONIST"]))
                .orderBy(asc(users.createdAt))
                .limit(limit)
                .offset(offset),
            db
                .select({ value: count() })
                .from(users)
                .where(inArray(users.role, ["STAFF", "RECEPTIONIST"])),
        ]);
        return { rows, total: totalResult[0]?.value ?? 0 };
    }
    async updateStaff(id, data) {
        const updated = await db.update(users).set(data).where(eq(users.id, id)).returning();
        return updated[0] ?? null;
    }
    async deleteById(id) {
        const deleted = await db.delete(users).where(eq(users.id, id)).returning();
        return deleted[0] ?? null;
    }
}
