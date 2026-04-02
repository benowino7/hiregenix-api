const { prisma } = require("../../prisma");

// Only admin@hiregenix.ai can use these endpoints
const ALLOWED_EMAIL = "admin@hiregenix.ai";

function assertAllowed(req) {
	const email = req.user?.user?.email || req.user?.email;
	if (email !== ALLOWED_EMAIL) {
		const err = new Error("Only the account manager can change subscriptions");
		err.status = 403;
		throw err;
	}
}

/**
 * GET /admin/subscription-management/user/:userId
 * Get a user's current subscription + available plans
 */
const getUserSubscriptionInfo = async (req, res) => {
	try {
		assertAllowed(req);
		const { userId } = req.params;

		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: {
				id: true, firstName: true, lastName: true, email: true,
				roles: { select: { role: true } },
			},
		});
		if (!user) return res.status(404).json({ error: true, message: "User not found" });

		const userRole = user.roles.find(r => r.role === "JOB_SEEKER" || r.role === "RECRUITER")?.role;
		if (!userRole) return res.status(400).json({ error: true, message: "User is not a job seeker or recruiter" });

		const userType = userRole === "JOB_SEEKER" ? "JOB_SEEKER" : "RECRUITER";

		// Current active subscription
		const activeSub = await prisma.userSubscription.findFirst({
			where: { userId, status: "ACTIVE" },
			include: { plan: true },
			orderBy: { createdAt: "desc" },
		});

		// Available plans for this user type
		const plans = await prisma.subscriptionPlan.findMany({
			where: { userType, isActive: true },
			orderBy: { amount: "asc" },
		});

		return res.json({
			error: false,
			user: { id: user.id, name: `${user.firstName} ${user.lastName}`, email: user.email, userType },
			currentSubscription: activeSub ? {
				id: activeSub.id,
				planName: activeSub.plan.name,
				planId: activeSub.planId,
				status: activeSub.status,
				startedAt: activeSub.startedAt,
				expiresAt: activeSub.expiresAt,
				amount: activeSub.plan.amount,
				currency: activeSub.plan.currency,
			} : null,
			availablePlans: plans.map(p => ({
				id: p.id, name: p.name, amount: p.amount, currency: p.currency, interval: p.interval,
			})),
		});
	} catch (error) {
		if (error.status === 403) return res.status(403).json({ error: true, message: error.message });
		console.error("getUserSubscriptionInfo error:", error);
		return res.status(500).json({ error: true, message: "Failed to get subscription info" });
	}
};

/**
 * POST /admin/subscription-management/change
 * Force upgrade or downgrade a user's subscription plan
 * Body: { userId, planId, durationDays? }
 * durationDays: 7–365 (optional, defaults to plan interval: 30 for MONTH, 365 for YEAR)
 */
const changeUserSubscription = async (req, res) => {
	try {
		assertAllowed(req);
		const { userId, planId, durationDays: rawDuration } = req.body;

		if (!userId || !planId) {
			return res.status(400).json({ error: true, message: "userId and planId are required" });
		}

		// Validate duration if provided
		let customDuration = null;
		if (rawDuration !== undefined && rawDuration !== null) {
			customDuration = parseInt(rawDuration, 10);
			if (isNaN(customDuration) || customDuration < 7 || customDuration > 365) {
				return res.status(400).json({ error: true, message: "durationDays must be between 7 and 365" });
			}
		}

		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { id: true, firstName: true, lastName: true, email: true, roles: { select: { role: true } } },
		});
		if (!user) return res.status(404).json({ error: true, message: "User not found" });

		const userRole = user.roles.find(r => r.role === "JOB_SEEKER" || r.role === "RECRUITER")?.role;
		if (!userRole) return res.status(400).json({ error: true, message: "User is not a job seeker or recruiter" });

		const newPlan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
		if (!newPlan || !newPlan.isActive) {
			return res.status(404).json({ error: true, message: "Plan not found or inactive" });
		}

		// Verify plan matches user type
		const expectedType = userRole === "JOB_SEEKER" ? "JOB_SEEKER" : "RECRUITER";
		if (newPlan.userType !== expectedType) {
			return res.status(400).json({ error: true, message: `Plan is for ${newPlan.userType}, user is ${expectedType}` });
		}

		// Expire all current active subscriptions
		await prisma.userSubscription.updateMany({
			where: { userId, status: "ACTIVE" },
			data: { status: "EXPIRED", canceledAt: new Date() },
		});

		// Use custom duration if provided, otherwise default based on plan interval
		const durationDays = customDuration || (newPlan.interval === "YEAR" ? 365 : 30);
		const now = new Date();
		const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

		const newSub = await prisma.userSubscription.create({
			data: {
				userId,
				planId,
				status: "ACTIVE",
				startedAt: now,
				expiresAt,
				reference: `ADMIN-${Date.now()}`,
			},
		});

		console.log(`[SubscriptionMgmt] ${ALLOWED_EMAIL} changed ${user.email} to plan "${newPlan.name}" (${newPlan.amount} ${newPlan.currency})`);

		return res.json({
			error: false,
			message: `Subscription changed to ${newPlan.name} successfully`,
			subscription: {
				id: newSub.id,
				planName: newPlan.name,
				status: newSub.status,
				startedAt: newSub.startedAt,
				expiresAt: newSub.expiresAt,
			},
		});
	} catch (error) {
		if (error.status === 403) return res.status(403).json({ error: true, message: error.message });
		console.error("changeUserSubscription error:", error);
		return res.status(500).json({ error: true, message: "Failed to change subscription" });
	}
};

module.exports = { getUserSubscriptionInfo, changeUserSubscription };
