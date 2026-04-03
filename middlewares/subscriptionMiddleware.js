const { prisma } = require("../prisma");

// middlewares/subscription.middleware.js
const requireActiveJobSeekerSubscription = async (req, res, next) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ error: true, message: "Unauthorized", result: {} });
		}

		const now = new Date();

		const subscription = await prisma.userSubscription.findFirst({
			where: {
				userId,
				status: "ACTIVE",
				canceledAt: null,
				startedAt: { not: null },
				OR: [{ expiresAt: { gt: now } }, { expiresAt: null }],
				plan: { userType: "JOB_SEEKER" },
			},
			orderBy: { expiresAt: "desc" },
			select: {
				id: true,
				planId: true,
				status: true,
				startedAt: true,
				expiresAt: true,
				plan: {
					select: {
						id: true,
						name: true,
						userType: true,
						isActive: true,
						feature: {
							select: { features: true }, // SubscriptionFeature.features JSON
						},
					},
				},
			},
		});

		if (!subscription) {
			return res.status(403).json({
				error: true,
				message: "Active subscription required. Please subscribe to continue.",
				result: { requiresSubscription: true },
			});
		}

		// Block free trial — must have paid subscription
		if (subscription.plan?.name === "Free Trial") {
			return res.status(403).json({
				error: true,
				message: "A paid subscription is required. Please subscribe to at least Silver to access this feature.",
				result: { requiresSubscription: true, requiresUpgrade: true },
			});
		}

		req.subscription = subscription;
		req.subscriptionFeatures = subscription.plan?.feature?.features || null;
		req.isTrial = false; // trials are now blocked above
		req.planName = subscription.plan?.name || null;

		return next();
	} catch (error) {
		console.log(error);
		return res.status(500).json({ error: true, message: "Something went wrong", result: {} });
	}
};

// middlewares/savedJobsLimit.middleware.js
const enforceSavedJobsLimit = async (req, res, next) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ error: true, message: "Unauthorized", result: {} });
		}

        // 1) get job seeker profile
		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(403).json({
				error: true,
				message: "Job seeker profile not found",
				result: {},
			});
		}

		// requireActiveJobSeekerSubscription should have already attached this
		const features = req.subscriptionFeatures;

		// Default rule: if not found, treat as not allowed or set a safe default.
		// Since you said "must be subscribed", and plans define limits, we can default to 0
		// OR you can default to -1 (unlimited). I’ll default to 0 (safer).
		let limit = features?.limits?.savedJobs;

		// normalize
		if (limit === undefined || limit === null) limit = 0;

		// -1 means unlimited
		if (limit === -1) return next();

		// count user's saved jobs
		const savedCount = await prisma.savedJob.count({
			where: { jobSeekerId: jobSeeker.id },
		});

		if (savedCount >= limit) {
			return res.status(403).json({
				error: true,
				message: `Saved jobs limit reached (${limit}). Upgrade your plan to save more jobs.`,
				result: {
					limit,
					savedCount,
				},
			});
		}

		return next();
	} catch (error) {
		console.log(error);
		return res.status(500).json({ error: true, message: "Something went wrong", result: {} });
	}
};

// Non-blocking middleware: attaches subscription info to req but doesn't block if none found
const getSubscriptionInfo = async (req, res, next) => {
	try {
		const userId = req.user?.userId;
		if (!userId) return next();

		const now = new Date();
		const subscription = await prisma.userSubscription.findFirst({
			where: {
				userId,
				status: "ACTIVE",
				canceledAt: null,
				startedAt: { not: null },
				OR: [{ expiresAt: { gt: now } }, { expiresAt: null }],
				plan: { userType: "JOB_SEEKER" },
			},
			orderBy: { expiresAt: "desc" },
			select: {
				id: true,
				planId: true,
				status: true,
				startedAt: true,
				expiresAt: true,
				plan: {
					select: {
						id: true,
						name: true,
						userType: true,
						isActive: true,
						feature: { select: { features: true } },
					},
				},
			},
		});

		if (subscription) {
			req.subscription = subscription;
			req.subscriptionFeatures = subscription.plan?.feature?.features || null;
			req.isTrial = subscription.plan?.name === "Free Trial";
			req.planName = subscription.plan?.name || null;
		}

		return next();
	} catch (error) {
		console.log(error);
		return next();
	}
};

// Blocks trial users — runs AFTER requireActiveJobSeekerSubscription
const requirePaidSubscription = async (req, res, next) => {
	if (req.isTrial) {
		return res.status(403).json({
			error: true,
			message: "This feature requires a paid subscription. Please upgrade from your free trial.",
			result: { requiresUpgrade: true },
		});
	}
	return next();
};

