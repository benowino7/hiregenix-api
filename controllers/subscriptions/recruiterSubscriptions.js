const { prisma } = require("../../prisma");
const { initiateCardPayment } = require("../../payments/card/initiatePayment");
const {
	addInterval,
	toMajorUnits,
	markSubscriptionAsFailed,
} = require("./jobSeekerSubscriptions");
const WiseFx = require("./wiseFx");

// ── helpers (reused from job seeker, scoped to RECRUITER) ──

function planMonthlyValueMinor(plan) {
	switch (plan.interval) {
		case 'MONTH': return plan.amount;
		case 'QUARTER': return plan.amount / 3;
		case 'HALF_YEAR': return plan.amount / 6;
		case 'YEAR': return plan.amount / 12;
		default: return plan.amount;
	}
}

function isDowngradePlan(newPlan, currentPlan) {
	return planMonthlyValueMinor(newPlan) < planMonthlyValueMinor(currentPlan);
}

async function assertNoDowngradeBeforeExpiry({ prisma, userId, newPlan, usedCurrency }) {
	const now = new Date();
	const current = await prisma.userSubscription.findFirst({
		where: {
			userId,
			status: "ACTIVE",
			canceledAt: null,
			expiresAt: { gt: now },
		},
		select: {
			id: true, startedAt: true, expiresAt: true, planId: true,
			plan: { select: { id: true, name: true, amount: true, currency: true, interval: true } },
		},
	});

	if (!current) return { current: null, block: false };

	const curCurrency = current.plan.currency || usedCurrency;
	if (curCurrency !== usedCurrency) {
		return { current, block: true, reason: "Currency mismatch between current subscription and requested currency" };
	}

	if (current.planId === newPlan.id) {
		return { current, block: true, reason: `You already have the ${current.plan.name} plan active until ${current.expiresAt.toISOString()}. You can renew after it expires.` };
	}

	if (isDowngradePlan(newPlan, current.plan)) {
		return { current, block: true, reason: `Downgrade not allowed until current subscription ends on ${current.expiresAt.toISOString()}` };
	}

	return { current, block: false };
}

async function calculateUpgradeAmountDue({ prisma, userId, newPlan }) {
	const now = new Date();
	const current = await prisma.userSubscription.findFirst({
		where: { userId, status: "ACTIVE", canceledAt: null, expiresAt: { gt: now }, startedAt: { not: null } },
		select: {
			id: true, planId: true, startedAt: true, expiresAt: true,
			plan: { select: { id: true, name: true, amount: true, currency: true, interval: true } },
		},
	});

	if (!current || !current.startedAt || !current.expiresAt) {
		return { currentSubscription: current, creditMinor: 0, amountDueMinor: newPlan.amount, prorationRatio: 0 };
	}

	if (current.plan.currency && newPlan.currency && current.plan.currency !== newPlan.currency) {
		return { currentSubscription: current, blocked: true, reason: `Currency mismatch: current=${current.plan.currency}, new=${newPlan.currency}`, creditMinor: 0, amountDueMinor: newPlan.amount, prorationRatio: 0 };
	}

	if (current.planId === newPlan.id) {
		return { currentSubscription: current, blocked: true, reason: `You already have ${current.plan.name} active until ${current.expiresAt.toISOString()}.`, creditMinor: 0, amountDueMinor: 0, prorationRatio: 0 };
	}

	const startMs = new Date(current.startedAt).getTime();
	const endMs = new Date(current.expiresAt).getTime();
	const nowMs = now.getTime();
	const totalMs = Math.max(endMs - startMs, 0);
	const remainingMs = Math.max(endMs - nowMs, 0);
	let ratio = totalMs === 0 ? 0 : remainingMs / totalMs;
	ratio = Math.max(0, Math.min(1, ratio));

	const creditMinor = Math.floor(current.plan.amount * ratio);
	const amountDueMinor = Math.max(newPlan.amount - creditMinor, 0);

	return { currentSubscription: current, creditMinor, amountDueMinor, prorationRatio: ratio };
}

// ── CHOOSE SUBSCRIPTION ──

