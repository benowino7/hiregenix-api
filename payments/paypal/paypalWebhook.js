/**
 * PayPal Webhook Handler
 *
 * Receives PayPal webhook notifications for payment events.
 * Matches payments to subscriptions via the `custom_id` field (our internal reference).
 * Activates subscriptions on successful payment.
 *
 * Webhook URL: https://api.hiregenix.ai/api/v1/public/paypal/webhook
 *
 * PayPal webhook events to subscribe to:
 *   - CHECKOUT.ORDER.COMPLETED
 *   - PAYMENT.CAPTURE.COMPLETED
 *   - PAYMENT.CAPTURE.DENIED
 *   - PAYMENT.CAPTURE.REFUNDED
 */

const { prisma } = require("../../prisma");

const addInterval = (startDate, interval) => {
	const d = new Date(startDate);
	switch (interval) {
		case 'QUARTER': d.setMonth(d.getMonth() + 3); break;
		case 'HALF_YEAR': d.setMonth(d.getMonth() + 6); break;
		case 'YEAR': d.setFullYear(d.getFullYear() + 1); break;
		default: d.setMonth(d.getMonth() + 1); break;
	}
	return d;
};

const paypalWebhook = async (req, res) => {
	try {
		const event = req.body;
		const eventType = event?.event_type || "";
		const resource = event?.resource || {};

		console.log(`[PayPal Webhook] Event: ${eventType}, ID: ${event?.id}`);

		// Extract our reference from custom_id or invoice_id
		const customId = resource?.custom_id
			|| resource?.purchase_units?.[0]?.custom_id
			|| resource?.supplementary_data?.related_ids?.order_id
			|| resource?.invoice_id
			|| null;

		// Also try to extract from the item description or reference
		const paypalTxnId = resource?.id
			|| resource?.purchase_units?.[0]?.payments?.captures?.[0]?.id
			|| event?.id;

		const amount = resource?.amount?.value
			|| resource?.purchase_units?.[0]?.amount?.value
			|| resource?.gross_amount?.value
			|| null;

		const currency = resource?.amount?.currency_code
			|| resource?.purchase_units?.[0]?.amount?.currency_code
			|| "USD";

		const payerEmail = resource?.payer?.email_address
			|| resource?.payee?.email_address
			|| null;

		// Build log entry
		const webhookLog = {
			at: new Date().toISOString(),
			type: "PAYPAL_WEBHOOK",
			eventType,
			eventId: event?.id,
			paypalTxnId,
			customId,
			amount,
			currency,
			payerEmail,
			raw: event,
		};

		console.log(`[PayPal Webhook] customId: ${customId}, amount: ${amount} ${currency}, payer: ${payerEmail}`);

		// Determine success or failure
		const isSuccess = [
			"CHECKOUT.ORDER.COMPLETED",
			"PAYMENT.CAPTURE.COMPLETED",
		].includes(eventType);

		const isFailure = [
			"PAYMENT.CAPTURE.DENIED",
			"PAYMENT.CAPTURE.REFUNDED",
			"CHECKOUT.ORDER.DECLINED",
		].includes(eventType);

		if (!isSuccess && !isFailure) {
			// Informational event - just log and acknowledge
			console.log(`[PayPal Webhook] Informational event ${eventType} - acknowledged`);
			return res.status(200).json({ status: "OK", message: "Event acknowledged" });
		}

		// Find the subscription/invoice by reference (custom_id)
		let invoice = null;
		let subscription = null;

		if (customId) {
			invoice = await prisma.invoice.findFirst({
				where: { reference: customId },
				select: {
					id: true,
					userId: true,
					status: true,
					periodStart: true,
					periodEnd: true,
					total: true,
					currency: true,
					items: { select: { subscriptionId: true }, take: 1 },
				},
			});
		}

		// If no invoice found by custom_id, try to find by PayPal email matching a pending subscription
		if (!invoice && payerEmail) {
			const user = await prisma.user.findFirst({
				where: { email: payerEmail.toLowerCase() },
				select: { id: true },
			});

			if (user) {
				// Find most recent PENDING subscription for this user
				subscription = await prisma.userSubscription.findFirst({
					where: { userId: user.id, status: "PENDING" },
					orderBy: { createdAt: "desc" },
					select: {
						id: true,
						userId: true,
						planId: true,
						reference: true,
						plan: {
							select: { id: true, name: true, interval: true, amount: true },
						},
					},
				});

				if (subscription?.reference) {
					invoice = await prisma.invoice.findFirst({
						where: { reference: subscription.reference },
						select: {
							id: true,
							userId: true,
							status: true,
							periodStart: true,
							periodEnd: true,
							total: true,
							currency: true,
							items: { select: { subscriptionId: true }, take: 1 },
						},
					});
				}
			}
		}

		if (!invoice) {
			console.log(`[PayPal Webhook] No matching invoice found for customId=${customId}, payer=${payerEmail}`);
			// Still return 200 to acknowledge - PayPal will keep retrying on non-200
			return res.status(200).json({
				status: "OK",
				message: "No matching subscription found - payment logged",
				eventType,
				customId,
				payerEmail,
			});
		}

		const subscriptionId = invoice.items?.[0]?.subscriptionId || null;

		if (!subscriptionId) {
			console.log(`[PayPal Webhook] Invoice found but no subscription linked`);
			return res.status(200).json({ status: "OK", message: "Invoice has no subscription" });
		}

		// Find or create payment record
		let payment = await prisma.subscriptionPayment.findFirst({
			where: { subscriptionId, invoiceId: invoice.id },
			orderBy: { createdAt: "desc" },
			select: { id: true, status: true },
		});

		// Idempotency check
		if (payment?.status === "SUCCESS" && invoice.status === "PAID") {
			console.log(`[PayPal Webhook] Already processed - idempotent`);
			return res.status(200).json({ status: "OK", message: "Already processed" });
		}

		// Process in transaction
		await prisma.$transaction(async (tx) => {
			if (isSuccess) {
				// Update or create payment record
				if (payment) {
					await tx.subscriptionPayment.update({
						where: { id: payment.id },
						data: {
							status: "SUCCESS",
							gateway: "PAYPAL",
							gatewayRef: paypalTxnId,
							paidAt: new Date(),
							gatewayLogs: { push: webhookLog },
						},
					});
				} else {
					await tx.subscriptionPayment.create({
						data: {
							subscriptionId,
							invoiceId: invoice.id,
							amount: invoice.total,
							currency: invoice.currency || "USD",
							status: "SUCCESS",
							gateway: "PAYPAL",
							gatewayRef: paypalTxnId,
							paidAt: new Date(),
							gatewayLogs: [webhookLog],
						},
					});
				}

				// Mark invoice as paid
				await tx.invoice.update({
					where: { id: invoice.id },
					data: { status: "PAID", paidAt: new Date() },
				});

				// Expire existing active subscriptions for this user
				const now = new Date();
				await tx.userSubscription.updateMany({
					where: { userId: invoice.userId, status: "ACTIVE" },
					data: { status: "EXPIRED", expiresAt: now },
				});

				// Activate the new subscription
				await tx.userSubscription.update({
					where: { id: subscriptionId },
					data: {
						status: "ACTIVE",
						startedAt: invoice.periodStart || new Date(),
						expiresAt: invoice.periodEnd || addInterval(new Date(), "MONTH"),
						canceledAt: null,
					},
				});

				console.log(`[PayPal Webhook] SUCCESS - Subscription ${subscriptionId} activated for user ${invoice.userId}`);
			} else {
				// Failure
				if (payment) {
					await tx.subscriptionPayment.update({
						where: { id: payment.id },
						data: {
							status: "FAILED",
							gateway: "PAYPAL",
							gatewayRef: paypalTxnId,
							gatewayLogs: { push: webhookLog },
						},
					});
				}

				await tx.invoice.update({
					where: { id: invoice.id },
					data: { status: "VOID" },
				});

				await tx.userSubscription.update({
					where: { id: subscriptionId },
					data: { status: "FAILED", canceledAt: new Date() },
				});

				console.log(`[PayPal Webhook] FAILED - Subscription ${subscriptionId} marked failed`);
			}
		});

		return res.status(200).json({
			status: "OK",
			message: `Payment ${isSuccess ? "activated" : "failed"}`,
			subscriptionId,
		});

	} catch (error) {
		console.error("[PayPal Webhook] Error:", error.message);
		// Return 200 to prevent PayPal from retrying indefinitely
		return res.status(200).json({
			status: "ERROR",
			message: error.message || "Webhook processing failed",
		});
	}
};

module.exports = { paypalWebhook };
