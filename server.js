require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4242;
const APP_FEE_PERCENT = parseFloat(process.env.APP_FEE_PERCENT || "0.5"); // Your cut: 0.5% default

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "POSUniversal Backend", connect: true });
});

// ============================================
// STRIPE CONNECT - Vendor Onboarding
// ============================================

// Create a Connect Express account for a new vendor
app.post("/connect/create-account", async (req, res) => {
  try {
    const { email, business_name } = req.body;

    const account = await stripe.accounts.create({
      type: "express",
      country: "CA",
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        name: business_name || undefined,
        mcc: "5411", // Grocery stores
      },
    });

    res.json({ account_id: account.id });
  } catch (error) {
    console.error("Create account error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Generate onboarding link for vendor to complete Stripe setup
app.post("/connect/onboarding-link", async (req, res) => {
  try {
    const { account_id } = req.body;
    if (!account_id) {
      return res.status(400).json({ error: "account_id is required" });
    }

    const accountLink = await stripe.accountLinks.create({
      account: account_id,
      refresh_url: `${process.env.BACKEND_URL || req.protocol + "://" + req.get("host")}/connect/refresh?account_id=${account_id}`,
      return_url: `${process.env.BACKEND_URL || req.protocol + "://" + req.get("host")}/connect/complete?account_id=${account_id}`,
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url });
  } catch (error) {
    console.error("Onboarding link error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Check if vendor's Connect account is fully set up
app.post("/connect/account-status", async (req, res) => {
  try {
    const { account_id } = req.body;
    if (!account_id) {
      return res.status(400).json({ error: "account_id is required" });
    }

    const account = await stripe.accounts.retrieve(account_id);

    res.json({
      account_id: account.id,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      business_name: account.business_profile?.name || "",
      email: account.email,
    });
  } catch (error) {
    console.error("Account status error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Onboarding complete redirect (shown in browser)
app.get("/connect/complete", (req, res) => {
  res.send(`
    <html>
      <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family: -apple-system, sans-serif; text-align: center; padding: 60px 20px;">
        <h1 style="color: #22c55e;">✓ Setup Complete</h1>
        <p>Your Stripe account is connected to POSUniversal.</p>
        <p style="color: #666;">You can close this page and return to the app.</p>
      </body>
    </html>
  `);
});

// Onboarding refresh (re-generate link)
app.get("/connect/refresh", async (req, res) => {
  try {
    const { account_id } = req.query;
    const accountLink = await stripe.accountLinks.create({
      account: account_id,
      refresh_url: `${process.env.BACKEND_URL || req.protocol + "://" + req.get("host")}/connect/refresh?account_id=${account_id}`,
      return_url: `${process.env.BACKEND_URL || req.protocol + "://" + req.get("host")}/connect/complete?account_id=${account_id}`,
      type: "account_onboarding",
    });
    res.redirect(accountLink.url);
  } catch (error) {
    res.status(500).send("Error refreshing onboarding link.");
  }
});

// Vendor dashboard link (for vendor to see their payouts)
app.post("/connect/dashboard-link", async (req, res) => {
  try {
    const { account_id } = req.body;
    const loginLink = await stripe.accounts.createLoginLink(account_id);
    res.json({ url: loginLink.url });
  } catch (error) {
    console.error("Dashboard link error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STRIPE TERMINAL
// ============================================

// Connection token - works with or without Connect
app.post("/connection-token", async (req, res) => {
  try {
    const { location_id, connected_account_id } = req.body || {};
    const params = {};
    if (location_id) params.location = location_id;

    let token;
    if (connected_account_id) {
      // Create token on behalf of connected account
      token = await stripe.terminal.connectionTokens.create(params, {
        stripeAccount: connected_account_id,
      });
    } else {
      token = await stripe.terminal.connectionTokens.create(params);
    }
    res.json({ secret: token.secret });
  } catch (error) {
    console.error("Connection token error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// List Terminal locations
app.get("/locations", async (req, res) => {
  try {
    const locations = await stripe.terminal.locations.list({ limit: 100 });
    res.json(locations.data);
  } catch (error) {
    console.error("Locations error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Create or update a Terminal location
app.post("/location", async (req, res) => {
  try {
    const { display_name, location_id } = req.body;
    if (!display_name) {
      return res.status(400).json({ error: "display_name is required" });
    }

    if (location_id) {
      const location = await stripe.terminal.locations.update(location_id, {
        display_name,
      });
      return res.json({ id: location.id, display_name: location.display_name });
    }

    const location = await stripe.terminal.locations.create({
      display_name,
      address: {
        line1: "Kamloops, BC",
        city: "Kamloops",
        state: "BC",
        postal_code: "V2C 1A1",
        country: "CA",
      },
    });
    res.json({ id: location.id, display_name: location.display_name });
  } catch (error) {
    console.error("Location error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PAYMENTS - With Connect support
// ============================================

// Create PaymentIntent - routes money to vendor via Connect
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency = "cad", description = "", connected_account_id } = req.body;

    if (!amount || amount < 50) {
      return res.status(400).json({ error: "Amount must be at least 50 cents" });
    }

    const params = {
      amount: Math.round(amount),
      currency,
      description,
      payment_method_types: ["card_present", "interac_present"],
      capture_method: "automatic",
      metadata: {
        source: "POSUniversal",
        project: "Hannibal",
      },
    };

    // If vendor has a connected account, use destination charge
    // Money goes to vendor, platform takes APP_FEE_PERCENT
    if (connected_account_id) {
      const appFee = Math.round(amount * (APP_FEE_PERCENT / 100));
      params.application_fee_amount = appFee;
      params.transfer_data = {
        destination: connected_account_id,
      };
    }

    const paymentIntent = await stripe.paymentIntents.create(params);

    res.json({
      id: paymentIntent.id,
      client_secret: paymentIntent.client_secret,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
    });
  } catch (error) {
    console.error("PaymentIntent error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Capture a PaymentIntent
app.post("/capture-payment-intent", async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const intent = await stripe.paymentIntents.capture(payment_intent_id);
    res.json({ id: intent.id, status: intent.status });
  } catch (error) {
    console.error("Capture error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Refund a payment
app.post("/refund", async (req, res) => {
  try {
    const { payment_intent_id, amount } = req.body;
    const refundParams = { payment_intent: payment_intent_id };
    if (amount) refundParams.amount = Math.round(amount);

    const refund = await stripe.refunds.create(refundParams);
    res.json({ id: refund.id, status: refund.status, amount: refund.amount });
  } catch (error) {
    console.error("Refund error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`POSUniversal backend running on port ${PORT}`);
  console.log(`Platform fee: ${APP_FEE_PERCENT}%`);
});
