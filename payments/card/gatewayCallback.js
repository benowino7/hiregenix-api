// controllers/payments/subscriptionCallback.controller.js
const { prisma } = require("../../prisma");

const addInterval = (startDate, interval) => {
	const d = new Date(startDate);
	switch (interval) {
		case 'QUARTER': d.setMonth(d.getMonth() + 3); break;
		case 'HALF_YEAR': d.setMonth(d.getMonth() + 6); break;
		case 'YEAR': d.setFullYear(d.getFullYear() + 1); break;
		default: d.setMonth(d.getMonth() + 1); break; // MONTH
	}
	return d;
};

const subscriptionGatewayCallback = async (req, res) => {
	try {
		const { transactionStatus, transactionReport, currency, payloadAmount, payloadNetAmount, secureId, externalId } = req.body || {};

		// Basic validation
		if (!externalId) {
			return res.status(400).json({
				error: true,
				message: "externalId is required",
				result: {},
			});
		}

		// Normalize status
		const normalizedStatus = String(transactionStatus || "").toUpperCase();
		const isSuccess = normalizedStatus === "COMPLETED";

		// Build gateway log entry
		const gatewayLog = {
			at: new Date().toISOString(),
			type: "CALLBACK",
			transactionStatus: normalizedStatus,
			transactionReport,
			currency,
			payloadAmount,
			payloadNetAmount,
			secureId,
			externalId,
			raw: req.body,
		};

		/**
		 * Find invoice first by reference (recommended), because reference is unique.
		 * Fallback: find subscription by reference.
		 */
		const invoice = await prisma.invoice.findFirst({
			where: { reference: externalId },
			select: {
				id: true,
				userId: true,
				status: true,
				periodStart: true,
				periodEnd: true,
				total: true,
				currency: true,
				items: {
					select: {
						subscriptionId: true,
					},
					take: 1,
				},
			},
		});

		if (!invoice) {
			// fallback lookup via subscription reference
			const sub = await prisma.userSubscription.findFirst({
				where: { reference: externalId },
				select: { id: true },
			});

			if (!sub) {
				return res.status(404).json({
					error: true,
					message: "No invoice/subscription found for externalId",
					result: { externalId },
				});
			}

			// if you want: resolve invoice via payment/subscription relationship
			// but simplest is to require invoice.reference = externalId going forward
			return res.status(404).json({
				error: true,
				message: "Invoice not found for externalId (expected invoice.reference to match externalId)",
				result: { externalId, subscriptionId: sub.id },
			});
		}

		const subscriptionId = invoice.items?.[0]?.subscriptionId || null;
		const isExternalApply = String(externalId).startsWith("extapply_");

		if (!subscriptionId && !isExternalApply) {
			return res.status(404).json({
				error: true,
				message: "Subscription not linked to invoice (missing invoice item)",
				result: { invoiceId: invoice.id },
			});
		}

		// Find the most recent payment tied to this invoice
		const paymentWhere = { invoiceId: invoice.id };
		if (subscriptionId) paymentWhere.subscriptionId = subscriptionId;
		const payment = await prisma.subscriptionPayment.findFirst({
			where: paymentWhere,
			orderBy: { createdAt: "desc" },
			select: { id: true, status: true },
		});

		if (!payment) {
			return res.status(404).json({
				error: true,
				message: "Payment record not found for invoice/subscription",
				result: { invoiceId: invoice.id, subscriptionId },
			});
		}

		// Idempotency: if already SUCCESS and invoice PAID, just ack gateway
		if (payment.status === "SUCCESS" && invoice.status === "PAID") {
			return res.status(200).json({
				error: false,
				message: "Already processed",
				result: { externalId },
			});
		}

		// Activate / fail in a transaction
		await prisma.$transaction(async (tx) => {
			if (isSuccess) {
				// 1) Payment success
				await tx.subscriptionPayment.update({
					where: { id: payment.id },
					data: {
						status: "SUCCESS",
						paidAt: new Date(),
						gatewayLogs: { push: gatewayLog },
					},
				});

				// 2) Invoice paid
				await tx.invoice.update({
					where: { id: invoice.id },
					data: {
						status: "PAID",
						paidAt: new Date(),
						currency: invoice.currency || currency || "USD",
					},
				});

				// 3) Subscription activation (skip for external apply one-time payments)
				if (subscriptionId && !isExternalApply) {
					const index = externalId.lastIndexOf("_");
					const userId = externalId.substring(0, index);
					const now = new Date();

					// expire existing ACTIVE if upgrading immediately
					await tx.userSubscription.updateMany({
						where: { userId, status: "ACTIVE" },
						data: { status: "EXPIRED", expiresAt: now },
					});

					await tx.userSubscription.update({
						where: { id: subscriptionId },
						data: {
							status: "ACTIVE",
							startedAt: invoice.periodStart || new Date(),
							expiresAt: invoice.periodEnd || addInterval(new Date(), "MONTH"),
							canceledAt: null,
						},
					});
				}
			} else {
				// failure
				await tx.subscriptionPayment.update({
					where: { id: payment.id },
					data: {
						status: "FAILED",
						gatewayLogs: { push: gatewayLog },
					},
				});

				await tx.invoice.update({
					where: { id: invoice.id },
					data: { status: "VOID" },
				});

				if (subscriptionId) {
					await tx.userSubscription.update({
						where: { id: subscriptionId },
						data: {
							status: "FAILED",
							canceledAt: new Date(),
						},
					});
				}
			}
		});

		// Always ack gateway
		return res.status(200).json({
			error: false,
			message: "Callback processed",
			result: { externalId, transactionStatus: normalizedStatus },
		});
	} catch (error) {
		console.log(error);

		// Still return 200 sometimes to avoid gateway retries storms,
		// but since you're still building, 500 is fine.
		return res.status(500).json({
			error: true,
			message: error.message || "Callback processing failed",
			result: {},
		});
	}
};

module.exports = { subscriptionGatewayCallback };
