import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Stripe } from "stripe";
import { randomUUID } from "crypto";
import { Sequelize, DataTypes } from "sequelize";

dotenv.config();

const app = express();
// @ts-ignore
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * =========================
 * CORS CONFIG
 * =========================
 */

const allowedOrigins = ["http://localhost:4200", process.env.CLIENT_URL].filter(
  Boolean,
);

const corsOptions = {
  origin: function (origin, callback) {
    console.log("REQUEST ORIGIN:", origin);

    // Permitir requests sin origin (Postman, server-to-server, etc.)
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log("BLOCKED ORIGIN:", origin);

    // NO lanzar Error porque genera 500
    return callback(null, false);
  },

  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],

  allowedHeaders: ["Content-Type", "Authorization"],

  credentials: true,
};

app.use(cors(corsOptions));

// IMPORTANTE PARA PREFLIGHT
app.options(/.*/, cors(corsOptions));

app.use(express.json());

const sequelize = process.env.DATABASE_URL
  ? new Sequelize(process.env.DATABASE_URL, {
      dialect: "postgres",
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      },
      logging: console.log,
    })
  : new Sequelize("sqlite::memory:", {
      logging: console.log,
    });

const Payment = sequelize.define(
  "payment",
  {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      defaultValue: () => randomUUID(),
    },

    userId: {
      type: DataTypes.STRING(36),
      allowNull: false,
      field: "user_id",
    },

    amount: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: "pen",
    },

    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },

    stripePaymentIntentId: {
      type: DataTypes.STRING(255),
      field: "stripe_payment_intent_id",
    },

    description: {
      type: DataTypes.TEXT,
    },
  },
  {
    timestamps: true,
    underscored: true,
  },
);

/**
 * =========================
 * INIT DATABASE
 * =========================
 */

(async () => {
  try {
    await sequelize.authenticate();

    console.log("Database connected successfully");

    await sequelize.sync();

    console.log("Database synchronized");
  } catch (error) {
    console.error("Database connection error:", error);
  }
})();

/**
 * =========================
 * ROUTES
 * =========================
 */

app.get("/", (req, res) => {
  res.send("API de Pagos Activa");
});

/**
 * CREATE PAYMENT INTENT
 */

app.post("/api/payments/create-intent", async (req, res) => {
  try {
    const { userId, amount, currency = "pen", description } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({
        error: "userId and amount are required",
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency,
      description,
      metadata: {
        userId,
      },
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
    });
  } catch (error) {
    console.error("CREATE INTENT ERROR:", error);

    return res.status(500).json({
      error: error.message,
    });
  }
});

/**
 * CONFIRM PAYMENT
 */

app.post("/api/payments/confirm", async (req, res) => {
  try {
    const { paymentIntentId, userId } = req.body;

    if (!paymentIntentId || !userId) {
      return res.status(400).json({
        error: "paymentIntentId and userId are required",
      });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({
        error: "El pago no se ha completado exitosamente.",
      });
    }

    const existingPayment = await Payment.findOne({
      where: {
        stripePaymentIntentId: paymentIntentId,
      },
    });

    if (existingPayment) {
      return res.json(existingPayment);
    }

    const payment = await Payment.create({
      userId,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: "SUCCEEDED",
      stripePaymentIntentId: paymentIntent.id,
      description: paymentIntent.description,
    });

    return res.json(payment);
  } catch (error) {
    console.error("CONFIRM PAYMENT ERROR:", error);

    return res.status(500).json({
      error: error.message,
    });
  }
});

/**
 * PAYMENT HISTORY
 */

app.get("/api/payments/history/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const payments = await Payment.findAll({
      where: {
        userId,
      },
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      payments,
    });
  } catch (error) {
    console.error("PAYMENT HISTORY ERROR:", error);

    return res.status(500).json({
      error: error.message,
    });
  }
});

/**
 * GET PAYMENT
 */

app.get("/api/payments/:paymentId", async (req, res) => {
  try {
    const { paymentId } = req.params;

    const payment = await Payment.findByPk(paymentId);

    if (!payment) {
      return res.status(404).json({
        error: "Payment not found",
      });
    }

    return res.json(payment);
  } catch (error) {
    console.error("GET PAYMENT ERROR:", error);

    return res.status(500).json({
      error: error.message,
    });
  }
});

/**
 * STRIPE CHECKOUT SESSION
 */

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Invalid amount",
      });
    }

    const frontendUrl = process.env.CLIENT_URL || "http://localhost:4200";

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "pen",
            product_data: {
              name: "Custom Payment",
            },
            unit_amount: Math.round(amount),
          },
          quantity: 1,
        },
      ],

      mode: "payment",

      success_url: `${frontendUrl}/success.html`,
      cancel_url: `${frontendUrl}/cancel.html`,
    });

    return res.json({
      url: session.url,
    });
  } catch (error) {
    console.error("CHECKOUT SESSION ERROR:", error);

    return res.status(500).json({
      error: error.message,
    });
  }
});

/**
 * =========================
 * ERROR HANDLER
 * =========================
 */

app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);

  return res.status(500).json({
    error: err.message || "Internal server error",
  });
});

/**
 * =========================
 * SERVER
 * =========================
 */

export default app;
