import { safeDiagnostic } from "./errors";
import { notify, summarize } from "./notify";
import { syncDate } from "./sync";
import { localDate, localHour } from "./time";

export default {
	async scheduled(controller, env, ctx): Promise<void> {
		const firedAt = new Date(controller.scheduledTime);
		// Two UTC crons cover daylight saving; only the one landing on SYNC_HOUR local time runs.
		if (localHour(firedAt, env.TIMEZONE) !== Number(env.SYNC_HOUR)) {
			console.log(`Skipping cron ${controller.cron}: not ${env.SYNC_HOUR}:00 in ${env.TIMEZONE}`);
			return;
		}
		const date = localDate(firedAt, env.TIMEZONE);
		try {
			const result = await syncDate(env, date, false);
			const { subject, text } = summarize(result, env.TIMEZONE);
			console.log("Scheduled sync completed");
			await notify(env, env.NOTIFICATION_DETAILS === "true" ? subject : "Daycare sync completed",
				env.NOTIFICATION_DETAILS === "true" ? text : "Sync completed. Use an authenticated manual dry run to review details.");
		} catch (error) {
			console.error("Scheduled sync or notification failed", safeDiagnostic(error));
			try {
				await notify(env, "Daycare sync FAILED", "The sync or its notification failed. Review account access and retry with an authenticated manual dry run.", true);
			} catch {
				console.error("Failure notification could not be delivered");
			}
			throw new Error("Scheduled sync or notification failed");
		}
	},

	/** Manual runs are opt-in; GET previews, POST with write=1 writes. */
	async fetch(request, env): Promise<Response> {
		const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Sync-Build": "login-diagnostics-v3" };
		const reply = (body: string, status: number) => new Response(body, { status, headers });
		const url = new URL(request.url);
		if (env.MANUAL_SYNC_ENABLED !== "true" || url.pathname !== "/sync") return reply("Not found", 404);
		if (!(await authorized(request, env.SYNC_TOKEN))) return reply("Unauthorized", 401);
		if (request.method !== "GET" && request.method !== "POST") {
			return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, POST" } });
		}
		const write = url.searchParams.get("write");
		if (write !== null && write !== "1") return reply("write must be 1 or omitted", 400);
		if (write === "1" && request.method !== "POST") return reply("Writes require POST", 405);
		const date = url.searchParams.get("date") ?? localDate(new Date(), env.TIMEZONE);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
			return reply("date must be a valid YYYY-MM-DD", 400);
		}
		try {
			const result = await syncDate(env, date, write !== "1");
			return Response.json({ summary: summarize(result, env.TIMEZONE), result }, { headers });
		} catch (error) {
			return reply(safeDiagnostic(error), 502);
		}
	},
} satisfies ExportedHandler<Env>;

async function authorized(request: Request, token: string): Promise<boolean> {
	if (!token || token.length < 32) return false;
	const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("Authorization") ?? "");
	if (!match || match[1].length > 1024) return false;
	const given = match[1];
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(token))]);
	return crypto.subtle.timingSafeEqual(a, b);
}