const chooseRecruiterSubscription = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { planId, paymentMethod = "CARD", currency = "USD", customer = {}, billingAddress = {} } = req.body;

		if (!planId) {
			return res.status(400).json({ error: true, message: "planId is required", result: {} });
		}

		if (!["USD", "AED"].includes(currency)) {
			return res.status(400).json({ error: true, message: "Currency is not supported", result: {} });
		}

		const plan = await prisma.subscriptionPlan.findFirst({
			where: { id: planId, userType: "RECRUITER", isActive: true },
			select: { id: true, name: true, amount: true, currency: true, interval: true },
		});

		if (!plan) {
			return res.status(404).json({ error: true, message: "Subscription plan not found (or not available for recruiters)", result: {} });
		}

		const downgradeCheck = await assertNoDowngradeBeforeExpiry({ prisma, userId, newPlan: plan, usedCurrency: "USD" });
		if (downgradeCheck?.block) {
			return res.status(400).json({ error: true, message: downgradeCheck.reason, result: { currentSubscription: downgradeCheck.current } });
		}

		const { currentSubscription, creditMinor, amountDueMinor, prorationRatio } = await calculateUpgradeAmountDue({ prisma, userId, newPlan: plan });

		const usedCurrency = plan.currency || "USD";
		const amountMinor = plan.amount;
		const amountToPay = toMajorUnits(amountDueMinor, usedCurrency);

		const now = new Date();
		const periodStart = now;
		const periodEnd = addInterval(now, plan.interval);
		const timestamp = Date.now();
		const reference = `${userId}_${timestamp}`;

		const created = await prisma.$transaction(async (tx) => {
			const subscription = await tx.userSubscription.create({
				data: { userId, planId: plan.id, status: "PENDING", reference },
			});

			const invoice = await tx.invoice.create({
				data: {
					userId, currency: usedCurrency, periodStart, periodEnd, status: "OPEN",
					subtotal: amountDueMinor, tax: 0, total: amountDueMinor, reference,
					creditFromSubscriptionId: currentSubscription?.id || null,
					creditAmount: creditMinor || 0,
					creditReason: creditMinor > 0 ? "PRORATION_UNUSED_TIME" : null,
					creditMeta: creditMinor > 0 ? {
						oldPlanId: currentSubscription?.plan?.id,
						oldPlanName: currentSubscription?.plan?.name,
						oldStartedAt: currentSubscription?.startedAt,
						oldExpiresAt: currentSubscription?.expiresAt,
						prorationRatio,
					} : null,
				},
			});

			await tx.invoiceItem.create({
				data: {
					invoiceId: invoice.id, subscriptionId: subscription.id,
					planName: plan.name, interval: plan.interval,
					hours: 0, unitRate: null, amount: plan.amount, currency: usedCurrency,
				},
			});

			if (creditMinor > 0) {
				await tx.invoiceItem.create({
					data: {
						invoiceId: invoice.id, subscriptionId: subscription.id,
						planName: "PRORATION_CREDIT", interval: plan.interval,
						hours: 0, unitRate: null, amount: -creditMinor, currency: usedCurrency,
					},
				});
			}

			const payment = await tx.subscriptionPayment.create({
				data: {
					subscriptionId: subscription.id, invoiceId: invoice.id,
					amount: amountDueMinor, currency: usedCurrency,
					status: "PENDING", gateway: paymentMethod || "CARD", gatewayRef: reference,
				},
			});

			return { subscription, invoice, payment };
		});

		let currencyAmount = amountToPay;
		if (currency !== "USD") {
			const wise = new WiseFx({ token: process.env.WISE_TOKEN });
			const result = await wise.convert({ amount: amountToPay, sourceCurrency: "USD", targetCurrency: currency });
			currencyAmount = result.convertedAmount;
		}

		let gatewayPayload = {
			amount: currencyAmount,
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
				description: "test descriptor",
				first_name: firstName, last_name: lastName, email, phone,
				address1, administrative_area: administrativeArea, country, locality, postal_code: postalCode,
			};
		}

		if (!process.env.EXT_API_BASE_URL || !process.env.EXT_API_USERNAME || !process.env.EXT_API_PASSWORD) {
			await markSubscriptionAsFailed({
				subscriptionId: created.subscription.id, invoiceId: created.invoice.id, paymentId: created.payment.id,
				gatewayLog: { at: new Date().toISOString(), type: "INITIATE", error: true, message: "Gateway not configured" },
				subscriptionFailStatus: "FAILED",
			});
			return res.status(503).json({ error: true, message: "Payment gateway is not configured. Please contact support.", result: {} });
		}

		const payResp = await initiateCardPayment(gatewayPayload);

		const logEntry = {
			at: new Date().toISOString(), type: "INITIATE",
			status: payResp?.meta?.status, endpoint: payResp?.meta?.endpoint,
			error: payResp?.error === true, message: payResp?.message,
			warning: payResp?.result?.warning, data: payResp?.result?.data || { checkoutUrl: payResp?.result?.checkoutUrl },
		};

		const gatewayRef =
			payResp?.result?.data?.transaction_id || payResp?.result?.data?.payment_id ||
			payResp?.result?.data?.external_id || payResp?.result?.transactionId ||
			reference || created.payment.gatewayRef;

		if (payResp?.error) {
			await prisma.subscriptionPayment.update({
				where: { id: created.payment.id },
				data: { status: "FAILED", gateway: paymentMethod || "CARD", gatewayRef, gatewayLogs: { push: logEntry } },
			});
			await markSubscriptionAsFailed({
				subscriptionId: created.subscription.id, invoiceId: created.invoice.id, paymentId: created.payment.id,
				gatewayLog: logEntry, subscriptionFailStatus: "FAILED",
			});
			return res.status(400).json({
				error: true, message: payResp.message || "Payment initiation failed",
				result: { subscriptionId: created.subscription.id, invoiceId: created.invoice.id, payment: payResp?.result || {} },
			});
		}

		await prisma.subscriptionPayment.update({
			where: { id: created.payment.id },
			data: { status: "PENDING", gateway: paymentMethod || "CARD", gatewayRef, gatewayLogs: { push: logEntry } },
		});

		return res.status(200).json({
			error: false,
			message: "Subscription selected. Complete payment to activate.",
			result: {
				subscriptionId: created.subscription.id,
				invoiceId: created.invoice.id,
				plan: { id: plan.id, name: plan.name, interval: plan.interval, currency: usedCurrency, amountMinor, amountToPay },
				gateway: {
					payment_link: payResp?.result?.checkoutUrl || payResp?.result?.data?.payment_link || payResp?.result?.data?.checkoutUrl,
					payment_id: payResp?.result?.data?.payment_id,
					transaction_id: payResp?.result?.data?.transaction_id,
					external_id: payResp?.result?.data?.external_id,
					externalId: reference,
					warning: payResp?.result?.warning,
				},
			},
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({ error: true, message: error.message || "Failed to choose subscription", result: {} });
	}
};

