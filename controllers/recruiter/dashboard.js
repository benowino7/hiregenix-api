const { prisma } = require("../../prisma");

function parsePeriod(period) {
	// supported: 7d, 30d, 90d, 365d (default 30d)
	const p = String(period || "30d")
		.toLowerCase()
		.trim();
	const match = p.match(/^(\d+)\s*d$/);

	const days = match ? Math.max(parseInt(match[1], 10), 1) : 30;

	const now = new Date();
	const start = new Date(now);
	start.setDate(start.getDate() - days);

	const prevEnd = new Date(start);
	const prevStart = new Date(start);
	prevStart.setDate(prevStart.getDate() - days);

	return { days, now, start, prevStart, prevEnd };
}

function trend(current, previous) {
	const diff = current - previous;
	const direction = diff > 0 ? "UP" : diff < 0 ? "DOWN" : "FLAT";
	const pct = previous === 0 ? (current === 0 ? 0 : 100) : (diff / previous) * 100;

	return {
		current,
		previous,
		diff,
		direction,
		percentageChange: Math.round(pct * 10) / 10, // 1 decimal
	};
}

const getRecruiterDashboard = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ status: "FAIL", message: "Unauthorized", result: {} });
		}

		// 1) recruiter profile (to scope to company)
		const recruiter = await prisma.recruiterProfile.findUnique({
			where: { userId },
			select: { id: true, companyId: true },
		});

		if (!recruiter) {
			// New account without company onboarding — return zeroed metrics
			const { days, now: n, start: s, prevStart: ps, prevEnd: pe } = parsePeriod(req.query.period);
			const zero = { current: 0, previous: 0, diff: 0, direction: "FLAT", percentageChange: 0 };
			return res.status(200).json({
				status: "SUCCESS",
				message: "Recruiter dashboard retrieved successfully",
				result: {
					period: { key: `${days}d`, start: s.toISOString(), end: n.toISOString(), previousStart: ps.toISOString(), previousEnd: pe.toISOString() },
					metrics: { activeJobs: zero, closedJobs: { current: 0 }, applications: zero, shortlisted: zero, interviews: zero, hires: zero, pending: zero },
				},
			});
		}

		// 2) period
		const { days, now, start, prevStart, prevEnd } = parsePeriod(req.query.period);

		// 3) Common where clauses scoped to this recruiter's jobs
		const activeJobsWhere = {
			recruiterProfileId: recruiter.id,
			status: "PUBLISHED",
		};

		const closedJobsWhere = {
			recruiterProfileId: recruiter.id,
			status: "CLOSED",
		};

		// Applications scoped to recruiter's jobs
		const appsWhereCurrent = {
			createdAt: { gte: start, lte: now },
			job: { recruiterProfileId: recruiter.id },
		};

		const appsWherePrev = {
			createdAt: { gte: prevStart, lt: prevEnd },
			job: { recruiterProfileId: recruiter.id },
		};

		// 4) Fetch metrics (current + previous)
		const [
			activeJobsCurrent,
			activeJobsPrev,

			closedJobsCurrent,

			applicationsCurrent,
			applicationsPrev,

			shortlistedCurrent,
			shortlistedPrev,

			reviewingCurrent,
			reviewingPrev,

			hiresCurrent,
			hiresPrev,

			pendingCurrent,
			pendingPrev,
		] = await Promise.all([
			prisma.job.count({ where: activeJobsWhere }),
			prisma.job.count({
				where: {
					...activeJobsWhere,
					createdAt: { lt: prevEnd },
				},
			}),

			prisma.job.count({ where: closedJobsWhere }),

			prisma.jobApplication.count({ where: appsWhereCurrent }),
			prisma.jobApplication.count({ where: appsWherePrev }),

			prisma.jobApplication.count({
				where: { ...appsWhereCurrent, status: "SHORTLISTED" },
			}),
			prisma.jobApplication.count({
				where: { ...appsWherePrev, status: "SHORTLISTED" },
			}),

			prisma.jobApplication.count({
				where: { ...appsWhereCurrent, status: "REVIEWING" },
			}),
			prisma.jobApplication.count({
				where: { ...appsWherePrev, status: "REVIEWING" },
			}),

			prisma.jobApplication.count({
				where: { ...appsWhereCurrent, status: "HIRED" },
			}),
			prisma.jobApplication.count({
				where: { ...appsWherePrev, status: "HIRED" },
			}),

			prisma.jobApplication.count({
				where: { ...appsWhereCurrent, status: "SUBMITTED" },
			}),
			prisma.jobApplication.count({
				where: { ...appsWherePrev, status: "SUBMITTED" },
			}),
		]);

		return res.status(200).json({
			status: "SUCCESS",
			message: "Recruiter dashboard retrieved successfully",
			result: {
				period: {
					key: `${days}d`,
					start: start.toISOString(),
					end: now.toISOString(),
					previousStart: prevStart.toISOString(),
					previousEnd: prevEnd.toISOString(),
				},
				metrics: {
					activeJobs: trend(activeJobsCurrent, activeJobsPrev),
					closedJobs: { current: closedJobsCurrent },
					applications: trend(applicationsCurrent, applicationsPrev),
					shortlisted: trend(shortlistedCurrent, shortlistedPrev),
					interviews: trend(reviewingCurrent, reviewingPrev),
					hires: trend(hiresCurrent, hiresPrev),
					pending: trend(pendingCurrent, pendingPrev),
				},
			},
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({
			status: "FAIL",
			message: "Something went wrong",
			result: {},
		});
	}
};

module.exports = { getRecruiterDashboard };
