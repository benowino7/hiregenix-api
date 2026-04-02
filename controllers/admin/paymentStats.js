const { prisma } = require("../../prisma");

const ALLOWED_EMAIL = "admin@hiregenix.ai";

function assertAllowed(req) {
	const email = req.user?.user?.email || req.user?.email;
	if (email !== ALLOWED_EMAIL) {
		const err = new Error("Only the account manager can modify subscription plans");
		err.status = 403;
		throw err;
	}
}

/**
 * GET /api/admin/payment-stats?period=today|week|month|quarter|half|year|ytd
 * Returns successful payment totals for the given period.
 */
const getPaymentStats = async (req, res) => {
	try {
		const now = new Date();
		const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const startOfWeek = new Date(startOfDay);
		startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
		const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
		const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
		const startOfHalf = new Date(now.getFullYear(), now.getMonth() < 6 ? 0 : 6, 1);
		const startOfYear = new Date(now.getFullYear(), 0, 1);

		// Run all period counts in parallel
		const baseWhere = { status: "SUCCESS" };

		const [daily, weekly, monthly, quarterly, semiAnnual, annual, ytd, allTime] = await Promise.all([
			// Today
			prisma.subscriptionPayment.aggregate({
				where: { ...baseWhere, paidAt: { gte: startOfDay } },
				_sum: { amount: true },
				_count: true,
			}),
			// This week
			prisma.subscriptionPayment.aggregate({
				where: { ...baseWhere, paidAt: { gte: startOfWeek } },
				_sum: { amount: true },
				_count: true,
			}),
			// This month
			prisma.subscriptionPayment.aggregate({
				where: { ...baseWhere, paidAt: { gte: startOfMonth } },
				_sum: { amount: true },
				_count: true,
			}),
			// This quarter
			prisma.subscriptionPayment.aggregate({
				where: { ...baseWhere, paidAt: { gte: startOfQuarter } },
				_sum: { amount: true },
				_count: true,
			}),
			// This half year
			prisma.subscriptionPayment.aggregate({
				where: { ...baseWhere, paidAt: { gte: startOfHalf } },
				_sum: { amount: true },
				_count: true,
			}),
			// Last 12 months
			prisma.subscriptionPayment.aggregate({
				where: { ...baseWhere, paidAt: { gte: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000) } },
				_sum: { amount: true },
				_count: true,
			}),
			// Year to date
			prisma.subscriptionPayment.aggregate({
				where: { ...baseWhere, paidAt: { gte: startOfYear } },
				_sum: { amount: true },
				_count: true,
			}),
			// All time
			prisma.subscriptionPayment.aggregate({
				where: baseWhere,
				_sum: { amount: true },
				_count: true,
			}),
		]);

		const format = (agg) => ({
			amount: agg._sum.amount || 0,
			count: agg._count || 0,
		});

		return res.json({
			status: "SUCCESS",
			data: {
				daily: format(daily),
				weekly: format(weekly),
				monthly: format(monthly),
				quarterly: format(quarterly),
				semiAnnual: format(semiAnnual),
				annual: format(annual),
				ytd: format(ytd),
				allTime: format(allTime),
			},
		});
	} catch (error) {
		console.error("Payment stats error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * GET /api/admin/subscription-plans
 * List all subscription plans (grouped by user type).
 */
const getSubscriptionPlans = async (req, res) => {
	try {
		const plans = await prisma.subscriptionPlan.findMany({
			where: { isActive: true },
			include: {
				_count: { select: { subscriptions: true } },
			},
			orderBy: [{ userType: "asc" }, { amount: "asc" }],
		});

		return res.json({
			status: "SUCCESS",
			data: plans.map((p) => ({
				id: p.id,
				name: p.name,
				userType: p.userType,
				amount: p.amount,
				currency: p.currency,
				interval: p.interval,
				isActive: p.isActive,
				activeSubscriptions: p._count.subscriptions,
				createdAt: p.createdAt,
			})),
		});
	} catch (error) {
		console.error("Get subscription plans error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * PATCH /api/admin/subscription-plans/:id
 * Update a subscription plan's name, amount, and/or interval.
 * Body: { name?, amount?, interval? }
 * amount is in cents (e.g., 1000 = $10.00)
 * interval is "MONTH" or "YEAR"
 */
const updateSubscriptionPlan = async (req, res) => {
	try {
		assertAllowed(req);
		const { id } = req.params;
		const { name, amount, interval } = req.body;

		const existing = await prisma.subscriptionPlan.findUnique({ where: { id } });
		if (!existing) {
			return res.status(404).json({ status: "FAIL", message: "Plan not found" });
		}

		// Don't allow editing Free Trial
		if (existing.name === "Free Trial") {
			return res.status(400).json({ status: "FAIL", message: "Cannot modify Free Trial plan" });
		}

		const data = {};
		if (name !== undefined && name.trim()) {
			// Check name uniqueness within same userType
			const duplicate = await prisma.subscriptionPlan.findFirst({
				where: { name: name.trim(), userType: existing.userType, id: { not: id } },
			});
			if (duplicate) {
				return res.status(400).json({ status: "FAIL", message: "A plan with this name already exists" });
			}
			data.name = name.trim();
		}
		if (amount !== undefined) {
			const amountNum = parseInt(amount, 10);
			if (isNaN(amountNum) || amountNum < 0) {
				return res.status(400).json({ status: "FAIL", message: "Amount must be a positive number (in cents)" });
			}
			data.amount = amountNum;
		}
		if (interval !== undefined) {
			if (!["MONTH", "YEAR"].includes(interval)) {
				return res.status(400).json({ status: "FAIL", message: "Interval must be MONTH or YEAR" });
			}
			data.interval = interval;
		}

		if (Object.keys(data).length === 0) {
			return res.status(400).json({ status: "FAIL", message: "No fields to update" });
		}

		const updated = await prisma.subscriptionPlan.update({
			where: { id },
			data,
		});

		return res.json({
			status: "SUCCESS",
			message: "Plan updated successfully",
			data: {
				id: updated.id,
				name: updated.name,
				amount: updated.amount,
				currency: updated.currency,
				interval: updated.interval,
				userType: updated.userType,
			},
		});
	} catch (error) {
		if (error.status === 403) return res.status(403).json({ status: "FAIL", message: error.message });
		console.error("Update subscription plan error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * POST /api/admin/subscription-plans
 * Create a new subscription plan.
 * Body: { name, userType, amount, currency?, interval? }
 */
const createSubscriptionPlan = async (req, res) => {
	try {
		assertAllowed(req);
		const { name, userType, amount, currency = "USD", interval = "MONTH" } = req.body;

		if (!name?.trim()) {
			return res.status(400).json({ status: "FAIL", message: "Name is required" });
		}
		if (!["JOB_SEEKER", "RECRUITER"].includes(userType)) {
			return res.status(400).json({ status: "FAIL", message: "userType must be JOB_SEEKER or RECRUITER" });
		}
		const amountNum = parseInt(amount, 10);
		if (isNaN(amountNum) || amountNum < 0) {
			return res.status(400).json({ status: "FAIL", message: "Amount must be a positive number (in cents)" });
		}
		if (!["MONTH", "YEAR"].includes(interval)) {
			return res.status(400).json({ status: "FAIL", message: "Interval must be MONTH or YEAR" });
		}

		// Check name uniqueness
		const duplicate = await prisma.subscriptionPlan.findFirst({
			where: { name: name.trim(), userType },
		});
		if (duplicate) {
			return res.status(400).json({ status: "FAIL", message: "A plan with this name already exists for this user type" });
		}

		const plan = await prisma.subscriptionPlan.create({
			data: { name: name.trim(), userType, amount: amountNum, currency, interval },
		});

		return res.json({
			status: "SUCCESS",
			message: "Plan created successfully",
			data: plan,
		});
	} catch (error) {
		if (error.status === 403) return res.status(403).json({ status: "FAIL", message: error.message });
		console.error("Create subscription plan error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

module.exports = { getPaymentStats, getSubscriptionPlans, updateSubscriptionPlan, createSubscriptionPlan };
