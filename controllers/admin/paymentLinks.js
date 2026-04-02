const { prisma } = require("../../prisma");
const { initiateCardPayment } = require("../../payments/card/initiatePayment");
const crypto = require("crypto");

/**
 * POST /admin/payment-links
 * Generate a payment link for a user (Diamond plan or custom)
 */
const generatePaymentLink = async (req, res) => {
	try {
		const { userId, amount, currency = "USD", paymentMethod = "CARD", description = "Diamond Plan Payment", billingAddress = {} } = req.body;

		if (!userId) return res.status(400).json({ error: true, message: "userId is required" });
		if (!amount || Number(amount) <= 0) return res.status(400).json({ error: true, message: "Valid amount is required" });
		if (!["CARD", "GPAY_APAY"].includes(paymentMethod)) return res.status(400).json({ error: true, message: "paymentMethod must be CARD or GPAY_APAY" });
		if (!["USD", "AED"].includes(currency)) return res.status(400).json({ error: true, message: "Currency must be USD or AED" });

		// Fetch user with profile data
		const user = await prisma.user.findUnique({
			where: { id: userId },
			include: {
				roles: { where: { isActive: true } },
				jobSeekerProfile: true,
				recruiterProfile: { include: { company: true } },
			},
		});

		if (!user) return res.status(404).json({ error: true, message: "User not found" });

		// Find or create a Diamond plan for this user type
		const userRole = user.roles.find(r => r.role === "RECRUITER") ? "RECRUITER" : "JOB_SEEKER";
		let plan = await prisma.subscriptionPlan.findFirst({
			where: { name: "Diamond", userType: userRole, isActive: true },
		});

		// If no Diamond plan exists, use any active plan or create a reference
		if (!plan) {
			plan = await prisma.subscriptionPlan.findFirst({
				where: { userType: userRole, isActive: true },
				orderBy: { amount: "desc" },
			});
		}

		if (!plan) return res.status(400).json({ error: true, message: "No subscription plan found for this user type" });

		const amountMinor = Math.round(Number(amount) * 100); // Convert to cents
		const externalId = crypto.randomUUID();

		// Create subscription + invoice + payment records
		const now = new Date();
		const periodEnd = new Date(now);
		periodEnd.setMonth(periodEnd.getMonth() + 1);

		const subscription = await prisma.userSubscription.create({
			data: {
				userId,
				planId: plan.id,
				status: "PENDING",
				reference: externalId,
			},
		});

		const invoice = await prisma.invoice.create({
			data: {
				userId,
				userSubscriptionId: subscription.id,
				status: "OPEN",
				periodStart: now,
				periodEnd,
				subtotal: amountMinor,
				tax: 0,
				total: amountMinor,
				currency,
				items: {
					create: {
						subscriptionId: subscription.id,
						planName: plan.name,
						interval: plan.interval || "MONTH",
						amount: amountMinor,
					},
				},
			},
		});

		const payment = await prisma.subscriptionPayment.create({
			data: {
				subscriptionId: subscription.id,
				invoiceId: invoice.id,
				amount: amountMinor,
				currency,
				status: "PENDING",
				gateway: paymentMethod,
				gatewayRef: externalId,
			},
		});

		// Build payment data
		const paymentData = {
			amount: String(Number(amount)),
			paymentMethod,
			currency,
			externalId,
		};

		// For GPAY_APAY, add customer + billing details
		if (paymentMethod === "GPAY_APAY") {
			paymentData.verticle = "hiregenix";
			paymentData.description = description;
			paymentData.first_name = user.firstName;
			paymentData.last_name = user.lastName;
			paymentData.email = user.email;
			paymentData.phone = `${user.countryCode}${user.phoneNumber}`;

			// Use billing address from request or user profile
			paymentData.address1 = billingAddress.address1 || "";
			paymentData.administrative_area = billingAddress.administrative_area || billingAddress.state || "";
			paymentData.country = billingAddress.country || user.countryCode || "";
			paymentData.locality = billingAddress.locality || billingAddress.city || "";
			paymentData.postal_code = billingAddress.postal_code || "";
		}

		// Call payment gateway
		const gatewayResult = await initiateCardPayment(paymentData);

		// Log gateway response
		await prisma.subscriptionPayment.update({
			where: { id: payment.id },
			data: { gatewayLogs: { push: { action: "initiate", timestamp: new Date().toISOString(), result: gatewayResult } } },
		});

		if (gatewayResult.error) {
			// Mark as failed
			await prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
			await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "VOID" } });
			await prisma.userSubscription.update({ where: { id: subscription.id }, data: { status: "FAILED" } });

			return res.status(400).json({
				error: true,
				message: gatewayResult.message || "Failed to generate payment link",
				result: gatewayResult,
			});
		}

		return res.status(200).json({
			error: false,
			message: "Payment link generated successfully",
			result: {
				paymentLink: gatewayResult.result?.checkoutUrl || gatewayResult.result?.data?.payment_link || gatewayResult.result?.paymentLink || gatewayResult.result?.paymentUrl || gatewayResult.result?.redirect_url || null,
				gatewayResponse: gatewayResult.result,
				subscriptionId: subscription.id,
				invoiceId: invoice.id,
				paymentId: payment.id,
				externalId,
			},
		});
	} catch (error) {
		console.error("generatePaymentLink error:", error);
		return res.status(500).json({ error: true, message: "Failed to generate payment link" });
	}
};

