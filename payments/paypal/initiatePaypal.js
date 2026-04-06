/**
 * Initiate PayPal Payment
 * Creates a PENDING subscription + invoice, then creates a PayPal order/subscription
 * and returns the approval URL for redirect.
 */

const { prisma } = require("../../prisma");
const { createPayPalOrder, createPayPalSubscription } = require("./paypalClient");

// PayPal Subscription Plan IDs (created via API with 12-month commitment)
const PAYPAL_SUBSCRIPTION_PLANS = {
	// Job Seeker annual plans (12 monthly installments, 90-day min commitment)
	"Silver 1-Year": "P-7V715744K3872590CNHJXR5Y",
	"Gold 1-Year": "P-2EU77528C2246415VNHJXR5Y",
	"Platinum 1-Year": "P-0AL26955WW1049333NHJXR5Y",
	// Recruiter plans
	"Silver": "P-1VN84546642017043NHJXR6A",       // Monthly $99
	"Gold": "P-7C3692160Y7422901NHJXR6A",          // Monthly $240
	"Platinum": "P-2GF592191K636170SNHJXR6I",      // Monthly $350
	"Diamond": "P-9LW15430FE951712WNHJXR6I",       // Annual $825/mo x 12
};

// Plans with 90-day minimum commitment (yearly plans)
const COMMITMENT_PLANS = {
	"Silver 1-Year": { minDays: 90 },
	"Gold 1-Year": { minDays: 90 },
	"Platinum 1-Year": { minDays: 90 },
	"Diamond": { minDays: 90 },
};

// Grace period: 1 day (24 hours) after failed payment before features lock
const GRACE_PERIOD_HOURS = 24;

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

		const { planId, paymentType } = req.body; // paymentType: "INSTALLMENT" (default) or "ONE_TIME"
		if (!planId) return res.status(400).json({ error: true, message: "planId is required" });
		const isOneTime = paymentType === "ONE_TIME";

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
		const reference = `${userId}_${Date.now()}`;
		const recurringPlanId = PAYPAL_SUBSCRIPTION_PLANS[plan.name];
		const isInstallment = !!recurringPlanId && !isOneTime; // Recurring unless user chose one-time

		// For installments: first period is 1 month, not full year
		// For one-time: period matches the plan interval (full year)
		const periodEnd = isInstallment
			? addInterval(now, "MONTH") // First month only
			: addInterval(now, plan.interval);

		// Monthly installment amount (e.g. $9.95 for Silver yearly)
		const monthlyAmount = isInstallment ? Math.round(plan.amount / 12) : null;
		const firstPaymentAmount = isInstallment ? monthlyAmount : plan.amount;
		const amountMajor = toMajorUnits(plan.amount);

		// Installment metadata
		const installmentMeta = isInstallment ? {
			type: "INSTALLMENT",
			totalInstallments: 12,
			paidInstallments: 0, // Will be 1 after first payment
			monthlyAmount,
			yearlyTotal: plan.amount,
			paypalSubscriptionId: null, // Set after PayPal creation
		} : { type: "ONE_TIME" };

		// Create PENDING subscription + invoice + payment in transaction
		const created = await prisma.$transaction(async (tx) => {
			const subscription = await tx.userSubscription.create({
				data: { userId, planId: plan.id, status: "PENDING", reference, installmentMeta },
			});

			const invoice = await tx.invoice.create({
				data: {
					userId,
					currency: plan.currency || "USD",
					periodStart,
					periodEnd,
					status: "OPEN",
					subtotal: firstPaymentAmount,
					tax: 0,
					total: firstPaymentAmount,
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
					amount: firstPaymentAmount,
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

		// Store PayPal order/subscription ID in payment logs + installment meta
		const paypalId = paypalResult.orderId || paypalResult.subscriptionId;
		await prisma.subscriptionPayment.update({
			where: { id: created.payment.id },
			data: {
				gatewayRef: paypalId,
				gatewayLogs: {
					push: {
						at: new Date().toISOString(),
						type: "PAYPAL_CREATED",
						paypalId,
						approveUrl: paypalResult.approveUrl,
						isRecurring: isInstallment,
					},
				},
			},
		});

		// Update installment meta with PayPal subscription ID
		if (isInstallment && paypalResult.subscriptionId) {
			await prisma.userSubscription.update({
				where: { id: created.subscription.id },
				data: {
					installmentMeta: { ...installmentMeta, paypalSubscriptionId: paypalResult.subscriptionId },
				},
			});
		}

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

/**
 * Cancel an active subscription (with 90-day commitment check for yearly plans).
 * Calls PayPal to cancel the recurring subscription.
 */
const cancelSubscription = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) return res.status(401).json({ error: true, message: "Unauthorized" });

		const { subscriptionId, reason } = req.body;
		if (!subscriptionId) return res.status(400).json({ error: true, message: "subscriptionId required" });

		// Find the subscription
		const sub = await prisma.userSubscription.findFirst({
			where: { id: subscriptionId, userId, status: "ACTIVE" },
			select: {
				id: true, startedAt: true, installmentMeta: true,
				plan: { select: { name: true } },
			},
		});

		if (!sub) {
			return res.status(404).json({ error: true, message: "Active subscription not found" });
		}

		// Check 90-day commitment for yearly plans
		const commitment = COMMITMENT_PLANS[sub.plan?.name];
		if (commitment && sub.startedAt) {
			const daysSinceStart = Math.floor((Date.now() - new Date(sub.startedAt).getTime()) / (1000 * 60 * 60 * 24));
			if (daysSinceStart < commitment.minDays) {
				const eligibleDate = new Date(sub.startedAt);
				eligibleDate.setDate(eligibleDate.getDate() + commitment.minDays);
				return res.status(403).json({
					error: true,
					message: `Your plan has a ${commitment.minDays}-day minimum commitment. You can cancel after ${eligibleDate.toLocaleDateString()}.`,
					result: {
						minDays: commitment.minDays,
						daysSoFar: daysSinceStart,
						eligibleDate: eligibleDate.toISOString(),
					},
				});
			}
		}

		// Cancel on PayPal if it's a recurring subscription
		const meta = sub.installmentMeta || {};
		if (meta.paypalSubscriptionId) {
			try {
				const { getAccessToken } = require("./paypalClient");
				const token = await getAccessToken();
				const ppRes = await fetch(`https://api-m.paypal.com/v1/billing/subscriptions/${meta.paypalSubscriptionId}/cancel`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ reason: reason || "User requested cancellation" }),
				});
				if (!ppRes.ok) {
					console.error("[PayPal Cancel] API error:", await ppRes.text());
				} else {
					console.log(`[PayPal Cancel] Subscription ${meta.paypalSubscriptionId} cancelled`);
				}
			} catch (err) {
				console.error("[PayPal Cancel] Error:", err.message);
			}
		}

		// Update our subscription - don't expire immediately, let current period run out
		await prisma.userSubscription.update({
			where: { id: sub.id },
			data: {
				canceledAt: new Date(),
				installmentMeta: {
					...meta,
					cancelledAt: new Date().toISOString(),
					cancelReason: reason || "User requested cancellation",
					willExpireAt: sub.installmentMeta?.expiresAt || null,
				},
			},
		});

		console.log(`[Cancel] Subscription ${sub.id} cancelled by user ${userId}. Will expire at current period end.`);

		return res.status(200).json({
			error: false,
			message: "Subscription cancelled. Access continues until end of current billing period.",
			result: { cancelledAt: new Date().toISOString() },
		});
	} catch (error) {
		console.error("[Cancel] Error:", error.message);
		return res.status(500).json({ error: true, message: error.message });
	}
};

