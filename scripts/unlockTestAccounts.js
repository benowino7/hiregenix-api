/**
 * Unlock test accounts as Platinum subscribers.
 * Run inside the API container: node scripts/unlockTestAccounts.js
 */
const { prisma } = require("../prisma");

const TEST_EMAILS = [
	"bensonowino7@gmail.com",       // Job Seeker → Platinum JOB_SEEKER plan
	"contechkenya7@gmail.com",      // Recruiter → Platinum RECRUITER plan
];

async function unlockAccounts() {
	const now = new Date();
	const expiresAt = new Date(now);
	expiresAt.setDate(expiresAt.getDate() + 365); // 1 year from now

	for (const email of TEST_EMAILS) {
		const user = await prisma.user.findUnique({
			where: { email },
			select: {
				id: true,
				email: true,
				roles: { select: { role: true } },
			},
		});

		if (!user) {
			console.log(`User not found: ${email}`);
			continue;
		}

		const roles = user.roles.map((r) => r.role);
		console.log(`Found user: ${email} (id: ${user.id}, roles: ${roles.join(", ")})`);

		// Determine userType for plan lookup
		const userType = roles.includes("RECRUITER") ? "RECRUITER" : "JOB_SEEKER";

		// Find the Platinum plan
		const platinumPlan = await prisma.subscriptionPlan.findFirst({
			where: { name: "Platinum", userType, isActive: true },
			select: { id: true, name: true, userType: true, amount: true },
		});

		if (!platinumPlan) {
			console.log(`  Platinum plan not found for userType: ${userType}`);
			continue;
		}

		console.log(`  Platinum plan: ${platinumPlan.name} (${platinumPlan.userType}, $${platinumPlan.amount / 100}/mo)`);

		// Expire all existing active subscriptions
		const expired = await prisma.userSubscription.updateMany({
			where: {
				userId: user.id,
				status: "ACTIVE",
			},
			data: {
				status: "EXPIRED",
				expiresAt: now,
			},
		});
		console.log(`  Expired ${expired.count} existing active subscriptions`);

		// Create new Platinum subscription
		const subscription = await prisma.userSubscription.create({
			data: {
				userId: user.id,
				planId: platinumPlan.id,
				status: "ACTIVE",
				startedAt: now,
				expiresAt,
				reference: `test_platinum_${user.id}_${Date.now()}`,
			},
		});

		console.log(`  Created Platinum subscription: ${subscription.id}`);
		console.log(`  Active until: ${expiresAt.toISOString()}`);
		console.log("");
	}

	console.log("Done!");
}

unlockAccounts()
	.catch((err) => {
		console.error("Error:", err);
		process.exit(1);
	})
	.finally(() => prisma.$disconnect());
