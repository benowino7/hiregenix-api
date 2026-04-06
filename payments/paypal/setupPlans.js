/**
 * PayPal Plan Setup Script
 * Creates products and subscription plans via PayPal REST API.
 * Run once to set up plans, then store the plan IDs.
 *
 * Usage: PAYPAL_CLIENT_ID=xxx PAYPAL_CLIENT_SECRET=xxx node payments/paypal/setupPlans.js
 */

const PAYPAL_BASE = "https://api-m.paypal.com";

async function getAccessToken() {
	const clientId = process.env.PAYPAL_CLIENT_ID;
	const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
	if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET required");

	const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
		method: "POST",
		headers: {
			Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});
	if (!res.ok) throw new Error(`Auth failed: ${await res.text()}`);
	return (await res.json()).access_token;
}

async function createProduct(token, { name, description, type = "SERVICE", category = "SOFTWARE" }) {
	const res = await fetch(`${PAYPAL_BASE}/v1/catalogs/products`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ name, description, type, category }),
	});
	if (!res.ok) throw new Error(`Create product failed: ${await res.text()}`);
	const data = await res.json();
	console.log(`  Product created: ${data.id} (${name})`);
	return data;
}

async function createPlan(token, { productId, name, description, billingCycles, paymentPreferences }) {
	const res = await fetch(`${PAYPAL_BASE}/v1/billing/plans`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			product_id: productId,
			name,
			description,
			billing_cycles: billingCycles,
			payment_preferences: paymentPreferences,
		}),
	});
	if (!res.ok) throw new Error(`Create plan failed: ${await res.text()}`);
	const data = await res.json();
	console.log(`  Plan created: ${data.id} (${name}) - ${data.status}`);
	return data;
}

// ─── Payment preferences (shared) ─────────────────────────────────────────
const PAYMENT_PREFS = {
	auto_bill_outstanding: true,
	setup_fee: { value: "0", currency_code: "USD" },
	setup_fee_failure_action: "CONTINUE",
	payment_failure_threshold: 3, // Suspend after 3 consecutive failures
};

// ─── Job Seeker Plans ──────────────────────────────────────────────────────
const JOB_SEEKER_PLANS = [
	{
		name: "HireGeniX Silver - Annual",
		description: "Silver plan: $9.95/month for 12 months ($119.40/year). 90-day minimum commitment.",
		billingCycles: [
			{
				frequency: { interval_unit: "MONTH", interval_count: 1 },
				tenure_type: "REGULAR",
				sequence: 1,
				total_cycles: 12, // 12-month commitment
				pricing_scheme: { fixed_price: { value: "9.95", currency_code: "USD" } },
			},
		],
	},
	{
		name: "HireGeniX Gold - Annual",
		description: "Gold plan: $19.95/month for 12 months ($239.40/year). 90-day minimum commitment.",
		billingCycles: [
			{
				frequency: { interval_unit: "MONTH", interval_count: 1 },
				tenure_type: "REGULAR",
				sequence: 1,
				total_cycles: 12,
				pricing_scheme: { fixed_price: { value: "19.95", currency_code: "USD" } },
			},
		],
	},
	{
		name: "HireGeniX Platinum - Annual",
		description: "Platinum plan: $29.95/month for 12 months ($359.40/year). 90-day minimum commitment.",
		billingCycles: [
			{
				frequency: { interval_unit: "MONTH", interval_count: 1 },
				tenure_type: "REGULAR",
				sequence: 1,
				total_cycles: 12,
				pricing_scheme: { fixed_price: { value: "29.95", currency_code: "USD" } },
			},
		],
	},
];

