// wiseFx.js
// Node 18+ (native fetch)

class WiseFx {
	constructor({ env = "production", token } = {}) {
		this.baseURL = env === "sandbox" ? "https://api.wise-sandbox.com" : "https://api.wise.com";

		this.token = token;
	}

	async request(path, { method = "GET", body, headers = {} } = {}) {
		const res = await fetch(`${this.baseURL}${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				...(this.token && { Authorization: `Bearer ${this.token}` }),
				...headers,
			},
			body: body ? JSON.stringify(body) : undefined,
		});

		const data = await res.json().catch(() => ({}));

		if (!res.ok) {
			throw new Error(`Wise API Error (${res.status}): ${JSON.stringify(data)}`);
		}

		return data;
	}

	/**
	 * Get mid-market rate for any currency pair
	 */
	async getRate(sourceCurrency, targetCurrency) {
		if (!sourceCurrency || !targetCurrency) {
			throw new Error("Both sourceCurrency and targetCurrency are required");
		}

		const data = await this.request(`/v1/rates?source=${sourceCurrency}&target=${targetCurrency}`);

		if (!Array.isArray(data) || !data[0]?.rate) {
			throw new Error("Invalid rate response from Wise");
		}

		return {
			source: sourceCurrency,
			target: targetCurrency,
			rate: data[0].rate,
			time: data[0].time,
		};
	}

	/**
	 * Convert any currency pair using mid-market rate
	 */
	async convert({ amount, sourceCurrency, targetCurrency }) {
		if (typeof amount !== "number" || amount <= 0) {
			throw new Error("Amount must be a positive number");
		}

		const { rate } = await this.getRate(sourceCurrency, targetCurrency);

		return {
			source: sourceCurrency,
			target: targetCurrency,
			amount,
			rate,
			convertedAmount: Number((amount * rate).toFixed(2)),
		};
	}

	/**
	 * Create Wise quote (fee-aware conversion)
	 * Provide either sourceAmount OR targetAmount
	 */
	async createQuote({ sourceCurrency, targetCurrency, sourceAmount, targetAmount }) {
		if (!sourceCurrency || !targetCurrency) {
			throw new Error("sourceCurrency and targetCurrency are required");
		}

		if ((sourceAmount && targetAmount) || (!sourceAmount && !targetAmount)) {
			throw new Error("Provide either sourceAmount OR targetAmount (not both)");
		}

		return await this.request("/v3/quotes", {
			method: "POST",
			body: {
				sourceCurrency,
				targetCurrency,
				...(sourceAmount ? { sourceAmount } : {}),
				...(targetAmount ? { targetAmount } : {}),
			},
		});
	}
}

module.exports = WiseFx;
