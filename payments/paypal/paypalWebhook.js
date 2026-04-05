/**
 * PayPal Webhook Handler
 *
 * Handles both one-time orders and recurring subscription payments.
 * For installment plans: extends subscription by 1 month per payment.
 * For one-time plans: activates for the full plan duration.
 *
 * Webhook URL: https://api.hiregenix.ai/api/v1/public/paypal/webhook
 *
 * Events to subscribe to:
 *   - CHECKOUT.ORDER.APPROVED (one-time)
 *   - PAYMENT.CAPTURE.COMPLETED (one-time capture)
 *   - PAYMENT.CAPTURE.DENIED
 *   - PAYMENT.CAPTURE.REFUNDED
 *   - BILLING.SUBSCRIPTION.ACTIVATED (first recurring payment)
 *   - BILLING.SUBSCRIPTION.CANCELLED
 *   - BILLING.SUBSCRIPTION.SUSPENDED
 *   - BILLING.SUBSCRIPTION.EXPIRED
 *   - PAYMENT.SALE.COMPLETED (recurring installment received)
 *   - PAYMENT.SALE.DENIED
 */

const { prisma } = require("../../prisma");
const { capturePayPalOrder } = require("./paypalClient");

const addMonths = (date, months) => {
	const d = new Date(date);
	d.setMonth(d.getMonth() + months);
	return d;
};

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

function extractReference(event) {
	const r = event?.resource || {};
	return r.custom_id || r.purchase_units?.[0]?.custom_id || r.custom || null;
}

function extractPayPalId(event) {
	const r = event?.resource || {};
	return r.id || r.purchase_units?.[0]?.payments?.captures?.[0]?.id || event?.id || null;
}

function extractPayPalSubscriptionId(event) {
	const r = event?.resource || {};
	// For PAYMENT.SALE.COMPLETED on recurring, billing_agreement_id = PayPal subscription ID
	return r.billing_agreement_id || r.id || null;
}

/**
 * Find our subscription by PayPal subscription ID (for recurring payments)
 */
async function findByPayPalSubscriptionId(paypalSubId) {
	if (!paypalSubId) return null;

	// Search installmentMeta JSON for the PayPal subscription ID
	const subs = await prisma.userSubscription.findMany({
		where: { status: "ACTIVE", installmentMeta: { not: null } },
		select: { id: true, userId: true, reference: true, installmentMeta: true, expiresAt: true, planId: true },
	});

	for (const sub of subs) {
		const meta = sub.installmentMeta;
		if (meta && meta.paypalSubscriptionId === paypalSubId) {
			return sub;
		}
	}

	// Also check PENDING subs (for first activation)
	const pendingSubs = await prisma.userSubscription.findMany({
		where: { status: "PENDING", installmentMeta: { not: null } },
		select: { id: true, userId: true, reference: true, installmentMeta: true, expiresAt: true, planId: true },
	});

	for (const sub of pendingSubs) {
		const meta = sub.installmentMeta;
		if (meta && meta.paypalSubscriptionId === paypalSubId) {
			return sub;
		}
	}

	return null;
}

/**
 * Find invoice by reference or payer email
 */
