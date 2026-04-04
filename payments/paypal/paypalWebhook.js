/**
 * PayPal Webhook Handler
 *
 * Receives PayPal webhook notifications for payment events.
 * Matches payments to subscriptions via `custom_id` (our internal reference).
 * Activates HireGeniX subscriptions only on successful payment.
 *
 * Webhook URL: https://api.hiregenix.ai/api/v1/public/paypal/webhook
 *
 * Events to subscribe to in PayPal:
 *   - CHECKOUT.ORDER.APPROVED (one-time orders)
 *   - PAYMENT.CAPTURE.COMPLETED (one-time capture)
 *   - PAYMENT.CAPTURE.DENIED
 *   - PAYMENT.CAPTURE.REFUNDED
 *   - BILLING.SUBSCRIPTION.ACTIVATED (recurring subscriptions)
 *   - BILLING.SUBSCRIPTION.CANCELLED
 *   - BILLING.SUBSCRIPTION.EXPIRED
 *   - PAYMENT.SALE.COMPLETED (recurring payment received)
 */

const { prisma } = require("../../prisma");
const { capturePayPalOrder } = require("./paypalClient");

const addInterval = (startDate, interval) => {
	const d = new Date(startDate);
	switch (interval) {
		case "QUARTER": d.setMonth(d.getMonth() + 3); break;
		case "HALF_YEAR": d.setMonth(d.getMonth() + 6); break;
		case "YEAR": d.setFullYear(d.getFullYear() + 1); break;
		default: d.setMonth(d.getMonth() + 1); break;
	}
	return d;
};

/**
 * Extract our custom_id reference from various PayPal event structures
 */
function extractReference(event) {
	const r = event?.resource || {};
	return (
		r.custom_id ||
		r.purchase_units?.[0]?.custom_id ||
		r.custom ||
		r.billing_agreement_id ||
		null
	);
}

/**
 * Extract PayPal transaction/subscription ID
 */
function extractPayPalId(event) {
	const r = event?.resource || {};
	return (
		r.id ||
		r.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
		event?.id ||
		null
	);
}

/**
 * Find our invoice+subscription by reference or payer email
 */
async function findSubscriptionByRef(customId, payerEmail) {
	// Try by reference first
	if (customId) {
		const invoice = await prisma.invoice.findFirst({
			where: { reference: customId },
			select: {
				id: true, userId: true, status: true,
				periodStart: true, periodEnd: true,
				total: true, currency: true,
				items: { select: { subscriptionId: true }, take: 1 },
			},
		});
		if (invoice) return invoice;
	}

	// Fallback: find by payer email → most recent PENDING subscription
	if (payerEmail) {
		const user = await prisma.user.findFirst({
			where: { email: payerEmail.toLowerCase() },
			select: { id: true },
		});
		if (user) {
			const sub = await prisma.userSubscription.findFirst({
				where: { userId: user.id, status: "PENDING" },
				orderBy: { createdAt: "desc" },
				select: { reference: true },
			});
			if (sub?.reference) {
				return prisma.invoice.findFirst({
					where: { reference: sub.reference },
					select: {
						id: true, userId: true, status: true,
						periodStart: true, periodEnd: true,
						total: true, currency: true,
						items: { select: { subscriptionId: true }, take: 1 },
					},
				});
			}
		}
	}

	return null;
}

