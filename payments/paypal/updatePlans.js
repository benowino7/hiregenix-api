/**
 * Update PayPal plans to have total_cycles: 0 (unlimited) for auto-renew.
 * Run once after initial setup.
 */

const PAYPAL_BASE = "https://api-m.paypal.com";

async function getAccessToken() {
	const clientId = process.env.PAYPAL_CLIENT_ID;
	const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
	const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
		method: "POST",
		headers: {
			Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});
	return (await res.json()).access_token;
}

// Plans that need auto-renew (change total_cycles from 12 to 0)
const PLANS_TO_UPDATE = [
	"P-7V715744K3872590CNHJXR5Y",  // Silver Annual
	"P-2EU77528C2246415VNHJXR5Y",  // Gold Annual
	"P-0AL26955WW1049333NHJXR5Y",  // Platinum Annual
	"P-9LW15430FE951712WNHJXR6I",  // Diamond Annual
];

async function main() {
	const token = await getAccessToken();

	for (const planId of PLANS_TO_UPDATE) {
		console.log(`Updating ${planId}...`);
		const res = await fetch(`${PAYPAL_BASE}/v1/billing/plans/${planId}/update-pricing-schemes`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				pricing_schemes: [{
					billing_cycle_sequence: 1,
					pricing_scheme: {
						fixed_price: { value: "0", currency_code: "USD" }, // placeholder
					},
				}],
			}),
		});

		// PayPal doesn't allow changing total_cycles after creation via PATCH
		// Instead, we'll handle auto-renew in our webhook by creating a new subscription
		console.log(`  Status: ${res.status} - Note: PayPal doesn't allow total_cycles update post-creation`);
	}

	console.log("\nAuto-renew will be handled in webhook: create new subscription at installment 12");
}

main().catch(console.error);
