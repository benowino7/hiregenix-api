const { prisma } = require("../../prisma");

const getJobSeekerDashboard = async (req, res) => {
	try {
		const userId = req.user?.userId;

		if (!userId) {
			return res.status(401).json({
				status: "FAIL",
				message: "Unauthorized",
				result: {},
			});
		}

		// 1) Get user + job seeker profile (experience/education/certifications from DB)
		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: {
				id: true,
				firstName: true,
				lastName: true,
				phoneNumber: true,
				jobSeekerProfile: {
					select: {
						id: true,
						experience: true,
						education: true,
						certifications: true,
						skills: { select: { id: true } },
						cvs: {
							select: {
								id: true,
								fileName: true,
								isPrimary: true,
								createdAt: true,
							},
							orderBy: { createdAt: "desc" },
							take: 5,
						},
					},
				},
			},
		});

		const jobSeeker = user?.jobSeekerProfile;

		if (!jobSeeker) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker profile not found",
				result: {},
			});
		}

		// 2) This week's start
		const now = new Date();
		const startOfWeek = new Date(now);
		const day = startOfWeek.getDay();
		const diffToMonday = (day === 0 ? -6 : 1) - day;
		startOfWeek.setDate(startOfWeek.getDate() + diffToMonday);
		startOfWeek.setHours(0, 0, 0, 0);

		// 3) Stats
		const [totalApplications, weeklyApplications, savedJobsCount, totalCvs] = await Promise.all([
			prisma.jobApplication.count({
				where: { jobSeekerId: jobSeeker.id },
			}),

			prisma.jobApplication.count({
				where: {
					jobSeekerId: jobSeeker.id,
					createdAt: { gte: startOfWeek },
				},
			}),

			prisma.savedJob.count({
				where: { jobSeekerId: jobSeeker.id },
			}),

			prisma.jobSeekerCV.count({
				where: { jobSeekerId: jobSeeker.id },
			}),
		]);

		// 4) Read experience, education, certifications from DB JSON fields
		const experience = Array.isArray(jobSeeker.experience) ? jobSeeker.experience : [];
		const education = Array.isArray(jobSeeker.education) ? jobSeeker.education : [];
		const certifications = Array.isArray(jobSeeker.certifications) ? jobSeeker.certifications : [];

		// 5) Profile completion (6 sections)
		const checks = {
			basicInfo: !!(user.firstName && user.lastName && user.phoneNumber),
			cvUploaded: totalCvs > 0,
			skillsAdded: jobSeeker.skills.length > 0,
			experienceAdded: experience.length > 0,
			educationAdded: education.length > 0,
			certificationsAdded: certifications.length > 0,
		};

		const completedCount = Object.values(checks).filter(Boolean).length;
		const totalSections = Object.keys(checks).length;
		const completionPercentage = Math.round((completedCount / totalSections) * 100);

		const primaryCv = jobSeeker.cvs.find((c) => c.isPrimary) || jobSeeker.cvs[0] || null;

		return res.status(200).json({
			status: "SUCCESS",
			message: "Dashboard retrieved successfully",
			result: {
				applications: {
					total: totalApplications,
					thisWeek: weeklyApplications,
				},

				savedJobs: {
					total: savedJobsCount,
				},

				cvs: {
					total: totalCvs,
					primary: primaryCv,
					recent: jobSeeker.cvs,
				},

				profileCompletion: {
					percentage: completionPercentage,
					checks,
				},
			},
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({
			status: "FAIL",
			message: "Something went wrong",
			result: [],
		});
	}
};

module.exports = { getJobSeekerDashboard };
