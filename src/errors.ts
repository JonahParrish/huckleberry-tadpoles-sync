/** Only fixed diagnostic labels and numeric HTTP statuses may cross the error boundary. */
export type SyncStage = "configuration" | "tadpoles-login" | "tadpoles-report" | "mapping" | "huckleberry-login" | "huckleberry-child" | "huckleberry-read" | "huckleberry-write" | "huckleberry-summary" | "ntfy-publish";
export type FailureReason = "unexpected" | "missing-credentials" | "child-selection" | "invalid-account-id" | "invalid-response" | "request-failed" | "request-type-error" | "response-read-failed" | "invalid-json" | "missing-token" | "invalid-notification-config";

export class UpstreamHttpError extends Error {
	constructor(readonly status: number) {
		super(`Upstream HTTP ${status}`);
	}
}

export class SyncFailure extends Error {
	constructor(readonly stage: SyncStage, readonly reason: FailureReason = "unexpected", readonly status?: number) {
		super("Sync failed");
	}
}

const stages: readonly string[] = ["configuration", "tadpoles-login", "tadpoles-report", "mapping", "huckleberry-login", "huckleberry-child", "huckleberry-read", "huckleberry-write", "huckleberry-summary", "ntfy-publish"];
const reasons: Record<FailureReason, string> = {
	unexpected: "unexpected error; possible network failure or unsupported API response",
	"missing-credentials": "required account credentials are missing or blank",
	"child-selection": "expected exactly one child/report",
	"invalid-account-id": "unsupported account identifier format",
	"invalid-response": "unexpected API response",
	"request-failed": "request failed before an HTTP response was received",
	"request-type-error": "request failed with TypeError before an HTTP response was received",
	"response-read-failed": "HTTP response body could not be read",
	"invalid-json": "HTTP response body was not valid JSON",
	"missing-token": "login response did not contain a valid authentication token",
	"invalid-notification-config": "notification server or topic configuration is invalid",
};

export function safeDiagnostic(error: unknown): string {
	if (!(error instanceof SyncFailure) || !stages.includes(error.stage)) return "Sync failed: unexpected error";
	const status = error.status;
	if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
		return `Sync failed: ${error.stage} (upstream HTTP ${status})`;
	}
	const reason = Object.hasOwn(reasons, error.reason) ? reasons[error.reason] : reasons.unexpected;
	return `Sync failed: ${error.stage} (${reason})`;
}