async function findInvoiceByRef(customId, payerEmail) {
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
		const paypalSubId = extractPayPalSubscriptionId(event);
		const payerEmail = resource?.payer?.email_address || resource?.subscriber?.email_address || null;
		const amount = resource?.amount?.value || resource?.purchase_units?.[0]?.amount?.value || resource?.gross_amount?.value || null;

		const webhookLog = {
			at: new Date().toISOString(),
			type: "PAYPAL_WEBHOOK",
			eventType,
			eventId: event?.id,
			paypalTxnId,
			paypalSubId,
			customId,
			amount,
			payerEmail,
		};

		// ─── RECURRING INSTALLMENT PAYMENT ──────────────────────────────
		if (eventType === "PAYMENT.SALE.COMPLETED" && paypalSubId) {
			console.log(`[PayPal] Recurring payment: sub=${paypalSubId}, amount=${amount}`);

			const sub = await findByPayPalSubscriptionId(paypalSubId);
			if (!sub) {
				console.log(`[PayPal] No matching installment subscription for PayPal sub ${paypalSubId}`);
				return res.status(200).json({ status: "OK", message: "No matching subscription" });
			}

			const meta = sub.installmentMeta || {};
			const paidSoFar = (meta.paidInstallments || 0) + 1;
			const now = new Date();

			// Extend subscription by 1 month from current expiry (or now if expired)
			const currentExpiry = sub.expiresAt && new Date(sub.expiresAt) > now ? new Date(sub.expiresAt) : now;
			const newExpiry = addMonths(currentExpiry, 1);

			await prisma.$transaction(async (tx) => {
				// Update subscription: extend expiry, increment installment count
				await tx.userSubscription.update({
					where: { id: sub.id },
					data: {
						status: "ACTIVE",
						startedAt: sub.status === "PENDING" ? now : undefined,
						expiresAt: newExpiry,
						installmentMeta: {
							...meta,
							paidInstallments: paidSoFar,
							lastPaymentAt: now.toISOString(),
							lastPaypalTxnId: paypalTxnId,
						},
					},
				});

				// Create a payment record for this installment
				// Find the original invoice to link
				const invoice = sub.reference ? await tx.invoice.findFirst({ where: { reference: sub.reference }, select: { id: true } }) : null;

				await tx.subscriptionPayment.create({
					data: {
						subscriptionId: sub.id,
						invoiceId: invoice?.id || null,
						amount: Math.round((parseFloat(amount) || 0) * 100),
						currency: "USD",
						status: "SUCCESS",
						gateway: "PAYPAL",
						gatewayRef: paypalTxnId,
						paidAt: now,
						gatewayLogs: [{ ...webhookLog, installment: paidSoFar, newExpiry: newExpiry.toISOString() }],
					},
				});

				// Mark original invoice as PAID if still OPEN (first payment)
				if (invoice && paidSoFar === 1) {
					await tx.invoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAt: now } });
					// Expire previous active subscriptions
					await tx.userSubscription.updateMany({
						where: { userId: sub.userId, status: "ACTIVE", id: { not: sub.id } },
						data: { status: "EXPIRED", expiresAt: now },
					});
				}
			});

			console.log(`[PayPal] Installment ${paidSoFar}/12 processed. Expires: ${newExpiry.toISOString()}`);
			return res.status(200).json({ status: "OK", message: `Installment ${paidSoFar} processed`, newExpiry });
		}

		// ─── RECURRING SUBSCRIPTION ACTIVATED (first payment) ───────────
		if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED" && (paypalSubId || customId)) {
			console.log(`[PayPal] Subscription activated: ${paypalSubId}`);
			// The PAYMENT.SALE.COMPLETED event will handle the actual activation
			// Just acknowledge here
			return res.status(200).json({ status: "OK", message: "Subscription activated - awaiting first payment" });
		}

		// ─── RECURRING SUBSCRIPTION CANCELLED/SUSPENDED/EXPIRED ─────────
		if (["BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.SUSPENDED", "BILLING.SUBSCRIPTION.EXPIRED"].includes(eventType)) {
			console.log(`[PayPal] Subscription ${eventType}: ${paypalSubId}`);

			const sub = await findByPayPalSubscriptionId(paypalSubId);
			if (sub) {
				const meta = sub.installmentMeta || {};
				await prisma.userSubscription.update({
					where: { id: sub.id },
					data: {
						installmentMeta: {
							...meta,
							cancelledAt: new Date().toISOString(),
							cancelReason: eventType,
						},
					},
				});
				// Don't immediately expire - let current month run out naturally via expiresAt
				console.log(`[PayPal] Marked subscription ${sub.id} as cancelled. Will expire at ${sub.expiresAt}`);
			}
			return res.status(200).json({ status: "OK", message: "Cancellation recorded" });
		}

		// ─── PAYMENT.SALE.DENIED (recurring payment failed) ────────────
		if (eventType === "PAYMENT.SALE.DENIED" && paypalSubId) {
			console.log(`[PayPal] Recurring payment denied: ${paypalSubId}`);
			const sub = await findByPayPalSubscriptionId(paypalSubId);
			if (sub) {
				const meta = sub.installmentMeta || {};
				await prisma.userSubscription.update({
					where: { id: sub.id },
					data: {
						installmentMeta: {
							...meta,
							lastFailedAt: new Date().toISOString(),
							lastFailReason: "PAYMENT_DENIED",
						},
					},
				});
			}
			return res.status(200).json({ status: "OK", message: "Payment denial recorded" });
		}

		// ─── ONE-TIME ORDER EVENTS ─────────────────────────────────────
		const SUCCESS_EVENTS = ["CHECKOUT.ORDER.APPROVED", "CHECKOUT.ORDER.COMPLETED", "PAYMENT.CAPTURE.COMPLETED"];
		const FAILURE_EVENTS = ["PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED"];

		const isSuccess = SUCCESS_EVENTS.includes(eventType);
		const isFailure = FAILURE_EVENTS.includes(eventType);

		if (!isSuccess && !isFailure) {
			console.log(`[PayPal] Info event ${eventType} - ack`);
			return res.status(200).json({ status: "OK" });
		}

		// Capture order if approved
		if (eventType === "CHECKOUT.ORDER.APPROVED" && resource?.id) {
			try {
				await capturePayPalOrder(resource.id);
				console.log(`[PayPal] Order ${resource.id} captured`);
			} catch (err) {
				console.error(`[PayPal] Capture failed: ${err.message}`);
			}
		}

		const invoice = await findInvoiceByRef(customId, payerEmail);
		if (!invoice) {
			console.log(`[PayPal] No match for one-time: customId=${customId}`);
			return res.status(200).json({ status: "OK", message: "No matching subscription" });
		}

		const subscriptionId = invoice.items?.[0]?.subscriptionId;
		if (!subscriptionId) {
			return res.status(200).json({ status: "OK" });
		}

		let payment = await prisma.subscriptionPayment.findFirst({
			where: { subscriptionId, invoiceId: invoice.id },
			orderBy: { createdAt: "desc" },
			select: { id: true, status: true },
		});

		if (payment?.status === "SUCCESS" && invoice.status === "PAID") {
			return res.status(200).json({ status: "OK", message: "Already processed" });
		}

		// Check if this is actually an installment subscription's first payment
		const sub = await prisma.userSubscription.findUnique({
			where: { id: subscriptionId },
			select: { installmentMeta: true },
		});

		const isInstallment = sub?.installmentMeta?.type === "INSTALLMENT";

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

				// For installment plans, first payment activates for 1 month
				// For one-time, activates for full period
				const expiresAt = isInstallment
					? addMonths(now, 1)
					: (invoice.periodEnd || addInterval(now, "MONTH"));

				await tx.userSubscription.update({
					where: { id: subscriptionId },
					data: {
						status: "ACTIVE",
						startedAt: invoice.periodStart || now,
						expiresAt,
						canceledAt: null,
						...(isInstallment ? {
							installmentMeta: {
								...(sub.installmentMeta || {}),
								paidInstallments: 1,
								lastPaymentAt: now.toISOString(),
							},
						} : {}),
					},
				});

				console.log(`[PayPal] SUCCESS: sub ${subscriptionId} activated, expires ${expiresAt.toISOString()}, installment=${isInstallment}`);
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