// ── GET LATEST SUBSCRIPTION ──

const getRecruiterLatestSubscription = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ error: true, message: "Unauthorized", result: {} });
		}

		const now = new Date();

		const subscription = await prisma.userSubscription.findFirst({
			where: {
				userId,
				status: { in: ["ACTIVE", "EXPIRED"] },
				plan: { userType: "RECRUITER" },
			},
			orderBy: { createdAt: "desc" },
			select: {
				id: true, status: true, startedAt: true, expiresAt: true, canceledAt: true,
				reference: true, createdAt: true, updatedAt: true,
				plan: {
					select: {
						id: true, name: true, userType: true, amount: true, currency: true, interval: true, isActive: true,
						feature: { select: { features: true } },
					},
				},
				payments: {
					orderBy: { createdAt: "desc" }, take: 1,
					select: {
						id: true, amount: true, currency: true, status: true, gateway: true, paidAt: true, createdAt: true,
						invoiceId: true,
						invoice: {
							select: {
								id: true, status: true, currency: true, periodStart: true, periodEnd: true,
								subtotal: true, tax: true, total: true, reference: true, paidAt: true, createdAt: true,
							},
						},
					},
				},
				invoiceItems: {
					orderBy: { createdAt: "desc" }, take: 10,
					select: {
						id: true, planName: true, interval: true, hours: true, unitRate: true, amount: true, currency: true, createdAt: true,
						invoice: {
							select: {
								id: true, status: true, currency: true, periodStart: true, periodEnd: true,
								total: true, paidAt: true, createdAt: true,
							},
						},
					},
				},
			},
		});

		if (!subscription) {
			return res.status(404).json({ error: true, message: "No subscription found", result: {} });
		}

		const isActiveNow =
			subscription.status === "ACTIVE" &&
			subscription.canceledAt == null &&
			subscription.startedAt != null &&
			subscription.startedAt <= now &&
			(subscription.expiresAt == null || subscription.expiresAt > now);

		const isTrial = subscription?.plan?.name === "Free Trial";
		const trialDaysLeft = isTrial && subscription.expiresAt
			? Math.max(0, Math.ceil((new Date(subscription.expiresAt) - now) / (1000 * 60 * 60 * 24)))
			: null;

		return res.status(200).json({
			error: false,
			message: "Latest subscription found",
			result: { subscription, isActiveNow, isTrial, trialDaysLeft },
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({ error: true, message: "Something went wrong", result: {} });
	}
};

