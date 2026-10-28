import { SyncFailure, UpstreamHttpError } from "./errors";
// Unofficial Huckleberry client: Firebase Auth + Firestore REST. Document shapes mirror
// Woyken/py-huckleberry-api, which matches what the Huckleberry apps write.
import { decodeFields, double, encodeFields, type FirestoreValue } from "./firestore";

// Public Firebase web config from the Huckleberry app (not a secret).
const FIREBASE_API_KEY = "AIzaSyApGVHktXeekGyAt-G6dIeWHUkq2oXqcjg";
const DOCUMENTS = "projects/simpleintervals/databases/(default)/documents";
const FIRESTORE = `https://firestore.googleapis.com/v1/${DOCUMENTS}`;

export type TrackerCollection = "diaper" | "feed" | "sleep";

export interface Interval {
	id: string;
	data: Record<string, unknown>;
}

interface FirestoreDocument {
	name: string;
	fields?: Record<string, FirestoreValue>;
}

export class HuckleberryClient {
	private idToken = "";
	private uid = "";

	constructor(
		private email: string,
		private password: string,
	) {}

	async login(): Promise<void> {
		const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
			method: "POST",
			// Workers supports manual/follow only; reject returned redirects via the status check.
			redirect: "manual",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: this.email, password: this.password, returnSecureToken: true }),
		});
		if (!res.ok) throw new UpstreamHttpError(res.status);
		const data = (await res.json()) as { idToken: string; localId: string };
		this.idToken = data.idToken;
		if (typeof data.localId !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.localId)) throw new SyncFailure("huckleberry-login", "invalid-account-id");
		this.uid = data.localId;
	}

	async getChildId(): Promise<string> {
		const user = await this.getDocument(`users/${this.uid}`);
		const children = (user?.childList ?? []) as { cid: string }[];
		if (children.length !== 1) {
			throw new SyncFailure("huckleberry-child", "child-selection");
		}
		if (typeof children[0]?.cid !== "string" || !/^[A-Za-z0-9_-]+$/.test(children[0].cid)) throw new SyncFailure("huckleberry-child", "invalid-account-id");
		return children[0].cid;
	}

	/** Intervals whose start falls in [startSec, endSec), including entries packed into "multi" docs. */
	async listIntervals(collection: TrackerCollection, childId: string, startSec: number, endSec: number): Promise<Interval[]> {
		const parent = `${DOCUMENTS}/${collection}/${childId}`;
		const ranged = await this.runQuery(parent, {
			compositeFilter: {
				op: "AND",
				filters: [
					{ fieldFilter: { field: { fieldPath: "start" }, op: "GREATER_THAN_OR_EQUAL", value: { integerValue: String(startSec) } } },
					{ fieldFilter: { field: { fieldPath: "start" }, op: "LESS_THAN", value: { integerValue: String(endSec) } } },
				],
			},
		});
		const multi = await this.runQuery(parent, {
			fieldFilter: { field: { fieldPath: "multi" }, op: "EQUAL", value: { booleanValue: true } },
		});

		const intervals: Interval[] = ranged.filter((i) => !i.data.multi);
		for (const container of multi) {
			for (const [id, data] of Object.entries((container.data.data ?? {}) as Record<string, Record<string, unknown>>)) {
				const start = Number(data.start);
				if (start >= startSec && start < endSec) intervals.push({ id, data });
			}
		}
		return intervals;
	}

	/** Creates an interval doc with a fixed id. Returns false if it already exists (already synced). */
	async createInterval(collection: TrackerCollection, childId: string, id: string, data: Record<string, unknown>): Promise<boolean> {
		const url = `${FIRESTORE}/${collection}/${childId}/intervals?documentId=${encodeURIComponent(id)}`;
		const res = await this.firestore(url, { method: "POST", body: JSON.stringify({ fields: encodeFields(data) }) }, [409]);
		return res.status !== 409;
	}

	/**
	 * Updates the "last X" summary the app shows on its home screen, but only if this event is
	 * at least as recent as the current one (same rule as the app).
	 */
	async updateLastPrefs(
		collection: TrackerCollection,
		childId: string,
		prefField: string,
		last: Record<string, unknown> & { start: unknown },
		extraPrefs: Record<string, unknown> = {},
		startSec: number,
	): Promise<boolean> {
		const doc = await this.getDocument(`${collection}/${childId}`);
		const existing = (doc?.prefs as Record<string, { start?: number }> | undefined)?.[prefField];
		if (existing?.start != null && Number(existing.start) > startSec) return false;

		const now = Date.now() / 1000;
		const prefs = { [prefField]: last, ...extraPrefs, timestamp: { seconds: double(now) }, local_timestamp: double(now) };
		const mask = Object.keys(prefs).map((k) => `updateMask.fieldPaths=${encodeURIComponent(`prefs.${k}`)}`).join("&");
		await this.firestore(`${FIRESTORE}/${collection}/${childId}?${mask}`, {
			method: "PATCH",
			body: JSON.stringify({ fields: encodeFields({ prefs }) }),
		});
		return true;
	}

	private async getDocument(path: string): Promise<Record<string, unknown> | null> {
		const res = await this.firestore(`${FIRESTORE}/${path}`, { method: "GET" }, [404]);
		if (res.status === 404) return null;
		const doc = (await res.json()) as FirestoreDocument;
		return decodeFields(doc.fields ?? {});
	}

	private async runQuery(parent: string, where: unknown): Promise<Interval[]> {
		const res = await this.firestore(`https://firestore.googleapis.com/v1/${parent}:runQuery`, {
			method: "POST",
			body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "intervals" }], where } }),
		});
		const rows = (await res.json()) as { document?: FirestoreDocument }[];
		return rows
			.filter((r) => r.document)
			.map((r) => ({ id: r.document!.name.split("/").pop()!, data: decodeFields(r.document!.fields ?? {}) }));
	}

	private async firestore(url: string, init: RequestInit, allowStatuses: number[] = []): Promise<Response> {
		if (!this.idToken) throw new Error("HuckleberryClient.login() must be called first");
		const res = await fetch(url, {
			...init,
			// Workers supports manual/follow only; reject returned redirects via the status check.
			redirect: "manual",
			headers: { Authorization: `Bearer ${this.idToken}`, "Content-Type": "application/json" },
		});
		if (!res.ok && !allowStatuses.includes(res.status)) {
			throw new UpstreamHttpError(res.status);
		}
		return res;
	}
}