const paypalWebhook = async (req, res) => {
	try {
		const event = req.body;
		const eventType = event?.event_type || "";
		const resource = event?.resource || {};

		console.log(`[PayPal] Webhook: ${eventType}`);

		const customId = extractReference(event);
		const paypalTxnId = extractPayPalId(event);
		const payerEmail = resource?.payer?.email_address || resource?.subscriber?.email_address || null;
		const amount = resource?.amount?.value || resource?.purchase_units?.[0]?.amount?.value || resource?.gross_amount?.value || null;

		const webhookLog = {
			at: new Date().toISOString(),
			type: "PAYPAL_WEBHOOK",
			eventType,
			eventId: event?.id,
			paypalTxnId,
			customId,
			amount,
			payerEmail,
		};

		// Determine event category
		const SUCCESS_EVENTS = [
			"CHECKOUT.ORDER.APPROVED",
			"CHECKOUT.ORDER.COMPLETED",
			"PAYMENT.CAPTURE.COMPLETED",
			"BILLING.SUBSCRIPTION.ACTIVATED",
			"PAYMENT.SALE.COMPLETED",
		];
		const FAILURE_EVENTS = [
			"PAYMENT.CAPTURE.DENIED",
			"PAYMENT.CAPTURE.REFUNDED",
			"BILLING.SUBSCRIPTION.CANCELLED",
			"BILLING.SUBSCRIPTION.EXPIRED",
		];

		const isSuccess = SUCCESS_EVENTS.includes(eventType);
		const isFailure = FAILURE_EVENTS.includes(eventType);

		if (!isSuccess && !isFailure) {
			console.log(`[PayPal] Info event ${eventType} - ack`);
			return res.status(200).json({ status: "OK" });
		}

		// For CHECKOUT.ORDER.APPROVED, capture the payment first
		if (eventType === "CHECKOUT.ORDER.APPROVED" && resource?.id) {
			try {
				console.log(`[PayPal] Capturing order ${resource.id}...`);
				await capturePayPalOrder(resource.id);
				console.log(`[PayPal] Order ${resource.id} captured`);
			} catch (err) {
				console.error(`[PayPal] Capture failed: ${err.message}`);
				// Don't fail - the PAYMENT.CAPTURE.COMPLETED event will follow
			}
		}

		// Find matching subscription
		const invoice = await findSubscriptionByRef(customId, payerEmail);

		if (!invoice) {
			console.log(`[PayPal] No match: customId=${customId}, email=${payerEmail}`);
			return res.status(200).json({ status: "OK", message: "No matching subscription" });
		}

		const subscriptionId = invoice.items?.[0]?.subscriptionId;
		if (!subscriptionId) {
			console.log(`[PayPal] Invoice ${invoice.id} has no subscription link`);
			return res.status(200).json({ status: "OK" });
		}

		// Find payment record
		let payment = await prisma.subscriptionPayment.findFirst({
			where: { subscriptionId, invoiceId: invoice.id },
			orderBy: { createdAt: "desc" },
			select: { id: true, status: true },
		});

		// Idempotency
		if (payment?.status === "SUCCESS" && invoice.status === "PAID") {
			console.log(`[PayPal] Already processed`);
			return res.status(200).json({ status: "OK", message: "Already processed" });
		}

		// Process
		await prisma.$transaction(async (tx) => {
			if (isSuccess) {
				if (payment) {
					await tx.subscriptionPayment.update({
						where: { id: payment.id },
						data: { status: "SUCCESS", gateway: "PAYPAL", gatewayRef: paypalTxnId, paidAt: new Date(), gatewayLogs: { push: webhookLog } },
					});
				} else {
					await tx.subscriptionPayment.create({
						data: { subscriptionId, invoiceId: invoice.id, amount: invoice.total, currency: invoice.currency || "USD", status: "SUCCESS", gateway: "PAYPAL", gatewayRef: paypalTxnId, paidAt: new Date(), gatewayLogs: [webhookLog] },
					});
				}

				await tx.invoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAt: new Date() } });

				const now = new Date();
				await tx.userSubscription.updateMany({ where: { userId: invoice.userId, status: "ACTIVE" }, data: { status: "EXPIRED", expiresAt: now } });
				await tx.userSubscription.update({
					where: { id: subscriptionId },
					data: { status: "ACTIVE", startedAt: invoice.periodStart || now, expiresAt: invoice.periodEnd || addInterval(now, "MONTH"), canceledAt: null },
				});

				console.log(`[PayPal] SUCCESS: sub ${subscriptionId} activated for user ${invoice.userId}`);
			} else {
				if (payment) {
					await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { status: "FAILED", gateway: "PAYPAL", gatewayRef: paypalTxnId, gatewayLogs: { push: webhookLog } } });
				}
				await tx.invoice.update({ where: { id: invoice.id }, data: { status: "VOID" } });
				await tx.userSubscription.update({ where: { id: subscriptionId }, data: { status: "FAILED", canceledAt: new Date() } });
				console.log(`[PayPal] FAILED: sub ${subscriptionId}`);
			}
		});

		return res.status(200).json({ status: "OK", message: isSuccess ? "Activated" : "Failed" });
	} catch (error) {
		console.error("[PayPal] Webhook error:", error.message);
		return res.status(200).json({ status: "ERROR", message: error.message });
	}
};

module.exports = { paypalWebhook };