// ── UPGRADE QUOTE ──

const getRecruiterUpgradeQuote = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { planId, currency = "USD" } = req.query;

		if (!planId) {
			return res.status(400).json({ error: true, message: "planId is required", result: {} });
		}

		const newPlan = await prisma.subscriptionPlan.findFirst({
			where: { id: String(planId), userType: "RECRUITER", isActive: true },
			select: { id: true, name: true, amount: true, currency: true, interval: true },
		});

		if (!newPlan) {
			return res.status(404).json({ error: true, message: "Plan not found or not available", result: {} });
		}

		const usedCurrency = String(currency || newPlan.currency || "USD");
		if (newPlan.currency !== usedCurrency) {
			return res.status(400).json({ error: true, message: "Currency mismatch for selected plan", result: { planCurrency: newPlan.currency, requestedCurrency: usedCurrency } });
		}

		const downgradeCheck = await assertNoDowngradeBeforeExpiry({ prisma, userId, newPlan, usedCurrency: "USD" });
		if (downgradeCheck?.block) {
			return res.status(400).json({ error: true, message: downgradeCheck.reason, result: { currentSubscription: downgradeCheck.current } });
		}

		const calc = await calculateUpgradeAmountDue({ prisma, userId, newPlan });
		if (calc.blocked) {
			return res.status(400).json({ error: true, message: calc.reason, result: { currentSubscription: calc.currentSubscription, newPlan } });
		}

		return res.status(200).json({
			error: false,
			message: "Upgrade top-up calculated",
			result: {
				newPlan,
				currentSubscription: calc.currentSubscription,
				creditMinor: calc.creditMinor,
				creditMajor: toMajorUnits(calc.creditMinor, usedCurrency),
				topUpMinor: calc.amountDueMinor,
				topUpMajor: toMajorUnits(calc.amountDueMinor, usedCurrency),
				prorationRatio: calc.prorationRatio,
			},
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({ error: true, message: error.message || "Something went wrong", result: {} });
	}
};

// ── INVOICES ──

const getRecruiterInvoices = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) return res.status(401).json({ error: true, message: "Unauthorized", result: [] });

		const { status, page = 1, limit = 20 } = req.query;
		const pageNum = Math.max(parseInt(page, 10) || 1, 1);
		const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
		const skip = (pageNum - 1) * limitNum;

		const where = { userId, ...(status && { status }) };
		const [total, invoices] = await Promise.all([
			prisma.invoice.count({ where }),
			prisma.invoice.findMany({
				where, orderBy: { createdAt: "desc" }, skip, take: limitNum,
				include: {
					items: { orderBy: { createdAt: "asc" }, select: { id: true, subscriptionId: true, planName: true, interval: true, hours: true, unitRate: true, amount: true, currency: true, createdAt: true } },
					payments: { orderBy: { createdAt: "desc" }, select: { id: true, amount: true, currency: true, status: true, gateway: true, paidAt: true, createdAt: true } },
				},
			}),
		]);

		return res.status(200).json({
			meta: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
			error: false, message: "Invoices fetched successfully", result: invoices,
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({ error: true, message: error.message || "Failed to fetch invoices", result: [] });
	}
};

const getRecruiterInvoiceById = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { invoiceId } = req.params;
		if (!userId) return res.status(401).json({ error: true, message: "Unauthorized", result: {} });

		const invoice = await prisma.invoice.findFirst({
			where: { id: invoiceId, userId },
			include: {
				items: { orderBy: { createdAt: "asc" }, select: { id: true, subscriptionId: true, planName: true, interval: true, hours: true, unitRate: true, amount: true, currency: true, createdAt: true } },
				payments: { orderBy: { createdAt: "desc" }, select: { id: true, amount: true, currency: true, status: true, gateway: true, paidAt: true, createdAt: true } },
				charges: false,
			},
		});

		if (!invoice) return res.status(404).json({ error: true, message: "Invoice not found", result: {} });

		return res.status(200).json({ error: false, message: "Invoice fetched successfully", result: invoice });
	} catch (error) {
		console.log(error);
		return res.status(500).json({ error: true, message: error.message || "Failed to fetch invoice", result: {} });
	}
};

module.exports = {
	chooseRecruiterSubscription,
	getRecruiterLatestSubscription,
	getRecruiterUpgradeQuote,
	getRecruiterInvoices,
	getRecruiterInvoiceById,
};
