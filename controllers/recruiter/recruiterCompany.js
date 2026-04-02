const { prisma } = require("../../prisma");

const onboardRecruiterCompany = async (req, res) => {
	try {
		const userId = req.user.userId;

		const { companyName, registrationNumber, industries, website, address, country } = req.body;

		// 1️⃣ Basic validation
		if (!companyName || !registrationNumber || !Array.isArray(industries) || industries.length === 0) {
			return res.status(400).json({
				status: "FAIL",
				message: "Company name, registration number and industries are required",
			});
		}

		// 2️⃣ Check if recruiter already onboarded
		const existingProfile = await prisma.recruiterProfile.findUnique({
			where: { userId },
		});

		if (existingProfile) {
			return res.status(409).json({
				status: "FAIL",
				message: "Recruiter already onboarded",
			});
		}

		// 3️⃣ Validate industries exist
		const existingIndustries = await prisma.industry.findMany({
			where: {
				id: { in: industries },
			},
			select: { id: true },
		});

		if (existingIndustries.length !== industries.length) {
			const validIds = existingIndustries.map((i) => i.id);
			const invalidIds = industries.filter((id) => !validIds.includes(id));

			return res.status(400).json({
				status: "FAIL",
				message: "One or more industries do not exist",
				invalidIndustryIds: invalidIds,
			});
		}

		// 4️⃣ Transaction: create company + industries + recruiter profile + initial status log
		const result = await prisma.$transaction(async (tx) => {
			const company = await tx.company.create({
				data: {
					name: companyName,
					registrationNumber,
					website,
					address,
					country,
					industries: {
						create: industries.map((industryId) => ({
							industryId,
						})),
					},
				},
			});

			const recruiterProfile = await tx.recruiterProfile.create({
				data: {
					userId,
					companyId: company.id,
				},
			});

			// Create initial status log
			await tx.recruiterStatusLog.create({
				data: {
					recruiterId: recruiterProfile.id,
					oldStatus: "PENDING", // no previous status, use PENDING as default
					newStatus: "PENDING",
					reason: "Recruiter onboarded, awaiting approval",
				},
			});

			return { company, recruiterProfile };
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Recruiter onboarded successfully",
			data: result,
		});
	} catch (error) {
		console.error("Recruiter onboarding error:", error);

		// Unique constraint violation
		if (error.code === "P2002") {
			return res.status(409).json({
				status: "FAIL",
				message: "Company with this registration number already exists",
			});
		}

		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

const getRecruiterDetails = async (req, res) => {
	try {
		const userId = req.user.userId;

		// 2️⃣ Fetch recruiter profile + user + company
		const recruiterProfile = await prisma.recruiterProfile.findUnique({
			where: { userId },
			select: {
				user: {
					select: {
						id: true,
						email: true,
						firstName: true,
						lastName: true,
						createdAt: true,
						phoneNumber: true,
						countryCode: true,
						recruiterProfile: {
							select: {
								isApproved: true,
								status: true,
								statusLogs: {
									select: {
										oldStatus: true,
										newStatus: true,
										reason: true,
										createdAt: true
									}
								}
							}
						}
					},
				},
				company: {
					select: {
						id: true,
						name: true,
						registrationNumber: true,
						website: true,
						address: true,
						country: true,
						industries: {
							include: {
								industry: true,
							},
						},
					},
				},
				statusLogs: {
					select: {
						oldStatus: true,
						newStatus: true,
						createdAt: true,
						reason: true,
					},
				},
				recruiterRoles: {
					select: {
						role: true,
						permissions: true,
					},
				},
			},
		});

		// 3️⃣ Not onboarded
		if (!recruiterProfile) {
			return res.status(200).json({
				status: "SUCCESS",
				onboarded: false,
				profile: null,
				company: null,
			});
		}

		// 4️⃣ Onboarded → return full context
		return res.status(200).json({
			status: "SUCCESS",
			onboarded: true,
			profile: {
				id: recruiterProfile.id,
				createdAt: recruiterProfile.createdAt,
				user: recruiterProfile.user,
			},
			company: {
				id: recruiterProfile.company.id,
				name: recruiterProfile.company.name,
				registrationNumber: recruiterProfile.company.registrationNumber,
				website: recruiterProfile.company.website,
				address: recruiterProfile.company.address,
				country: recruiterProfile.company.country,
				isVerified: recruiterProfile.company.isVerified,
				industries: recruiterProfile.company.industries.map((ci) => ci.industry),
				createdAt: recruiterProfile.company.createdAt,
			},
		});
	} catch (error) {
		console.error("Get recruiter onboarding error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

const addCompanyIndustry = async (req, res) => {
	try {
		const userId = req.user.userId;
		const { industryId } = req.body;

		if (!industryId) {
			return res.status(400).json({
				status: "FAIL",
				message: "industryId is required",
			});
		}

		// 1️⃣ Get recruiter profile + company
		const recruiterProfile = await prisma.recruiterProfile.findUnique({
			where: { userId },
			select: { companyId: true },
		});

		if (!recruiterProfile) {
			return res.status(403).json({
				status: "FAIL",
				message: "Recruiter onboarding required",
			});
		}

		const companyId = recruiterProfile.companyId;

		// 2️⃣ Check industry exists
		const industry = await prisma.industry.findUnique({
			where: { id: industryId },
			select: { id: true },
		});

		if (!industry) {
			return res.status(404).json({
				status: "FAIL",
				message: "Industry not found",
			});
		}

		// 3️⃣ Prevent duplicates
		const existingLink = await prisma.companyIndustry.findUnique({
			where: {
				companyId_industryId: {
					companyId,
					industryId,
				},
			},
		});

		if (existingLink) {
			return res.status(409).json({
				status: "FAIL",
				message: "Industry already added to company",
			});
		}

		// 4️⃣ Create link
		await prisma.companyIndustry.create({
			data: {
				companyId,
				industryId,
			},
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Industry added to company successfully",
		});
	} catch (error) {
		console.error("Add company industry error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

module.exports = {
	onboardRecruiterCompany,
	getRecruiterDetails,
	addCompanyIndustry,
};
