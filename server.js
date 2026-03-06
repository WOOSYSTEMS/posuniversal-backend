require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4242;

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "POSUniversal Backend" });
});

// Stripe Terminal connection token
// The iOS app calls this endpoint to get a token for connecting to the Stripe Terminal reader
app.post("/connection-token", async (req, res) => {
  try {
    const token = await stripe.terminal.connectionTokens.create();
    res.json({ secret: token.secret });
  } catch (error) {
    console.error("Connection token error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Create a PaymentIntent for Tap to Pay
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency = "cad", description = "" } = req.body;

    if (!amount || amount < 50) {
      return res.status(400).json({ error: "Amount must be at least 50 cents" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // amount in cents
      currency,
      description,
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      metadata: {
        source: "POSUniversal",
        project: "Hannibal",
      },
    });

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

// Capture a PaymentIntent (if using manual capture)
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

app.listen(PORT, () => {
  console.log(`POSUniversal backend running on port ${PORT}`);
});
