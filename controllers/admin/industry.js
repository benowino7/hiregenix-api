const { prisma } = require("../../prisma");

/**
 * Create a new industry with skill IDs
 * POST /api/industries
 */
const createIndustry = async (req, res) => {
	try {
		const { name, slug, skillIds = [] } = req.body;

		if (!name || !slug) {
			return res.status(400).json({
				status: "FAIL",
				message: "Name and slug are required",
			});
		}

		if (!Array.isArray(skillIds)) {
			return res.status(400).json({
				status: "FAIL",
				message: "skillIds must be an array",
			});
		}

		// Check industry uniqueness
		const exists = await prisma.industry.findFirst({
			where: { OR: [{ name }, { slug }] },
		});

		if (exists) {
			return res.status(409).json({
				status: "FAIL",
				message: "Industry already exists",
			});
		}

		// Validate skill IDs
		if (skillIds.length > 0) {
			const skillsCount = await prisma.skill.count({
				where: { id: { in: skillIds } },
			});

			if (skillsCount !== skillIds.length) {
				return res.status(400).json({
					status: "FAIL",
					message: "One or more skill IDs are invalid",
				});
			}
		}

		// Create industry + links
		const industry = await prisma.industry.create({
			data: {
				name,
				slug,
				skills: {
					create: skillIds.map((skillId) => ({
						skillId,
					})),
				},
			},
			include: {
				skills: {
					include: {
						skill: true,
					},
				},
			},
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Industry created successfully",
			data: industry,
		});
	} catch (error) {
		console.error("Create Industry Error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

/**
 * Get all industries with skills
 * GET /api/industries
 */
const getIndustries = async (req, res) => {
	try {
		const page = Math.max(parseInt(req.query.page || "1", 10), 1);
		const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
		const search = req.query.search || "";
		const skip = (page - 1) * limit;

		const where = {
			isActive: true,
			priority: 1,
			...(search && { name: { contains: search, mode: "insensitive" } }),
		};

		const [industries, total] = await Promise.all([
			prisma.industry.findMany({
				where,
				select: {
					id: true,
					name: true,
					slug: true,
					isActive: true,
					priority: true,
					createdAt: true,
					_count: { select: { skills: true, jobIndustries: true } },
				},
				orderBy: [{ priority: "desc" }, { name: "asc" }],
				skip,
				take: limit,
			}),
			prisma.industry.count({ where }),
		]);

		const totalPages = Math.ceil(total / limit);
		return res.status(200).json({
			status: "SUCCESS",
			data: industries,
			meta: {
				page,
				limit,
				total,
				totalPages,
				hasNext: page < totalPages,
				hasPrev: page > 1,
			},
		});
	} catch (error) {
		console.error("Get Industries Error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

/**
 * Get single industry
 * GET /api/industries/:id
 */
const getIndustryById = async (req, res) => {
	try {
		const { id } = req.params;

		const industry = await prisma.industry.findUnique({
			where: { id },
			include: {
				skills: {
					include: {
						skill: true,
					},
				},
			},
		});

		if (!industry) {
			return res.status(404).json({
				status: "FAIL",
				message: "Industry not found",
			});
		}

		return res.status(200).json({
			status: "SUCCESS",
			data: industry,
		});
	} catch (error) {
		console.error("Get Industry Error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

/**
 * Add skills to an industry
 * POST /api/industries/:id/skills
 */
const addSkillsToIndustry = async (req, res) => {
	try {
		const { id: industryId } = req.params;
		const { skillIds = [] } = req.body;

		if (!Array.isArray(skillIds) || skillIds.length === 0) {
			return res.status(400).json({
				status: "FAIL",
				message: "skillIds must be a non-empty array",
			});
		}

		// Check industry exists
		const industryExists = await prisma.industry.findUnique({
			where: { id: industryId },
		});

		if (!industryExists) {
			return res.status(404).json({
				status: "FAIL",
				message: "Industry not found",
			});
		}

		// Validate skill IDs
		const validSkillsCount = await prisma.skill.count({
			where: { id: { in: skillIds } },
		});

		if (validSkillsCount !== skillIds.length) {
			return res.status(400).json({
				status: "FAIL",
				message: "One or more skill IDs are invalid",
			});
		}

		// Create links (skip duplicates safely)
		await prisma.industrySkill.createMany({
			data: skillIds.map((skillId) => ({
				industryId,
				skillId,
			})),
			skipDuplicates: true,
		});

		// Return updated industry
		const industry = await prisma.industry.findUnique({
			where: { id: industryId },
			include: {
				skills: {
					include: {
						skill: true,
					},
				},
			},
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Skills added successfully",
			data: industry,
		});
	} catch (error) {
		console.error("Add Skills Error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

/**
 * Update an industry
 * PUT /api/industries/:id
 */
const updateIndustry = async (req, res) => {
	try {
		const { id } = req.params;
		const { name, slug, skillIds } = req.body;

		const existing = await prisma.industry.findUnique({ where: { id } });
		if (!existing) {
			return res.status(404).json({ status: "FAIL", message: "Industry not found" });
		}

		// Check uniqueness if name/slug changed
		if (name && name !== existing.name) {
			const dup = await prisma.industry.findFirst({ where: { name, id: { not: id } } });
			if (dup) return res.status(409).json({ status: "FAIL", message: "Industry name already exists" });
		}
		if (slug && slug !== existing.slug) {
			const dup = await prisma.industry.findFirst({ where: { slug, id: { not: id } } });
			if (dup) return res.status(409).json({ status: "FAIL", message: "Slug already exists" });
		}

		// Update industry fields
		const updated = await prisma.industry.update({
			where: { id },
			data: {
				...(name && { name }),
				...(slug && { slug }),
			},
		});

		// If skillIds provided, replace all skill mappings
		if (Array.isArray(skillIds)) {
			// Delete existing mappings
			await prisma.industrySkill.deleteMany({ where: { industryId: id } });
			// Create new mappings
			if (skillIds.length > 0) {
				await prisma.industrySkill.createMany({
					data: skillIds.map((skillId) => ({ industryId: id, skillId })),
					skipDuplicates: true,
				});
			}
		}

		const result = await prisma.industry.findUnique({
			where: { id },
			include: { skills: { include: { skill: true } } },
		});

		return res.status(200).json({ status: "SUCCESS", message: "Industry updated", data: result });
	} catch (error) {
		console.error("Update Industry Error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * Delete an industry
 * DELETE /api/industries/:id
 */
const deleteIndustry = async (req, res) => {
	try {
		const { id } = req.params;

		const existing = await prisma.industry.findUnique({ where: { id } });
		if (!existing) {
			return res.status(404).json({ status: "FAIL", message: "Industry not found" });
		}

		// Delete skill mappings first (cascade should handle but be safe)
		await prisma.industrySkill.deleteMany({ where: { industryId: id } });
		// Delete job-industry mappings
		await prisma.jobIndustry.deleteMany({ where: { industryId: id } });
		// Delete company-industry mappings
		await prisma.companyIndustry.deleteMany({ where: { industryId: id } });
		// Delete the industry
		await prisma.industry.delete({ where: { id } });

		return res.status(200).json({ status: "SUCCESS", message: "Industry deleted" });
	} catch (error) {
		console.error("Delete Industry Error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

module.exports = { createIndustry, getIndustries, getIndustryById, addSkillsToIndustry, updateIndustry, deleteIndustry };
