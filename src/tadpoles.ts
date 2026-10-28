// Unofficial Tadpoles parent API. Login flow mirrors leocov-dev/tadpoles-backup:
// POST /auth/login (form) → POST /remote/v1/athome/admit → session cookies.

const ROOT = "https://www.tadpoles.com";

export interface TadpolesEntry {
	id: string;
	type_name: "bathroom" | "food" | "nap" | "activity" | string;
	deleted: boolean;
	/** True when a parent entered it (drop-off info about the night/morning at home). */
	parent: boolean;
	action_time: number | null;
	note: string | null;
	// bathroom
	bathroom_type?: string | null;
	event_ids?: string[] | null;
	// food
	meal_type?: string | null;
	amount?: number | null;
	numeric_amount?: number | null;
	contents_id?: string | null;
	foods?: unknown;
	// nap
	start_time?: number | null;
	end_time?: number | null;
}

export interface TadpolesDailyReport {
	date: string;
	published: boolean;
	entries: TadpolesEntry[];
}

export class TadpolesClient {
	private cookies = new Map<string, string>();

	constructor(
		private email: string,
		private password: string,
		private timeZone: string,
	) {}

	async login(): Promise<void> {
		await this.post("/auth/login", { email: this.email, password: this.password, service: "tadpoles" });
		await this.post("/remote/v1/athome/admit", { tz: this.timeZone });
	}

	async getDailyReports(date: string): Promise<TadpolesDailyReport[]> {
		const res = await this.request(new URL("/remote/v2/activities/daily_report/parent/query", ROOT), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ date, client: "dashboard" }),
		});
		const body = (await res.json()) as { status: string; payload?: { daily_reports?: TadpolesDailyReport[] } };
		if (body.status !== "ok" || !body.payload?.daily_reports) {
			throw new Error("Tadpoles daily report query returned an unexpected body");
		}
		const reports = body.payload.daily_reports.filter((r) => r.date === date);
		if (reports.length > 1) throw new Error("Multiple Tadpoles reports found; refusing to choose a child implicitly");
		return reports;
	}

	private post(path: string, form: Record<string, string>): Promise<Response> {
		return this.request(new URL(path, ROOT), { method: "POST", body: new URLSearchParams(form) });
	}

	private async request(url: URL, init: RequestInit): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.cookies.size) {
			headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
		}
		const res = await fetch(url, { ...init, headers, redirect: "manual" });
		for (const cookie of res.headers.getSetCookie()) {
			const [pair] = cookie.split(";");
			const eq = pair.indexOf("=");
			this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
		if (!res.ok) {
			throw new Error(`Tadpoles ${init.method} ${url.pathname} failed: ${res.status}`);
		}
		return res;
	}
}
