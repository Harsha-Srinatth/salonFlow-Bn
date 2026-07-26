export class StripeWebhookService {
    constructor(repository) {
        this.repository = repository;
    }
    async executeOnce(eventId, eventType, handler) {
        const alreadyProcessed = await this.repository.isProcessed(eventId);
        if (alreadyProcessed)
            return { processed: false };
        await handler();
        const inserted = await this.repository.markProcessed(eventId, eventType);
        return { processed: inserted };
    }
}
