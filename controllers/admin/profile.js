const { prisma } = require("../../prisma");

const updateAdminProfile = async (req, res) => {
	try {
		const userId = req.user.id;
		const { firstName, lastName, email, phoneNumber, countryCode } = req.body;

		const updateData = {};
		if (firstName !== undefined) updateData.firstName = firstName.trim();
		if (lastName !== undefined) updateData.lastName = lastName.trim();
		if (email !== undefined) updateData.email = email.trim().toLowerCase();
		if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber.trim();
		if (countryCode !== undefined) updateData.countryCode = countryCode.trim();

		if (Object.keys(updateData).length === 0) {
			return res.status(400).json({ status: "ERROR", message: "No fields to update" });
		}

		// If email is changing, check it's not taken
		if (updateData.email) {
			const existing = await prisma.user.findFirst({
				where: { email: updateData.email, id: { not: userId } },
			});
			if (existing) {
				return res.status(409).json({ status: "ERROR", message: "Email already in use" });
			}
		}

		const updated = await prisma.user.update({
			where: { id: userId },
			data: updateData,
			select: {
				id: true,
				firstName: true,
				lastName: true,
				email: true,
				phoneNumber: true,
				countryCode: true,
				roles: true,
				isActive: true,
				createdAt: true,
			},
		});

		return res.json({
			status: "SUCCESS",
			message: "Profile updated successfully",
			result: updated,
		});
	} catch (error) {
		console.error("Admin updateProfile error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

module.exports = { updateAdminProfile };
