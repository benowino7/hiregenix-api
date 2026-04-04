/**
 * Initiate PayPal Payment
 * Creates a PENDING subscription + invoice, then creates a PayPal order/subscription
 * and returns the approval URL for redirect.
 */

const { prisma } = require("../../prisma");
const { createPayPalOrder, createPayPalSubscription } = require("./paypalClient");

// PayPal Subscription Plan IDs (annual/recurring plans from PayPal dashboard)
const PAYPAL_SUBSCRIPTION_PLANS = {
	// Job Seeker annual plans
	"Silver 1-Year": "P-4XN99525DA2986302NHIUNWY",
	"Gold 1-Year": "P-2NX45334AJ855243SNHIUL7A",
	"Platinum 1-Year": "P-1YN71190UY690163RNHIUIVY",
};

const addInterval = (startDate, interval) => {
	const d = new Date(startDate);
	switch (interval) {
		case "QUARTER": d.setMonth(d.getMonth() + 3); break;
		case "HALF_YEAR": d.setMonth(d.getMonth() + 6); break;
		case "YEAR": d.setFullYear(d.getFullYear() + 1); break;
		default: d.setMonth(d.getMonth() + 1); break;
	}
	return d;
};

const toMajorUnits = (minor) => minor / 100;

const initiatePaypalPayment = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) return res.status(401).json({ error: true, message: "Unauthorized" });

		const { planId } = req.body;
		if (!planId) return res.status(400).json({ error: true, message: "planId is required" });

		// Fetch plan
		const plan = await prisma.subscriptionPlan.findUnique({
			where: { id: planId },
			select: { id: true, name: true, amount: true, currency: true, interval: true, isActive: true, userType: true },
		});

		if (!plan || !plan.isActive) {
			return res.status(404).json({ error: true, message: "Plan not found or inactive" });
		}

		// Fetch user email for PayPal subscriber info
		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { email: true },
		});

		const now = new Date();
		const periodStart = now;
		const periodEnd = addInterval(now, plan.interval);
		const reference = `${userId}_${Date.now()}`;
		const amountMajor = toMajorUnits(plan.amount);

		// Create PENDING subscription + invoice + payment in transaction
		const created = await prisma.$transaction(async (tx) => {
			const subscription = await tx.userSubscription.create({
				data: { userId, planId: plan.id, status: "PENDING", reference },
			});

			const invoice = await tx.invoice.create({
				data: {
					userId,
					currency: plan.currency || "USD",
					periodStart,
					periodEnd,
					status: "OPEN",
					subtotal: plan.amount,
					tax: 0,
					total: plan.amount,
					reference,
				},
			});

			await tx.invoiceItem.create({
				data: {
					invoiceId: invoice.id,
					subscriptionId: subscription.id,
					planName: plan.name,
					interval: plan.interval,
					hours: 0,
					unitRate: null,
					amount: plan.amount,
					currency: plan.currency || "USD",
				},
			});

			const payment = await tx.subscriptionPayment.create({
				data: {
					subscriptionId: subscription.id,
					invoiceId: invoice.id,
					amount: plan.amount,
					currency: plan.currency || "USD",
					status: "PENDING",
					gateway: "PAYPAL",
					gatewayLogs: [{
						at: now.toISOString(),
						type: "INITIATION",
						planName: plan.name,
						reference,
					}],
				},
			});

			return { subscription, invoice, payment };
		});

		// Determine PayPal payment type
		const baseUrl = process.env.PAYPAL_RETURN_URL || "https://candidate.hiregenix.ai";
		const returnUrl = `${baseUrl}/dashboard/subscriptions?paypal=success&ref=${reference}`;
		const cancelUrl = `${baseUrl}/dashboard/subscriptions?paypal=cancelled&ref=${reference}`;

		let paypalResult;
		const recurringPlanId = PAYPAL_SUBSCRIPTION_PLANS[plan.name];

		if (recurringPlanId) {
			// Annual plans use PayPal Subscriptions API (recurring)
			paypalResult = await createPayPalSubscription({
				planId: recurringPlanId,
				customId: reference,
				returnUrl,
				cancelUrl,
				subscriberEmail: user?.email,
			});
		} else {
			// 3-month and 6-month plans use PayPal Orders API (one-time)
			paypalResult = await createPayPalOrder({
				amount: amountMajor,
				currency: plan.currency || "USD",
				description: `HireGeniX ${plan.name} Subscription`,
				customId: reference,
				returnUrl,
				cancelUrl,
			});
		}

		// Store PayPal order/subscription ID in payment logs
		await prisma.subscriptionPayment.update({
			where: { id: created.payment.id },
			data: {
				gatewayRef: paypalResult.orderId || paypalResult.subscriptionId,
				gatewayLogs: {
					push: {
						at: new Date().toISOString(),
						type: "PAYPAL_CREATED",
						paypalId: paypalResult.orderId || paypalResult.subscriptionId,
						approveUrl: paypalResult.approveUrl,
						isRecurring: !!recurringPlanId,
					},
				},
			},
		});

		return res.status(200).json({
			error: false,
			message: "PayPal payment initiated",
			result: {
				approveUrl: paypalResult.approveUrl,
				reference,
				paypalId: paypalResult.orderId || paypalResult.subscriptionId,
			},
		});

	} catch (error) {
		console.error("[PayPal Initiate] Error:", error.message);
		return res.status(500).json({
			error: true,
			message: error.message || "Failed to initiate PayPal payment",
		});
	}
};

/**
 * Cancel/Fail a PayPal payment when user cancels on PayPal's page.
 * Called by frontend when user returns with ?paypal=cancelled&ref=xxx
 */
const cancelPaypalPayment = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) return res.status(401).json({ error: true, message: "Unauthorized" });

		const { reference, reason } = req.body;
		if (!reference) return res.status(400).json({ error: true, message: "reference is required" });

		// Find the invoice by reference, verify it belongs to this user
		const invoice = await prisma.invoice.findFirst({
			where: { reference, userId, status: "OPEN" },
			select: { id: true, items: { select: { subscriptionId: true }, take: 1 } },
		});

		if (!invoice) {
			return res.status(404).json({ error: true, message: "No pending payment found for this reference" });
		}

		const subscriptionId = invoice.items?.[0]?.subscriptionId;

		const cancelLog = {
			at: new Date().toISOString(),
			type: "PAYPAL_CANCELLED",
			reason: reason || "User cancelled on PayPal checkout page",
			reference,
		};

		await prisma.$transaction(async (tx) => {
			// Update payment record
			const payment = await tx.subscriptionPayment.findFirst({
				where: { invoiceId: invoice.id },
				orderBy: { createdAt: "desc" },
				select: { id: true },
			});

			if (payment) {
				await tx.subscriptionPayment.update({
					where: { id: payment.id },
					data: { status: "FAILED", gatewayLogs: { push: cancelLog } },
				});
			}

			// Void invoice
			await tx.invoice.update({
				where: { id: invoice.id },
				data: { status: "VOID" },
			});

			// Fail subscription
			if (subscriptionId) {
				await tx.userSubscription.update({
					where: { id: subscriptionId },
					data: { status: "FAILED", canceledAt: new Date() },
				});
			}
		});

		console.log(`[PayPal] Cancelled: ref=${reference}, user=${userId}`);

		return res.status(200).json({
			error: false,
			message: "Payment cancelled and recorded",
		});
	} catch (error) {
		console.error("[PayPal Cancel] Error:", error.message);
		return res.status(500).json({ error: true, message: error.message });
	}
};

module.exports = { initiatePaypalPayment, cancelPaypalPayment, PAYPAL_SUBSCRIPTION_PLANS };
