/**
 * The jobs cap's switches (docs/CAPABILITIES.md, section 5), read straight from process.env, so lib/env.ts and the cap's
 * prompt text can both read them without an import cycle. lib/env.ts's getter calls this.
 */
export const jobsWebhooksOn = (): boolean => ["1", "true", "yes", "on"].includes((process.env.JOBS_WEBHOOKS ?? "").trim().toLowerCase());
