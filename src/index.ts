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
			console.log(JSON.stringify({ subject, result }));
			await notify(env, subject, text);
		} catch (err) {
			const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
			console.error(`Sync for ${date} failed`, message);
			await notify(env, `Daycare sync ${date} FAILED`, `The Tadpoles → Huckleberry sync failed:\n\n${message}`, true);
			throw err;
		}
	},

	/**
	 * Manual runs: GET /sync?date=YYYY-MM-DD[&write=1] with "Authorization: Bearer <SYNC_TOKEN>".
	 * Dry run unless write=1.
	 */
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/sync") return new Response("Not found", { status: 404 });
		if (!(await authorized(request, env.SYNC_TOKEN))) return new Response("Unauthorized", { status: 401 });

		const date = url.searchParams.get("date") ?? localDate(new Date(), env.TIMEZONE);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response("date must be YYYY-MM-DD", { status: 400 });

		const result = await syncDate(env, date, url.searchParams.get("write") !== "1");
		return Response.json({ summary: summarize(result, env.TIMEZONE), result });
	},
} satisfies ExportedHandler<Env>;

async function authorized(request: Request, token: string): Promise<boolean> {
	if (!token) return false;
	const given = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(token))]);
	return crypto.subtle.timingSafeEqual(a, b);
}