// ─── Recruiter Plans ───────────────────────────────────────────────────────
// Silver/Gold/Platinum are monthly (no commitment)
// Diamond is yearly (12 months auto-renew)
const RECRUITER_PLANS = [
	{
		name: "HireGeniX Recruiter Silver - Monthly",
		description: "Recruiter Silver: $99/month. 1 active job posting.",
		billingCycles: [
			{
				frequency: { interval_unit: "MONTH", interval_count: 1 },
				tenure_type: "REGULAR",
				sequence: 1,
				total_cycles: 0, // 0 = unlimited (auto-renew monthly)
				pricing_scheme: { fixed_price: { value: "99.00", currency_code: "USD" } },
			},
		],
	},
	{
		name: "HireGeniX Recruiter Gold - Monthly",
		description: "Recruiter Gold: $240/month. 3 active job postings.",
		billingCycles: [
			{
				frequency: { interval_unit: "MONTH", interval_count: 1 },
				tenure_type: "REGULAR",
				sequence: 1,
				total_cycles: 0,
				pricing_scheme: { fixed_price: { value: "240.00", currency_code: "USD" } },
			},
		],
	},
	{
		name: "HireGeniX Recruiter Platinum - Monthly",
		description: "Recruiter Platinum: $350/month. 5 active job postings.",
		billingCycles: [
			{
				frequency: { interval_unit: "MONTH", interval_count: 1 },
				tenure_type: "REGULAR",
				sequence: 1,
				total_cycles: 0,
				pricing_scheme: { fixed_price: { value: "350.00", currency_code: "USD" } },
			},
		],
	},
	{
		name: "HireGeniX Recruiter Diamond - Annual",
		description: "Recruiter Diamond: $825/month for 12 months ($9,900/year). Unlimited job postings. 90-day minimum.",
		billingCycles: [
			{
				frequency: { interval_unit: "MONTH", interval_count: 1 },
				tenure_type: "REGULAR",
				sequence: 1,
				total_cycles: 12,
				pricing_scheme: { fixed_price: { value: "825.00", currency_code: "USD" } },
			},
		],
	},
];

async function main() {
	console.log("=== PayPal Plan Setup ===\n");

	const token = await getAccessToken();
	console.log("Authenticated with PayPal\n");

	// Create products
	console.log("Creating products...");
	const jsProduct = await createProduct(token, {
		name: "HireGeniX Job Seeker Subscription",
		description: "AI-powered job matching, CV builder, and career tools for job seekers in the UAE.",
	});

	const recProduct = await createProduct(token, {
		name: "HireGeniX Recruiter Subscription",
		description: "AI-powered recruitment tools, job posting, and candidate matching for employers.",
	});

	// Create job seeker plans
	console.log("\nCreating Job Seeker plans...");
	const jsPlanIds = {};
	for (const plan of JOB_SEEKER_PLANS) {
		const result = await createPlan(token, {
			productId: jsProduct.id,
			name: plan.name,
			description: plan.description,
			billingCycles: plan.billingCycles,
			paymentPreferences: PAYMENT_PREFS,
		});
		jsPlanIds[plan.name] = result.id;
	}

	// Create recruiter plans
	console.log("\nCreating Recruiter plans...");
	const recPlanIds = {};
	for (const plan of RECRUITER_PLANS) {
		const result = await createPlan(token, {
			productId: recProduct.id,
			name: plan.name,
			description: plan.description,
			billingCycles: plan.billingCycles,
			paymentPreferences: PAYMENT_PREFS,
		});
		recPlanIds[plan.name] = result.id;
	}

	// Output results
	console.log("\n=== PLAN IDS (save these) ===\n");
	console.log("Job Seeker Plans:");
	for (const [name, id] of Object.entries(jsPlanIds)) {
		console.log(`  "${name}": "${id}"`);
	}
	console.log("\nRecruiter Plans:");
	for (const [name, id] of Object.entries(recPlanIds)) {
		console.log(`  "${name}": "${id}"`);
	}

	console.log("\n=== Copy these into initiatePaypal.js PAYPAL_SUBSCRIPTION_PLANS ===");
}

main().catch((err) => {
	console.error("ERROR:", err.message);
	process.exit(1);
});
