// services/initiateCardPayment.service.js
const { getFreshToken } = require("./getAuthToken");
const ok = (message, result = {}, meta = {}) => ({
	error: false,
	message,
	result,
	meta,
});

const fail = (message, result = {}, meta = {}) => ({
	error: true,
	message,
	result,
	meta,
});

const readBody = async (res) => {
	const contentType = res.headers.get("content-type") || "";
	if (contentType.includes("application/json")) return res.json();

	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Initiate Card Payment with fresh token + retry logic
 * - Always fetches a fresh token on each payment initiation
 * - Retries up to 3 times with 7 second delays on token/auth failures
 */
const initiateCardPayment = async (data) => {
	try {
		let { amount, paymentMethod, currency, externalId } = data;

		/* ---------------- DEFAULTS ---------------- */
		paymentMethod = paymentMethod || "CARD"; // CARD | GPAY_APAY

		/* ---------------- VALIDATION ---------------- */
		if (!amount || Number(amount) <= 0) return fail("Valid amount is required");

		if (!["GPAY_APAY", "CARD"].includes(paymentMethod)) return fail("paymentMethod must be either 'GPAY_APAY' or 'CARD'");

		/* ---------------- PAYLOAD ---------------- */
		let payload = {
			merchantId: process.env.EXT_API_USERNAME,
			externalId,
			callbackUrl: process.env.GATEWAY_CALLBACK_URL,
			redirectUrl: process.env.GATEWAY_REDIRECT_URL || "https://candidate.hiregenix.ai/payment-confirmation",
			currency,
			amount: String(amount),
		};

		if (paymentMethod == "GPAY_APAY") {
			const { verticle, description, first_name, last_name, email, phone, address1, administrative_area, country, locality, postal_code } = data;
			payload = {
				...payload,
				verticle,
				description,

				// Customer details
				first_name,
				last_name,
				email,
				phone,

				// Billing address
				address1,
				administrative_area,
				country,
				locality,
				postal_code,
			};
		}

		/* ---------------- ROUTING ---------------- */
		const endpoint = paymentMethod === "GPAY_APAY" ? "/card/gpay-apay/" : "/coop/initiate/";
		const url = `${process.env.EXT_API_BASE_URL}${endpoint}`;

		/* ---------------- INTERNAL REQUEST ---------------- */
		const doRequest = async (token) => {
			const encodedToken = Buffer.from(token).toString("base64");

			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${encodedToken}`,
				},
				body: JSON.stringify(payload),
			});

			const body = await readBody(res);
			return { res, body };
		};

		/* ---------------- RETRY LOGIC ---------------- */
		// Always get a fresh token for each payment initiation
		// Retry up to 3 times with 7 second delays on auth/token failures
		const MAX_RETRIES = 3;
		const RETRY_DELAY_MS = 7000;

		let lastError = null;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				console.log(`[PAYMENT] Attempt ${attempt}/${MAX_RETRIES} — fetching fresh token...`);
				const token = await getFreshToken();

				console.log(`[PAYMENT] Attempt ${attempt}/${MAX_RETRIES} — initiating payment...`);
				const { res, body } = await doRequest(token);

				// Check for token/auth-related failures (401, 403)
				if (res.status === 401 || res.status === 403) {
					const errMsg = body?.message || `Auth rejected (HTTP ${res.status})`;
					console.warn(`[PAYMENT] Attempt ${attempt}/${MAX_RETRIES} — token rejected: ${errMsg}`);
					lastError = errMsg;

					if (attempt < MAX_RETRIES) {
						console.log(`[PAYMENT] Waiting ${RETRY_DELAY_MS / 1000}s before retry...`);
						await sleep(RETRY_DELAY_MS);
						continue;
					}
					return fail(`Payment authentication failed after ${MAX_RETRIES} attempts: ${errMsg}`, body, {
						status: res.status,
						endpoint,
						attempts: attempt,
					});
				}

				// Other HTTP failures (not auth-related) — don't retry
				if (!res.ok) {
					return fail(body?.message || `Card deposit failed (${res.status})`, body, {
						status: res.status,
						endpoint,
						attempts: attempt,
					});
				}

				// Handle APIs that return { error: true } even on 200
				if (body?.error) {
					// Check if the error message indicates a token issue
					const msg = (body?.message || "").toLowerCase();
					if (msg.includes("token") || msg.includes("auth") || msg.includes("unauthorized") || msg.includes("invalid")) {
						console.warn(`[PAYMENT] Attempt ${attempt}/${MAX_RETRIES} — token error in body: ${body.message}`);
						lastError = body.message;

						if (attempt < MAX_RETRIES) {
							console.log(`[PAYMENT] Waiting ${RETRY_DELAY_MS / 1000}s before retry...`);
							await sleep(RETRY_DELAY_MS);
							continue;
						}
					}
					return fail(body?.message || "Card deposit failed", body, {
						status: res.status,
						endpoint,
						attempts: attempt,
					});
				}

				// Success
				console.log(`[PAYMENT] Success on attempt ${attempt}/${MAX_RETRIES}`);
				return ok(paymentMethod === "GPAY_APAY" ? "Google Pay / Apple Pay deposit initiated" : "Card deposit initiated", body, {
					status: res.status,
					endpoint,
					attempts: attempt,
				});
			} catch (attemptError) {
				console.error(`[PAYMENT] Attempt ${attempt}/${MAX_RETRIES} error:`, attemptError.message);
				lastError = attemptError.message;

				if (attempt < MAX_RETRIES) {
					console.log(`[PAYMENT] Waiting ${RETRY_DELAY_MS / 1000}s before retry...`);
					await sleep(RETRY_DELAY_MS);
					continue;
				}
			}
		}

		return fail(`Card deposit failed after ${MAX_RETRIES} attempts: ${lastError || "Unknown error"}`);
	} catch (error) {
		return fail(error?.message || "Card deposit failed");
	}
};

module.exports = { initiateCardPayment };
