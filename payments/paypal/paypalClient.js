/**
 * PayPal REST API Client
 * Uses live credentials to create subscriptions and verify payments.
 */

const PAYPAL_BASE = "https://api-m.paypal.com"; // Live

async function getAccessToken() {
	const clientId = process.env.PAYPAL_CLIENT_ID;
	const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

	if (!clientId || !clientSecret) {
		throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set");
	}

	const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

	const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
		method: "POST",
		headers: {
			Authorization: `Basic ${auth}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`PayPal auth failed: ${res.status} ${text}`);
	}

	const data = await res.json();
	return data.access_token;
}

/**
 * Create a PayPal order (one-time payment) with custom_id for tracking.
 * Used for 3-month and 6-month plans.
 */
async function createPayPalOrder({ amount, currency = "USD", description, customId, returnUrl, cancelUrl }) {
	const token = await getAccessToken();

	const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			intent: "CAPTURE",
			purchase_units: [{
				amount: {
					currency_code: currency,
					value: amount.toFixed(2),
				},
				description,
				custom_id: customId,
			}],
			application_context: {
				brand_name: "HireGeniX",
				return_url: returnUrl,
				cancel_url: cancelUrl,
				user_action: "PAY_NOW",
				shipping_preference: "NO_SHIPPING",
			},
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`PayPal create order failed: ${res.status} ${text}`);
	}

	const order = await res.json();
	const approveLink = order.links?.find(l => l.rel === "approve")?.href;

	return {
		orderId: order.id,
		approveUrl: approveLink,
		status: order.status,
	};
}

/**
 * Create a PayPal subscription (recurring) with custom_id for tracking.
 * Used for annual plans.
 */
async function createPayPalSubscription({ planId, customId, returnUrl, cancelUrl, subscriberEmail }) {
	const token = await getAccessToken();

	const body = {
		plan_id: planId,
		custom_id: customId,
		application_context: {
			brand_name: "HireGeniX",
			return_url: returnUrl,
			cancel_url: cancelUrl,
			user_action: "SUBSCRIBE_NOW",
			shipping_preference: "NO_SHIPPING",
		},
	};

	if (subscriberEmail) {
		body.subscriber = { email_address: subscriberEmail };
	}

	const res = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`PayPal create subscription failed: ${res.status} ${text}`);
	}

	const sub = await res.json();
	const approveLink = sub.links?.find(l => l.rel === "approve")?.href;

	return {
		subscriptionId: sub.id,
		approveUrl: approveLink,
		status: sub.status,
	};
}

/**
 * Capture a PayPal order after user approves.
 */
async function capturePayPalOrder(orderId) {
	const token = await getAccessToken();

	const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`PayPal capture failed: ${res.status} ${text}`);
	}

	return await res.json();
}

module.exports = {
	getAccessToken,
	createPayPalOrder,
	createPayPalSubscription,
	capturePayPalOrder,
	PAYPAL_BASE,
};
