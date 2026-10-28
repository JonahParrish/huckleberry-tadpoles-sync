import type { PlannedEntry } from "./mapping";
import type { SyncResult } from "./sync";

export function describeEntry(entry: PlannedEntry, timeZone: string): string {
	const time = (sec: number) => new Date(sec * 1000).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
	switch (entry.kind) {
		case "diaper":
			return `${time(entry.start)} diaper (${entry.mode}${entry.notes ? `, ${entry.notes.toLowerCase()}` : ""})`;
		case "bottle":
			return `${time(entry.start)} bottle (${entry.amount ?? "?"} ${entry.units} ${entry.bottleType.toLowerCase()})`;
		case "sleep":
			return `${time(entry.start)}–${time(entry.end)} nap`;
	}
}

export function summarize(result: SyncResult, timeZone: string): { subject: string; text: string } {
	if (!result.reportFound) {
		return { subject: `Daycare sync ${result.date}: no Tadpoles report`, text: `No Tadpoles daily report was found for ${result.date}.` };
	}
	const counts = (kind: PlannedEntry["kind"]) => result.created.filter((e) => e.kind === kind).length;
	const subject = `Daycare sync ${result.date}: ${counts("diaper")} diapers, ${counts("bottle")} bottles, ${counts("sleep")} naps`;

	const section = (title: string, lines: string[]) => (lines.length ? [`${title}:`, ...lines.map((l) => `  • ${l}`), ""] : []);
	const unsupported = result.skipped.filter((s) => s.reason === "unsupported");
	const text = [
		...(result.dryRun ? ["DRY RUN — nothing was written to Huckleberry.", ""] : []),
		...(result.published ? [] : ["Note: the daycare hasn't published this report yet, so it may be incomplete.", ""]),
		...section("Added to Huckleberry", result.created.map((e) => describeEntry(e, timeZone))),
		...section("Already logged by hand (skipped)", result.alreadyLoggedManually.map((e) => describeEntry(e, timeZone))),
		...section("Not synced: unsupported in Tadpoles data", unsupported.map((s) => `${s.type}: ${s.detail}`)),
		`${result.alreadySynced.length} entries were already synced earlier.`,
	].join("\n");
	return { subject, text };
}

/** Push notification via ntfy (JSON publish, so non-ASCII titles/messages are safe). */
export async function notify(env: Env, title: string, message: string, failure = false): Promise<void> {
	const server = new URL(env.NTFY_SERVER);
	if (server.protocol !== "https:" || server.username || server.password) {
		throw new Error("NTFY_SERVER must be an HTTPS URL without embedded credentials");
	}
	const headers = new Headers({ "Content-Type": "application/json", "Cache": "no" });
	if (env.NTFY_TOKEN) headers.set("Authorization", `Bearer ${env.NTFY_TOKEN}`);
	const res = await fetch(env.NTFY_SERVER, {
		method: "POST",
		redirect: "error",
		headers,
		body: JSON.stringify({
			topic: env.NTFY_TOPIC,
			title,
			message: message.length > 3500 ? `${message.slice(0, 3500)}\n…(truncated)` : message,
			priority: failure ? 5 : 3,
			tags: [failure ? "warning" : "baby_bottle"],
		}),
	});
	if (!res.ok) throw new Error(`ntfy publish failed: ${res.status}`);
}