/**
 * Get cancellation eligibility info for a subscription.
 */
const getCancellationInfo = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) return res.status(401).json({ error: true, message: "Unauthorized" });

		const sub = await prisma.userSubscription.findFirst({
			where: { userId, status: "ACTIVE" },
			orderBy: { createdAt: "desc" },
			select: {
				id: true, startedAt: true, expiresAt: true, canceledAt: true, installmentMeta: true,
				plan: { select: { name: true, interval: true } },
			},
		});

		if (!sub) {
			return res.status(404).json({ error: true, message: "No active subscription" });
		}

		const commitment = COMMITMENT_PLANS[sub.plan?.name];
		const meta = sub.installmentMeta || {};
		let canCancel = true;
		let eligibleDate = null;
		let daysRemaining = 0;

		if (commitment && sub.startedAt) {
			const daysSinceStart = Math.floor((Date.now() - new Date(sub.startedAt).getTime()) / (1000 * 60 * 60 * 24));
			canCancel = daysSinceStart >= commitment.minDays;
			eligibleDate = new Date(sub.startedAt);
			eligibleDate.setDate(eligibleDate.getDate() + commitment.minDays);
			daysRemaining = Math.max(0, commitment.minDays - daysSinceStart);
		}

		return res.status(200).json({
			error: false,
			result: {
				subscriptionId: sub.id,
				planName: sub.plan?.name,
				startedAt: sub.startedAt,
				expiresAt: sub.expiresAt,
				isCancelled: !!sub.canceledAt,
				canCancel,
				commitmentDays: commitment?.minDays || 0,
				eligibleDate: eligibleDate?.toISOString() || null,
				daysUntilCancellable: daysRemaining,
				installments: meta.type === "INSTALLMENT" ? {
					paid: meta.paidInstallments || 0,
					total: meta.totalInstallments || 12,
				} : null,
			},
		});
	} catch (error) {
		return res.status(500).json({ error: true, message: error.message });
	}
};

module.exports = {
	initiatePaypalPayment,
	cancelPaypalPayment,
	cancelSubscription,
	getCancellationInfo,
	PAYPAL_SUBSCRIPTION_PLANS,
	COMMITMENT_PLANS,
	GRACE_PERIOD_HOURS,
};