// ── RECRUITER subscription middleware ──

const requireActiveRecruiterSubscription = async (req, res, next) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ error: true, message: "Unauthorized", result: {} });
		}

		const now = new Date();

		const subscription = await prisma.userSubscription.findFirst({
			where: {
				userId,
				status: "ACTIVE",
				canceledAt: null,
				startedAt: { not: null },
				OR: [{ expiresAt: { gt: now } }, { expiresAt: null }],
				plan: { userType: "RECRUITER" },
			},
			orderBy: { expiresAt: "desc" },
			select: {
				id: true,
				planId: true,
				status: true,
				startedAt: true,
				expiresAt: true,
				plan: {
					select: {
						id: true,
						name: true,
						userType: true,
						isActive: true,
						feature: { select: { features: true } },
					},
				},
			},
		});

		if (!subscription) {
			return res.status(403).json({
				error: true,
				message: "Active subscription required. Please subscribe to continue.",
				result: { requiresSubscription: true },
			});
		}

		// Block free trial — must have paid subscription
		if (subscription.plan?.name === "Free Trial") {
			return res.status(403).json({
				error: true,
				message: "A paid subscription is required. Please subscribe to a plan to access this feature.",
				result: { requiresSubscription: true, requiresUpgrade: true },
			});
		}

		req.subscription = subscription;
		req.subscriptionFeatures = subscription.plan?.feature?.features || null;
		req.isTrial = false;
		req.planName = subscription.plan?.name || null;

		return next();
	} catch (error) {
		console.log(error);
		return res.status(500).json({ error: true, message: "Something went wrong", result: {} });
	}
};

const requirePaidRecruiterSubscription = async (req, res, next) => {
	if (req.isTrial) {
		return res.status(403).json({
			error: true,
			message: "This feature requires a paid subscription. Please upgrade from your free trial.",
			result: { requiresUpgrade: true },
		});
	}
	return next();
};

const enforceActiveJobsLimit = async (req, res, next) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ error: true, message: "Unauthorized", result: {} });
		}

		const features = req.subscriptionFeatures;
		let limit = features?.limits?.activeJobs;
		if (limit === undefined || limit === null) limit = 0;
		if (limit === -1) return next(); // unlimited

		const recruiter = await prisma.recruiterProfile.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!recruiter) {
			return res.status(403).json({ error: true, message: "Recruiter profile not found", result: {} });
		}

		// Count only PUBLISHED jobs toward the limit (drafts don't count)
		const activeCount = await prisma.job.count({
			where: {
				recruiterProfileId: recruiter.id,
				status: "PUBLISHED",
			},
		});

		if (activeCount >= limit) {
			return res.status(403).json({
				error: true,
				message: `Active jobs limit reached (${limit}). Upgrade your plan to post more jobs.`,
				result: { limit, activeCount, requiresUpgrade: true },
			});
		}

		return next();
	} catch (error) {
		console.log(error);
		return res.status(500).json({ error: true, message: "Something went wrong", result: {} });
	}
};

/**
 * Feature-level gating for recruiter subscription plans.
 * Runs AFTER requireActiveRecruiterSubscription (which attaches req.subscriptionFeatures).
 *
 * @param {string} category  - top-level key in features JSON: "access", "ai", "limits"
 * @param {string} key       - feature key within the category
 *
 * Boolean values:  true = allowed, false = blocked
 * String values:   "Not Available" = blocked, anything else = allowed
 */
const requireRecruiterFeature = (category, key) => {
	return (req, res, next) => {
		const features = req.subscriptionFeatures;
		if (!features) {
			return res.status(403).json({
				error: true,
				message: "Subscription features not available. Please subscribe to a plan.",
				result: { requiresUpgrade: true },
			});
		}

		const value = features?.[category]?.[key];

		// Boolean check
		if (value === false) {
			return res.status(403).json({
				error: true,
				message: `This feature is not available on your current plan. Please upgrade to access ${key}.`,
				result: { requiresUpgrade: true, feature: `${category}.${key}` },
			});
		}

		// String check — "Not Available" means blocked
		if (typeof value === "string" && value.toLowerCase() === "not available") {
			return res.status(403).json({
				error: true,
				message: `This feature is not available on your current plan. Please upgrade to access ${key}.`,
				result: { requiresUpgrade: true, feature: `${category}.${key}` },
			});
		}

		return next();
	};
};

module.exports = {
	requireActiveJobSeekerSubscription,
	enforceSavedJobsLimit,
	getSubscriptionInfo,
	requirePaidSubscription,
	requireActiveRecruiterSubscription,
	requirePaidRecruiterSubscription,
	enforceActiveJobsLimit,
	requireRecruiterFeature,
};