/**
 * GET /admin/payment-transactions
 * List all payment transactions with user and plan info
 */
const getPaymentTransactions = async (req, res) => {
	try {
		const { page = 1, limit = 20, status } = req.query;
		const skip = (Number(page) - 1) * Number(limit);

		const where = {};
		if (status && ["PENDING", "SUCCESS", "FAILED"].includes(status)) {
			where.status = status;
		}

		const [payments, total] = await prisma.$transaction([
			prisma.subscriptionPayment.findMany({
				where,
				skip,
				take: Number(limit),
				orderBy: { createdAt: "desc" },
				include: {
					subscription: {
						include: {
							user: { select: { id: true, firstName: true, lastName: true, email: true, phoneNumber: true, roles: { where: { isActive: true }, select: { role: true } } } },
							plan: { select: { id: true, name: true, userType: true, amount: true, currency: true, interval: true } },
						},
					},
				},
			}),
			prisma.subscriptionPayment.count({ where }),
		]);

		return res.status(200).json({
			error: false,
			result: payments,
			meta: {
				total,
				page: Number(page),
				limit: Number(limit),
				totalPages: Math.ceil(total / Number(limit)),
			},
		});
	} catch (error) {
		console.error("getPaymentTransactions error:", error);
		return res.status(500).json({ error: true, message: "Failed to fetch transactions" });
	}
};

/**
 * GET /admin/payment-users
 * Get list of users (job seekers + recruiters) with address info for payment form
 */
const getUsersForPayment = async (req, res) => {
	try {
		const { search = "", page = 1, limit = 20 } = req.query;
		const skip = (Number(page) - 1) * Number(limit);

		const where = {
			roles: { some: { role: { in: ["JOB_SEEKER", "RECRUITER"] }, isActive: true } },
		};

		if (search.trim()) {
			where.OR = [
				{ firstName: { contains: search.trim(), mode: "insensitive" } },
				{ lastName: { contains: search.trim(), mode: "insensitive" } },
				{ email: { contains: search.trim(), mode: "insensitive" } },
			];
		}

		const [users, total] = await prisma.$transaction([
			prisma.user.findMany({
				where,
				skip,
				take: Number(limit),
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					firstName: true,
					lastName: true,
					email: true,
					countryCode: true,
					phoneNumber: true,
					roles: { where: { isActive: true }, select: { role: true } },
					recruiterProfile: { select: { company: { select: { name: true, country: true } } } },
				},
			}),
			prisma.user.count({ where }),
		]);

		return res.status(200).json({
			error: false,
			result: users,
			meta: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) },
		});
	} catch (error) {
		console.error("getUsersForPayment error:", error);
		return res.status(500).json({ error: true, message: "Failed to fetch users" });
	}
};

module.exports = { generatePaymentLink, getPaymentTransactions, getUsersForPayment };
