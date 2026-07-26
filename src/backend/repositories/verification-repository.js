import { db } from "../../drizzle/db.js";
import { verifications } from "../../drizzle/schema.js";
import { and, eq, gt } from "drizzle-orm";
export class VerificationRepository {
    async create(identifier, value, expiresAt) {
        const [row] = await db
            .insert(verifications)
            .values({
            identifier,
            value,
            type: "staff_otp",
            expiresAt,
        })
            .returning();
        return row ?? null;
    }
    async verifyAndConsume(identifier, code) {
        const now = new Date();
        const row = await db.query.verifications.findFirst({
            where: and(eq(verifications.identifier, identifier), eq(verifications.value, code), gt(verifications.expiresAt, now)),
        });
        if (!row)
            return false;
        await db.delete(verifications).where(eq(verifications.identifier, identifier));
        return true;
    }
    async deleteByIdentifier(identifier) {
        await db.delete(verifications).where(eq(verifications.identifier, identifier));
    }
}
