import { db } from "../../drizzle/db.js";
import { stripeWebhookEvents } from "../../drizzle/schema.js";
import { eq } from "drizzle-orm";
export class StripeWebhookRepository {
    async isProcessed(eventId) {
        const row = await db.query.stripeWebhookEvents.findFirst({
            where: eq(stripeWebhookEvents.eventId, eventId),
        });
        return Boolean(row);
    }
    async markProcessed(eventId, eventType) {
        const inserted = await db
            .insert(stripeWebhookEvents)
            .values({ eventId, eventType })
            .onConflictDoNothing()
            .returning();
        return Boolean(inserted[0]);
    }
}
