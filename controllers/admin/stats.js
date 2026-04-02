const { prisma } = require("../../prisma");

const getAdminStats = async (req, res) => {
	try {
		const [
			industries, skills, jobs, publishedJobs, feedJobs, mappings,
			users, jobSeekers, recruiters, admins,
			pendingApprovals, activeRecruiters, recentUsers,
		] = await Promise.all([
			prisma.industry.count({ where: { isActive: true, priority: 1 } }),
			prisma.skill.count(),
			prisma.job.count(),
			prisma.job.count({ where: { status: "PUBLISHED" } }),
			prisma.job.count({ where: { source: "FEED" } }),
			prisma.industrySkill.count({ where: { industry: { priority: 1 } } }),
			prisma.user.count(),
			prisma.user.count({ where: { roles: { some: { role: "JOB_SEEKER" } } } }),
			prisma.user.count({ where: { roles: { some: { role: "RECRUITER" } } } }),
			prisma.user.count({ where: { roles: { some: { role: "ADMIN" } } } }),
			prisma.recruiterProfile.count({ where: { status: "PENDING" } }),
			prisma.recruiterProfile.count({ where: { status: "ACTIVE" } }),
			prisma.user.findMany({
				take: 8,
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					firstName: true,
					lastName: true,
					email: true,
					createdAt: true,
					roles: { where: { isActive: true }, select: { role: true } },
					recruiterProfile: { select: { status: true } },
				},
			}),
		]);

		// Flatten roles for recent users
		const formattedRecentUsers = recentUsers.map((u) => ({
			...u,
			roles: u.roles.map((r) => r.role),
			recruiterProfile: u.recruiterProfile || null,
		}));

		return res.status(200).json({
			status: "SUCCESS",
			data: {
				industries, skills, jobs, publishedJobs, feedJobs, mappings,
				users, jobSeekers, recruiters, admins,
				pendingApprovals, activeRecruiters,
				recentUsers: formattedRecentUsers,
			},
		});
	} catch (error) {
		console.error("Get Admin Stats Error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

module.exports = { getAdminStats };
