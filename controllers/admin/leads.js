const { prisma } = require("../../prisma");

/**
 * GET /admin/leads
 * List all lead captures with pagination and search
 */
const getLeads = async (req, res) => {
	try {
		const { page = 1, limit = 20, search = "", reviewed } = req.query;
		const skip = (Number(page) - 1) * Number(limit);

		const where = {};

		if (search.trim()) {
			where.OR = [
				{ fullName: { contains: search.trim(), mode: "insensitive" } },
				{ email: { contains: search.trim(), mode: "insensitive" } },
				{ phone: { contains: search.trim(), mode: "insensitive" } },
			];
		}

		if (reviewed === "true") where.isReviewed = true;
		if (reviewed === "false") where.isReviewed = false;

		const [leads, total] = await prisma.$transaction([
			prisma.leadCapture.findMany({
				where,
				skip,
				take: Number(limit),
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					fullName: true,
					email: true,
					phone: true,
					cvFileName: true,
					cvMimeType: true,
					notes: true,
					isReviewed: true,
					hasVisa: true,
					hasWorkPermit: true,
					createdAt: true,
				},
			}),
			prisma.leadCapture.count({ where }),
		]);

		return res.status(200).json({
			error: false,
			result: leads,
			meta: {
				total,
				page: Number(page),
				limit: Number(limit),
				totalPages: Math.ceil(total / Number(limit)),
			},
		});
	} catch (error) {
		console.error("getLeads error:", error);
		return res.status(500).json({ error: true, message: "Failed to fetch leads" });
	}
};

/**
 * GET /admin/leads/:id/cv
 * Download a lead's CV file
 */
const downloadLeadCv = async (req, res) => {
	try {
		const { id } = req.params;

		const lead = await prisma.leadCapture.findUnique({
			where: { id },
			select: { cvData: true, cvFileName: true, cvMimeType: true },
		});

		if (!lead || !lead.cvData) {
			return res.status(404).json({ error: true, message: "CV not found" });
		}

		res.setHeader("Content-Type", lead.cvMimeType || "application/octet-stream");
		res.setHeader("Content-Disposition", `attachment; filename="${lead.cvFileName || "cv.pdf"}"`);
		return res.send(lead.cvData);
	} catch (error) {
		console.error("downloadLeadCv error:", error);
		return res.status(500).json({ error: true, message: "Failed to download CV" });
	}
};

/**
 * PATCH /admin/leads/:id
 * Update lead (mark reviewed, add notes)
 */
const updateLead = async (req, res) => {
	try {
		const { id } = req.params;
		const { isReviewed, notes } = req.body;

		const data = {};
		if (typeof isReviewed === "boolean") data.isReviewed = isReviewed;
		if (typeof notes === "string") data.notes = notes;

		const lead = await prisma.leadCapture.update({
			where: { id },
			data,
			select: {
				id: true,
				fullName: true,
				email: true,
				phone: true,
				cvFileName: true,
				notes: true,
				isReviewed: true,
				createdAt: true,
			},
		});

		return res.status(200).json({ error: false, result: lead });
	} catch (error) {
		console.error("updateLead error:", error);
		return res.status(500).json({ error: true, message: "Failed to update lead" });
	}
};

/**
 * DELETE /admin/leads/:id
 * Delete a lead capture record
 */
const deleteLead = async (req, res) => {
	try {
		const { id } = req.params;
		await prisma.leadCapture.delete({ where: { id } });
		return res.status(200).json({ error: false, message: "Lead deleted" });
	} catch (error) {
		console.error("deleteLead error:", error);
		return res.status(500).json({ error: true, message: "Failed to delete lead" });
	}
};

module.exports = { getLeads, downloadLeadCv, updateLead, deleteLead };
