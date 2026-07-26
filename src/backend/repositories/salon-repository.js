import { db } from "../../drizzle/db.js";
import { salons } from "../../drizzle/schema.js";
import { asc, count, eq } from "drizzle-orm";
export class SalonRepository {
    async listPaginated(limit, offset) {
        const [rows, totalResult] = await Promise.all([
            db.select().from(salons).orderBy(asc(salons.createdAt)).limit(limit).offset(offset),
            db.select({ value: count() }).from(salons),
        ]);
        return { rows, total: totalResult[0]?.value ?? 0 };
    }
    async create(data) {
        const created = await db.insert(salons).values(data).returning();
        return created[0] ?? null;
    }
    async update(id, data) {
        const updated = await db.update(salons).set(data).where(eq(salons.id, id)).returning();
        return updated[0] ?? null;
    }
    async remove(id) {
        const deleted = await db.delete(salons).where(eq(salons.id, id)).returning();
        return deleted[0] ?? null;
    }
}
