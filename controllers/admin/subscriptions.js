// controllers/subscription.controller.js

const { prisma } = require("../../prisma");

const getSubscriptions = async (req, res) => {
	try {
		const { userType } = req.query; // JOB_SEEKER | RECRUITER (optional)

		// ---------------- VALIDATION ----------------
		if (userType && !["JOB_SEEKER", "RECRUITER"].includes(userType)) {
			return res.status(400).json({
				error: true,
				message: "Invalid userType. Must be JOB_SEEKER or RECRUITER",
				result: [],
			});
		}

		// ---------------- QUERY ----------------
		const plans = await prisma.subscriptionPlan.findMany({
			where: {
				isActive: true,
				...(userType && { userType }),
			},
			include: {
				feature: true, // relation name from your model
			},
			orderBy: {
				amount: "asc", // cheaper first
			},
		});

		// ---------------- FORMAT RESPONSE ----------------
		const result = plans.map((plan) => ({
			id: plan.id,
			name: plan.name,
			userType: plan.userType,
			amount: plan.amount,
			currency: plan.currency,
			interval: plan.interval,
			features: plan.feature?.features || {},
		}));

		return res.status(200).json({
			error: false,
			message: "Subscriptions fetched successfully",
			result,
		});
	} catch (error) {
		console.log(error);

		return res.status(500).json({
			error: true,
			message: error.message || "Failed to fetch subscriptions",
			result: [],
		});
	}
};

module.exports = { getSubscriptions };