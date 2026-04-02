const { prisma } = require("../../prisma");
const { initiateCardPayment } = require("../../payments/card/initiatePayment");
const { toMajorUnits, addInterval } = require("../subscriptions/jobSeekerSubscriptions");

// External apply fee by subscription plan (in cents)
const EXTERNAL_APPLY_FEE_BY_PLAN = {
	"Silver": 9900,         // $99
	"Gold": 5000,           // $50
	"Platinum": 2000,       // $20
	"Diamond": 1000,        // $10
	"Diamond Compact": 1000,
	"Diamond Compact Plus": 1000,
	"Diamond Unlimited": 1000,
};
const DEFAULT_EXTERNAL_APPLY_FEE_CENTS = 9900; // $99 fallback

/**
 * Initiate external apply payment — fee varies by subscription plan.
 * Silver: $99, Gold: $50, Platinum: $20, Diamond*: $10
 *
 * POST /job-seeker/jobs/:jobId/external-apply
 * Body: { paymentMethod: "CARD" | "GPAY_APAY", currency: "USD" | "AED", customer?, billingAddress? }
 */
const initiateExternalApply = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { jobId } = req.params;
		const { paymentMethod = "CARD", currency = "USD", customer = {}, billingAddress = {} } = req.body;

		if (!jobId) {
			return res.status(400).json({ error: true, message: "jobId is required", result: {} });
		}

		if (!["USD", "AED"].includes(currency)) {
			return res.status(400).json({ error: true, message: "Currency is not supported", result: {} });
		}

		// Verify job exists and has applicationUrl
		const job = await prisma.job.findUnique({
			where: { id: jobId },
			select: { id: true, title: true, applicationUrl: true },
		});

		if (!job) {
			return res.status(404).json({ error: true, message: "Job not found", result: {} });
		}

		if (!job.applicationUrl) {
			return res.status(400).json({ error: true, message: "This job does not support external applications", result: {} });
		}

		// Check if user already paid for this job
		const existingPayment = await prisma.invoice.findFirst({
			where: {
				userId,
				reference: { startsWith: `extapply_${jobId}_${userId}` },
				status: "PAID",
			},
		});

		if (existingPayment) {
			// Already paid — just return the URL
			return res.status(200).json({
				error: false,
				message: "Already paid for this external application",
				result: { applicationUrl: job.applicationUrl, alreadyPaid: true },
			});
		}

		// Get user's active subscription (required for payment record FK + plan-based pricing)
		const now = new Date();
		const activeSub = await prisma.userSubscription.findFirst({
			where: {
				userId,
				status: "ACTIVE",
				canceledAt: null,
				startedAt: { not: null },
				OR: [{ expiresAt: { gt: now } }, { expiresAt: null }],
			},
			select: { id: true, plan: { select: { name: true } } },
		});

		if (!activeSub || activeSub.plan?.name === "Free Trial") {
			return res.status(400).json({ error: true, message: "You need an active paid subscription to apply externally", result: {} });
		}

		const planName = activeSub.plan?.name || "";
		const amountMinor = EXTERNAL_APPLY_FEE_BY_PLAN[planName] || DEFAULT_EXTERNAL_APPLY_FEE_CENTS;
		const amountMajor = toMajorUnits(amountMinor, "USD");

		const timestamp = Date.now();
		const reference = `extapply_${jobId}_${userId}_${timestamp}`;

		// Create Invoice + Payment in a transaction
		const created = await prisma.$transaction(async (tx) => {
			// Use timestamp-offset periodEnd to avoid unique constraint on (userId, periodStart, periodEnd)
			const periodEnd = new Date(now.getTime() + timestamp % 1000000);
			const invoice = await tx.invoice.create({
				data: {
					userId,
					currency: "USD",
					periodStart: now,
					periodEnd,
					status: "OPEN",
					subtotal: amountMinor,
					tax: 0,
					total: amountMinor,
					reference,
				},
			});

			const payment = await tx.subscriptionPayment.create({
				data: {
					subscriptionId: activeSub.id,
					invoiceId: invoice.id,
					amount: amountMinor,
					currency: "USD",
					status: "PENDING",
					gateway: paymentMethod || "CARD",
					gatewayRef: reference,
				},
			});

			return { invoice, payment };
		});

		// Gateway payload
		let gatewayPayload = {
			amount: amountMajor,
			paymentMethod,
			currency,
			externalId: reference,
		};

		if (paymentMethod === "GPAY_APAY") {
			const { firstName, lastName, email, phone } = customer;
			const { address1, administrativeArea, country, locality, postalCode } = billingAddress;
			gatewayPayload = {
				...gatewayPayload,
				verticle: "gaming",
				description: "External Job Application Fee",
				first_name: firstName,
				last_name: lastName,
				email,
				phone,
				address1,
				administrative_area: administrativeArea,
				country,
				locality,
				postal_code: postalCode,
			};
		}

		if (!process.env.EXT_API_BASE_URL || !process.env.EXT_API_USERNAME || !process.env.EXT_API_PASSWORD) {
			return res.status(503).json({ error: true, message: "Payment gateway is not configured", result: {} });
		}

		const payResp = await initiateCardPayment(gatewayPayload);

		const logEntry = {
			at: new Date().toISOString(),
			type: "INITIATE",
			status: payResp?.meta?.status,
			error: payResp?.error === true,
			message: payResp?.message,
			data: payResp?.result?.data,
		};

		const gatewayRef =
			payResp?.result?.data?.transaction_id ||
			payResp?.result?.data?.payment_id ||
			payResp?.result?.data?.external_id ||
			created.payment.gatewayRef;

		if (payResp?.error) {
			await prisma.subscriptionPayment.update({
				where: { id: created.payment.id },
				data: { status: "FAILED", gatewayRef, gatewayLogs: { push: logEntry } },
			});
			await prisma.invoice.update({
				where: { id: created.invoice.id },
				data: { status: "VOID" },
			});

			return res.status(400).json({
				error: true,
				message: payResp.message || "Payment initiation failed",
				result: {},
			});
		}

		await prisma.subscriptionPayment.update({
			where: { id: created.payment.id },
			data: { status: "PENDING", gatewayRef, gatewayLogs: { push: logEntry } },
		});

		return res.status(200).json({
			error: false,
			message: "External apply payment initiated. Complete payment to get the application link.",
			result: {
				invoiceId: created.invoice.id,
				jobId: job.id,
				jobTitle: job.title,
				amount: amountMajor,
				currency: "USD",
				gateway: {
					payment_link: payResp?.result?.data?.payment_link,
					payment_id: payResp?.result?.data?.payment_id,
					transaction_id: payResp?.result?.data?.transaction_id,
					external_id: payResp?.result?.data?.external_id,
				},
			},
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({
			error: true,
			message: error.message || "Failed to initiate external apply payment",
			result: {},
		});
	}
};

/**
 * Check if user has paid for external apply on a specific job.
 * GET /job-seeker/jobs/:jobId/external-apply/status
 */
const checkExternalApplyStatus = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { jobId } = req.params;

		const job = await prisma.job.findUnique({
			where: { id: jobId },
			select: { id: true, applicationUrl: true },
		});

		if (!job) {
			return res.status(404).json({ error: true, message: "Job not found", result: {} });
		}

		// Check for paid invoice with this reference pattern
		const paidInvoice = await prisma.invoice.findFirst({
			where: {
				userId,
				reference: { startsWith: `extapply_${jobId}_${userId}` },
				status: "PAID",
			},
		});

		if (paidInvoice) {
			return res.status(200).json({
				error: false,
				message: "Payment confirmed",
				result: { paid: true, applicationUrl: job.applicationUrl },
			});
		}

		return res.status(200).json({
			error: false,
			message: "Not yet paid",
			result: { paid: false, applicationUrl: null },
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({
			error: true,
			message: error.message || "Failed to check external apply status",
			result: {},
		});
	}
};

module.exports = { initiateExternalApply, checkExternalApplyStatus };
