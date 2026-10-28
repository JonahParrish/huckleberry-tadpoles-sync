import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFields, encodeFields, type FirestoreValue } from "../src/firestore";
import { syncDate } from "../src/sync";
import fixture from "./fixtures/daily-report.json";

const env = {
	TIMEZONE: "America/New_York",
	TADPOLES_EMAIL: "t@example.com",
	TADPOLES_PASSWORD: "pw",
	HUCKLEBERRY_EMAIL: "h@example.com",
	HUCKLEBERRY_PASSWORD: "pw",
} as Env;

const DOCS = "/v1/projects/simpleintervals/databases/(default)/documents/";

/** In-memory stand-in for both services. Firestore docs keyed by path, e.g. "feed/c1/intervals/abc". */
class FakeServices {
	docs = new Map<string, Record<string, FirestoreValue>>();
	writes = 0;

	constructor() {
		this.docs.set("users/u1", encodeFields({ childList: [{ cid: "c1" }] }));
	}

	data(path: string) {
		return decodeFields(this.docs.get(path)!);
	}

	intervals(collection: string) {
		return [...this.docs.keys()].filter((k) => k.startsWith(`${collection}/c1/intervals/`));
	}

	fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input);
		const method = init.method ?? "GET";
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;

		if (url.host === "www.tadpoles.com") {
			if (url.pathname === "/remote/v2/activities/daily_report/parent/query") {
				const headers = new Headers(init.headers);
				if (method !== "POST" || headers.get("Content-Type") !== "application/json" || !headers.get("Cookie")?.includes("session=abc")) {
					return new Response("bad request", { status: 400 });
				}
				expect(body).toEqual({ date: "2026-06-12", client: "dashboard" });
				return Response.json(fixture);
			}
			return new Response("ok", { headers: { "Set-Cookie": "session=abc; Path=/" } });
		}
		if (url.host === "identitytoolkit.googleapis.com") return Response.json({ idToken: "tok", localId: "u1" });

		const path = decodeURIComponent(url.pathname).replace(DOCS, "");
		if (path.endsWith(":runQuery")) {
			const parent = path.replace(":runQuery", "");
			const where = body.structuredQuery.where;
			const rows = [...this.docs]
				.filter(([k]) => k.startsWith(`${parent}/intervals/`))
				.filter(([, fields]) => {
					const d = decodeFields(fields);
					if (where.fieldFilter) return d.multi === true;
					const [lo, hi] = where.compositeFilter.filters.map((f: any) => Number(f.fieldFilter.value.integerValue));
					return Number(d.start) >= lo && Number(d.start) < hi;
				})
				.map(([name, fields]) => ({ document: { name, fields } }));
			return Response.json(rows.length ? rows : [{ readTime: "x" }]);
		}
		if (method === "POST") {
			const docPath = `${path}/${url.searchParams.get("documentId")}`;
			if (this.docs.has(docPath)) return new Response("exists", { status: 409 });
			this.docs.set(docPath, body.fields);
			this.writes++;
			return Response.json({});
		}
		if (method === "PATCH") {
			const existing = this.docs.has(path) ? decodeFields(this.docs.get(path)!) : {};
			const prefs = { ...(existing.prefs as object), ...(decodeFields(body.fields).prefs as object) };
			this.docs.set(path, encodeFields({ ...existing, prefs }));
			this.writes++;
			return Response.json({});
		}
		if (!this.docs.has(path)) return new Response("missing", { status: 404 });
		return Response.json({ name: path, fields: this.docs.get(path) });
	};
}

describe("syncDate", () => {
	let services: FakeServices;
	beforeEach(() => {
		services = new FakeServices();
		vi.stubGlobal("fetch", vi.fn(services.fetch));
	});
	afterEach(() => vi.unstubAllGlobals());

	it("dry run writes nothing", async () => {
		const result = await syncDate(env, "2026-06-12", true);
		expect(result.created).toHaveLength(13);
		expect(services.writes).toBe(0);
	});

	it("writes daycare entries in Huckleberry's document shapes", async () => {
		const result = await syncDate(env, "2026-06-12", false);
		expect(result.created).toHaveLength(13);
		expect(services.intervals("diaper")).toHaveLength(6);
		expect(services.intervals("feed")).toHaveLength(4);
		expect(services.intervals("sleep")).toHaveLength(3);

		const [bottleKey] = services.intervals("feed");
		expect(bottleKey).toMatch(/^feed\/c1\/intervals\/\d{13}-[0-9a-f]{20}$/);
		expect(services.docs.get(bottleKey)).toMatchObject({
			mode: { stringValue: "bottle" },
			start: { doubleValue: 1781263200 },
			amount: { doubleValue: 5 },
			units: { stringValue: "oz" },
			bottleType: { stringValue: "Breast Milk" },
			offset: { doubleValue: 240 },
		});

		const sleep = services.data(services.intervals("sleep")[0]);
		expect(sleep).toMatchObject({ offset: 240, end_offset: 240 });
		expect(services.docs.get(services.intervals("sleep")[0])!.duration).toHaveProperty("integerValue");

		// "Last diaper" on the home screen points at the latest daycare diaper.
		expect(services.data("diaper/c1").prefs).toMatchObject({ lastDiaper: { start: 1781292720, mode: "both" } });
		expect(services.data("feed/c1").prefs).toMatchObject({ lastBottle: { start: 1781291580, bottleAmount: 5 } });
	});

	it("stays well under the free plan's 50-subrequest limit", async () => {
		await syncDate(env, "2026-06-12", false);
		// 3 Tadpoles + 2 auth/user + 6 interval queries + 13 entries + 3 × (read + patch) of "last" prefs
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(30);
	});

	it("is idempotent across reruns", async () => {
		await syncDate(env, "2026-06-12", false);
		const writes = services.writes;
		const rerun = await syncDate(env, "2026-06-12", false);
		expect(rerun.created).toHaveLength(0);
		expect(rerun.alreadySynced).toHaveLength(13);
		expect(services.writes).toBe(writes);
	});

	it("skips events a parent already logged by hand", async () => {
		services.docs.set("diaper/c1/intervals/manual1", encodeFields({ start: 1781262180 + 300, mode: "pee", offset: 240 }));
		services.docs.set("sleep/c1/intervals/manual2", encodeFields({ start: 1781265780, duration: 3600, offset: 240 }));
		const result = await syncDate(env, "2026-06-12", false);
		expect(result.alreadyLoggedManually.map((e) => [e.kind, e.start])).toEqual([
			["diaper", 1781262180],
			["sleep", 1781266260],
		]);
		expect(result.created).toHaveLength(11);
	});

	it("does not update 'last' prefs with older events", async () => {
		services.docs.set("feed/c1", encodeFields({ prefs: { lastBottle: { start: 1781300780, mode: "bottle" } } }));
		await syncDate(env, "2026-06-12", false);
		expect(services.data("feed/c1").prefs).toMatchObject({ lastBottle: { start: 1781300780 } });
	});
});
