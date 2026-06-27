// src/notify/resend.ts
//
// Best-effort Resend escalation client.
//
// Design invariant: sendEscalation NEVER throws or crashes the pipeline.
// A Resend failure (network error OR a non-null error in the result) is
// swallowed, logged to stderr, and returned as { sent: false, error: ... }.
//
// Injectable sendFn dep lets tests mock without a real network hit
// (no requires:operator). Production path uses the real Resend SDK.
//
// US-007 (CAM-109).

import { Resend } from 'resend';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mirrors the subset of the Resend SDK emails.send() signature used here.
 * Injectable for testing: pass a fake that returns { data, error } without
 * touching the network.
 */
export type ResendSendFn = (params: {
	from: string;
	to: string;
	subject: string;
	html: string;
}) => Promise<{ data: unknown; error: unknown }>;

export interface EscalationOptions {
	/** Resend API key. */
	apiKey: string;
	/** Recipient email address. */
	recipient: string;
	/** Email subject line. */
	subject: string;
	/** Email body (HTML). */
	html: string;
	/**
	 * Sender address. Defaults to the Resend onboarding sender which works
	 * without a verified domain (good for first-run escalations).
	 */
	from?: string;
	/**
	 * Injectable send function. When absent the real Resend SDK is used.
	 * Inject a fake in unit tests to avoid a real network hit.
	 */
	sendFn?: ResendSendFn;
}

export interface EscalationResult {
	sent: boolean;
	/** Non-null when sent is false. */
	error?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a best-effort escalation email via Resend.
 *
 * NEVER throws. A network error or a non-null `error` in the SDK response is
 * swallowed, logged to stderr, and returned as { sent: false, error: ... }.
 * The caller does not need a try-catch.
 */
export async function sendEscalation(opts: EscalationOptions): Promise<EscalationResult> {
	try {
		const fn: ResendSendFn = opts.sendFn ?? makeProdSendFn(opts.apiKey);
		const result = await fn({
			from: opts.from ?? 'cam <onboarding@resend.dev>',
			to: opts.recipient,
			subject: opts.subject,
			html: opts.html,
		});
		const error = (result as { data: unknown; error: unknown }).error;
		if (error !== null && error !== undefined) {
			const msg = typeof error === 'object' ? JSON.stringify(error) : String(error);
			process.stderr.write(`[cam] Resend escalation error: ${msg}\n`);
			return { sent: false, error: msg };
		}
		return { sent: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[cam] Resend escalation network error: ${msg}\n`);
		return { sent: false, error: msg };
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeProdSendFn(apiKey: string): ResendSendFn {
	const client = new Resend(apiKey);
	return (params) =>
		client.emails.send(params) as Promise<{ data: unknown; error: unknown }>;
}
