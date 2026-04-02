const { prisma } = require("../prisma");

/**
 * GET /public/testimonials?type=JOB_SEEKER|RECRUITER
 * Returns approved testimonials for landing pages (public, no auth)
 */
const getPublicTestimonials = async (req, res) => {
	try {
		const userType = (req.query.type || "").toUpperCase();
		const where = { isApproved: true };
		if (userType === "JOB_SEEKER" || userType === "RECRUITER") {
			where.userType = userType;
		}

		const testimonials = await prisma.testimonial.findMany({
			where,
			orderBy: { createdAt: "desc" },
			take: 20,
			include: {
				user: {
					select: {
						firstName: true,
						lastName: true,
						jobSeekerProfile: { select: { id: true } },
						recruiterProfile: { select: { id: true } },
					},
				},
			},
		});

		return res.status(200).json({
			status: "SUCCESS",
			data: testimonials.map((t) => ({
				id: t.id,
				name: `${t.user.firstName} ${t.user.lastName}`,
				profilePicture: null,
				role: t.role,
				company: t.company,
				rating: t.rating,
				text: t.text,
				userType: t.userType,
				createdAt: t.createdAt,
			})),
		});
	} catch (error) {
		console.error(error);
		return res.status(500).json({ status: "FAIL", message: "Failed to fetch testimonials" });
	}
};

/**
 * GET /job-seeker/testimonial or /recruiter/testimonial
 * Get current user's testimonial (auth required)
 */
const getMyTestimonial = async (req, res) => {
	try {
		const userId = req.user.userId;
		const testimonial = await prisma.testimonial.findUnique({
			where: { userId },
		});

		return res.status(200).json({
			status: "SUCCESS",
			data: testimonial,
		});
	} catch (error) {
		console.error(error);
		return res.status(500).json({ status: "FAIL", message: "Failed to fetch testimonial" });
	}
};

/**
 * POST /job-seeker/testimonial or /recruiter/testimonial
 * Create or update the user's testimonial (one per user)
 */
const upsertTestimonial = async (req, res) => {
	try {
		const userId = req.user.userId;
		const { rating, text, role, company } = req.body;

		if (!text || !text.trim()) {
			return res.status(400).json({ status: "FAIL", message: "Testimonial text is required" });
		}
		if (!rating || rating < 1 || rating > 5) {
			return res.status(400).json({ status: "FAIL", message: "Rating must be between 1 and 5" });
		}

		// Determine user type from roles
		const user = await prisma.user.findUnique({
			where: { id: userId },
			include: { roles: { select: { role: true } } },
		});

		let userType = "JOB_SEEKER";
		if (user.roles.some((r) => r.role === "RECRUITER")) {
			userType = "RECRUITER";
		}

		const testimonial = await prisma.testimonial.upsert({
			where: { userId },
			create: {
				userId,
				userType,
				rating: Number(rating),
				text: text.trim(),
				role: role?.trim() || null,
				company: company?.trim() || null,
			},
			update: {
				rating: Number(rating),
				text: text.trim(),
				role: role?.trim() || null,
				company: company?.trim() || null,
				isApproved: false, // re-submit for approval on edit
			},
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Testimonial saved successfully. It will be visible after admin approval.",
			data: testimonial,
		});
	} catch (error) {
		console.error(error);
		return res.status(500).json({ status: "FAIL", message: "Failed to save testimonial" });
	}
};

/**
 * GET /admin/testimonials — List all testimonials (admin only)
 */
const getAllTestimonials = async (req, res) => {
	try {
		const page = Math.max(parseInt(req.query.page || "1", 10), 1);
		const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
		const skip = (page - 1) * limit;
		const type = (req.query.type || "").toUpperCase();
		const approved = req.query.approved;

		const where = {};
		if (type === "JOB_SEEKER" || type === "RECRUITER") where.userType = type;
		if (approved === "true") where.isApproved = true;
		if (approved === "false") where.isApproved = false;

		const [total, testimonials] = await Promise.all([
			prisma.testimonial.count({ where }),
			prisma.testimonial.findMany({
				where,
				orderBy: { createdAt: "desc" },
				skip,
				take: limit,
				include: {
					user: {
						select: {
							firstName: true,
							lastName: true,
							email: true,
							jobSeekerProfile: { select: { id: true } },
						},
					},
				},
			}),
		]);

		return res.status(200).json({
			status: "SUCCESS",
			data: testimonials,
			meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
		});
	} catch (error) {
		console.error(error);
		return res.status(500).json({ status: "FAIL", message: "Failed to fetch testimonials" });
	}
};

/**
 * PATCH /admin/testimonials/:id — Approve/reject or edit testimonial
 */
const updateTestimonial = async (req, res) => {
	try {
		const { id } = req.params;
		const { isApproved, text, rating } = req.body;

		const data = {};
		if (isApproved !== undefined) data.isApproved = Boolean(isApproved);
		if (text) data.text = text.trim();
		if (rating) data.rating = Number(rating);

		const testimonial = await prisma.testimonial.update({
			where: { id },
			data,
		});

		return res.status(200).json({ status: "SUCCESS", data: testimonial });
	} catch (error) {
		console.error(error);
		return res.status(500).json({ status: "FAIL", message: "Failed to update testimonial" });
	}
};

/**
 * DELETE /admin/testimonials/:id
 */
const deleteTestimonial = async (req, res) => {
	try {
		const { id } = req.params;
		await prisma.testimonial.delete({ where: { id } });
		return res.status(200).json({ status: "SUCCESS", message: "Testimonial deleted" });
	} catch (error) {
		console.error(error);
		return res.status(500).json({ status: "FAIL", message: "Failed to delete testimonial" });
	}
};

module.exports = {
	getPublicTestimonials,
	getMyTestimonial,
	upsertTestimonial,
	getAllTestimonials,
	updateTestimonial,
	deleteTestimonial,
};
