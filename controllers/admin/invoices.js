const { prisma } = require("../../prisma");

/**
 * GET /admin/invoices
 * List all invoices with filters for user type, status, search, pagination
 */
const getAdminInvoices = async (req, res) => {
	try {
		const { page = 1, limit = 20, status, userType, search = "" } = req.query;
		const skip = (Number(page) - 1) * Number(limit);

		const where = {};

		// Status filter
		if (status && ["DRAFT", "OPEN", "PAID", "VOID"].includes(status)) {
			where.status = status;
		}

		// User type filter (JOB_SEEKER or RECRUITER)
		if (userType && ["JOB_SEEKER", "RECRUITER"].includes(userType)) {
			where.user = {
				roles: { some: { role: userType, isActive: true } },
			};
		}

		// Search by user name or email
		if (search.trim()) {
			const searchFilter = [
				{ user: { firstName: { contains: search.trim(), mode: "insensitive" } } },
				{ user: { lastName: { contains: search.trim(), mode: "insensitive" } } },
				{ user: { email: { contains: search.trim(), mode: "insensitive" } } },
			];
			if (where.user) {
				// Combine user type filter with search
				where.AND = [
					{ user: where.user },
					{ OR: searchFilter },
				];
				delete where.user;
			} else {
				where.OR = searchFilter;
			}
		}

		const [invoices, total] = await prisma.$transaction([
			prisma.invoice.findMany({
				where,
				skip,
				take: Number(limit),
				orderBy: { createdAt: "desc" },
				include: {
					user: {
						select: {
							id: true,
							firstName: true,
							lastName: true,
							email: true,
							roles: { where: { isActive: true }, select: { role: true } },
						},
					},
					subscription: {
						select: {
							id: true,
							plan: { select: { id: true, name: true, userType: true } },
						},
					},
					items: {
						select: {
							id: true,
							planName: true,
							interval: true,
							hours: true,
							unitRate: true,
							amount: true,
							currency: true,
						},
					},
					payments: {
						select: {
							id: true,
							amount: true,
							currency: true,
							status: true,
							gateway: true,
							paidAt: true,
							createdAt: true,
						},
					},
				},
			}),
			prisma.invoice.count({ where }),
		]);

		return res.status(200).json({
			error: false,
			result: invoices,
			meta: {
				total,
				page: Number(page),
				limit: Number(limit),
				totalPages: Math.ceil(total / Number(limit)),
			},
		});
	} catch (error) {
		console.error("getAdminInvoices error:", error);
		return res.status(500).json({ error: true, message: "Failed to fetch invoices" });
	}
};

module.exports = { getAdminInvoices };
