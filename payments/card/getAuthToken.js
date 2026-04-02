let access_token = null;
let tokenExpiry = null;

/**
 * Generate Basic Auth header
 */
const getBasicAuthHeader = () => {
	if (!process.env.EXT_API_USERNAME || !process.env.EXT_API_PASSWORD) {
		throw new Error("Payment gateway credentials not configured. Set EXT_API_USERNAME and EXT_API_PASSWORD environment variables.");
	}
	const credentials = `${process.env.EXT_API_USERNAME}:${process.env.EXT_API_PASSWORD}`;
	return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

/**
 * Authenticate with gateway — always fetches a fresh token
 */
const authenticate = async () => {
	try {
		if (!process.env.EXT_API_BASE_URL) {
			throw new Error("Payment gateway not configured. Set EXT_API_BASE_URL environment variable.");
		}

		const response = await fetch(`${process.env.EXT_API_BASE_URL}/auth/`, {
			method: "GET",
			headers: {
				"Content-Type": "application/json",
				Authorization: getBasicAuthHeader(),
			},
		});

		// handle non-2xx responses
		if (!response.ok) {
			const errorData = await response.text(); // safer than json if unknown format
			console.error("[PAYMENT AUTH] Status:", response.status);
			console.error("[PAYMENT AUTH] Data:", errorData);
			throw new Error(`Gateway authentication failed (HTTP ${response.status})`);
		}

		const data = await response.json();

		if (!data?.accessToken) {
			throw new Error("Invalid auth response from gateway — no accessToken");
		}

		const { accessToken, expires, expiresDate } = data;

		access_token = accessToken;
		tokenExpiry = Date.now() + expires * 1000 - 60_000; // 1 min buffer

		console.log("[PAYMENT AUTH] Token acquired, expires:", expiresDate);

		return access_token;
	} catch (error) {
		console.error("[PAYMENT AUTH] Authentication failed:", error.message);
		// Clear cached token on failure so next call forces a fresh attempt
		access_token = null;
		tokenExpiry = null;
		throw new Error(`Gateway authentication failed: ${error.message}`);
	}
};

/**
 * Get valid token — checks cache first, re-authenticates if expired
 */
const getValidToken = async () => {
	if (access_token && tokenExpiry && Date.now() < tokenExpiry) {
		return access_token;
	}

	return authenticate();
};

/**
 * Force a fresh token — always calls the gateway, ignores cache.
 * Used when a payment request fails with an invalid token.
 */
const getFreshToken = async () => {
	access_token = null;
	tokenExpiry = null;
	return authenticate();
};

module.exports = { getValidToken, getFreshToken };
