// Minimal Firestore REST value encoding. The Huckleberry apps write some numbers as doubles
// (timestamps from Python/Kotlin floats) and some as integers, so callers mark doubles explicitly.

export class Double {
	constructor(readonly value: number) {}
}
export const double = (value: number) => new Double(value);

export type FirestoreValue =
	| { nullValue: null }
	| { booleanValue: boolean }
	| { integerValue: string }
	| { doubleValue: number }
	| { stringValue: string }
	| { arrayValue: { values?: FirestoreValue[] } }
	| { mapValue: { fields?: Record<string, FirestoreValue> } };

export function encodeValue(value: unknown): FirestoreValue {
	if (value === null) return { nullValue: null };
	if (value instanceof Double) return { doubleValue: value.value };
	if (typeof value === "boolean") return { booleanValue: value };
	if (typeof value === "number") {
		return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
	}
	if (typeof value === "string") return { stringValue: value };
	if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
	if (typeof value === "object") return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } };
	throw new TypeError(`Cannot encode ${typeof value} for Firestore`);
}

export function encodeFields(obj: Record<string, unknown>): Record<string, FirestoreValue> {
	const fields: Record<string, FirestoreValue> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) fields[key] = encodeValue(value);
	}
	return fields;
}

export function decodeValue(value: FirestoreValue): unknown {
	if ("nullValue" in value) return null;
	if ("booleanValue" in value) return value.booleanValue;
	if ("integerValue" in value) return Number(value.integerValue);
	if ("doubleValue" in value) return value.doubleValue;
	if ("stringValue" in value) return value.stringValue;
	if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decodeValue);
	if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {});
	return undefined; // timestamps, references, etc. aren't needed here
}

export function decodeFields(fields: Record<string, FirestoreValue>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]));
}
