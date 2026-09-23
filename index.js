require("dotenv").config();
const express = require("express");
const cors = require("cors");
const dns = require("dns");
const { MongoClient, ObjectId } = require("mongodb");

dns.setServers(["1.1.1.1", "8.8.8.8"]);

function serialize(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

function serializeArray(docs) {
  return docs.map(serialize);
}

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    const error = new Error("Invalid id format");
    error.status = 400;
    throw error;
  }
}

function getStockStatus(currentStock, minimumStock) {
  if (currentStock <= 0) return "out-of-stock";
  if (currentStock <= minimumStock) return "low-stock";
  return "in-stock";
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateStr(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthStr(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

const app = express();
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://profitbooks.vercel.app",
      process.env.CLIENT_URL || "",
    ].filter(Boolean),
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.send("ProfitBook API is running");
});

const client = new MongoClient(process.env.DB_URI);

async function run() {
  await client.connect();
  console.log("✅ Connected to MongoDB");

  const db = client.db("ProfitBook");
  const categories = db.collection("categories");
  const products = db.collection("products");
  const suppliers = db.collection("suppliers");
  const customers = db.collection("customers");
  const sales = db.collection("sales");
  const purchases = db.collection("purchases");
  const expenses = db.collection("expenses");
  const dues = db.collection("dues");
  const payments = db.collection("payments");
  const stockMovements = db.collection("stockMovements");
  const settings = db.collection("settings");

  async function recomputeCustomer(customerId) {
    const idStr = customerId.toString();
    const custSales = await sales.find({ customerId: idStr }).toArray();

    const totalPurchases = custSales.reduce((s, x) => s + (x.total || 0), 0);
    const totalPaid = custSales.reduce((s, x) => s + (x.paid || 0), 0);
    const totalDue = custSales.reduce((s, x) => s + (x.due || 0), 0);
    const lastPurchaseDate = custSales.length
      ? custSales.map((s) => s.date).sort().reverse()[0]
      : null;

    try {
      await customers.updateOne(
        { _id: toObjectId(idStr) },
        { $set: { totalPurchases, totalPaid, totalDue, lastPurchaseDate } }
      );
    } catch {
      // ignore
    }
  }

  async function adjustStock(items, direction, reference) {
    if (!items || !items.length) return;
    for (const item of items) {
      if (!item.productId) continue;
      let prodId;
      try {
        prodId = toObjectId(item.productId);
      } catch {
        continue;
      }
      const product = await products.findOne({ _id: prodId });
      if (!product) continue;

      const qty = Number(item.quantity || 0);
      const newStock = Math.max(
        0,
        (product.currentStock || 0) + direction * qty
      );
      const newStatus = getStockStatus(newStock, product.minimumStock || 0);

      await products.updateOne(
        { _id: prodId },
        { $set: { currentStock: newStock, status: newStatus } }
      );

      await stockMovements.insertOne({
        productId: prodId.toString(),
        productName: item.productName || product.name,
        type: direction > 0 ? "in" : "out",
        quantity: qty,
        previousStock: product.currentStock || 0,
        newStock,
        reference: reference || "",
        date: todayStr(),
        createdAt: new Date().toISOString(),
      });
    }
  }

  app.get("/api/categories", async (req, res) => {
    try {
      const docs = await categories.find({}).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/categories", async (req, res) => {
    try {
      const { name, color } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });

      const doc = {
        name,
        color: color || null,
        createdAt: new Date().toISOString(),
      };
      const result = await categories.insertOne(doc);
      res.status(201).json(serialize({ _id: result.insertedId, ...doc }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/categories/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const update = {};
      if (req.body.name !== undefined) update.name = req.body.name;
      if (req.body.color !== undefined) update.color = req.body.color;

      const result = await categories.findOneAndUpdate(
        { _id },
        { $set: update },
        { returnDocument: "after" }
      );
      if (!result) return res.status(404).json({ error: "Category not found" });
      res.json(serialize(result));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/categories/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const result = await categories.deleteOne({ _id });
      if (result.deletedCount === 0)
        return res.status(404).json({ error: "Category not found" });
      res.json({ success: true, id: req.params.id });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/products", async (req, res) => {
    try {
      const docs = await products.find({}).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/products/low-stock", async (req, res) => {
    try {
      const docs = await products
        .find({ $expr: { $lte: ["$currentStock", "$minimumStock"] } })
        .toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/products/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const doc = await products.findOne({ _id });
      if (!doc) return res.status(404).json({ error: "Product not found" });
      res.json(serialize(doc));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post("/api/products", async (req, res) => {
    try {
      const {
        name,
        sku,
        categoryId,
        unit,
        purchasePrice,
        sellingPrice,
        currentStock,
        minimumStock,
        supplierId,
        brand,
        description,
        imageUrl,
        createdAt,
      } = req.body;

      if (
        !name ||
        !sku ||
        !categoryId ||
        !unit ||
        purchasePrice === undefined ||
        sellingPrice === undefined ||
        currentStock === undefined ||
        minimumStock === undefined
      ) {
        return res
          .status(400)
          .json({ error: "Missing required product fields" });
      }

      const doc = {
        name,
        sku,
        categoryId: categoryId.toString(),
        unit,
        purchasePrice: Number(purchasePrice),
        sellingPrice: Number(sellingPrice),
        currentStock: Number(currentStock),
        minimumStock: Number(minimumStock),
        supplierId: supplierId ? supplierId.toString() : null,
        brand: brand || null,
        description: description || null,
        imageUrl: imageUrl || null,
        status: getStockStatus(Number(currentStock), Number(minimumStock)),
        createdAt: createdAt || new Date().toISOString(),
      };

      const result = await products.insertOne(doc);
      res.status(201).json(serialize({ _id: result.insertedId, ...doc }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/products/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const existing = await products.findOne({ _id });
      if (!existing)
        return res.status(404).json({ error: "Product not found" });

      const update = { ...req.body };
      delete update.id;
      delete update._id;

      if (update.categoryId !== undefined)
        update.categoryId = update.categoryId?.toString() ?? null;
      if (update.supplierId !== undefined)
        update.supplierId = update.supplierId?.toString() ?? null;
      if (update.purchasePrice !== undefined)
        update.purchasePrice = Number(update.purchasePrice);
      if (update.sellingPrice !== undefined)
        update.sellingPrice = Number(update.sellingPrice);
      if (update.currentStock !== undefined)
        update.currentStock = Number(update.currentStock);
      if (update.minimumStock !== undefined)
        update.minimumStock = Number(update.minimumStock);

      const nextCurrentStock =
        update.currentStock !== undefined
          ? update.currentStock
          : existing.currentStock;
      const nextMinimumStock =
        update.minimumStock !== undefined
          ? update.minimumStock
          : existing.minimumStock;

      if (
        update.currentStock !== undefined ||
        update.minimumStock !== undefined
      ) {
        update.status = getStockStatus(nextCurrentStock, nextMinimumStock);
      }

      const result = await products.findOneAndUpdate(
        { _id },
        { $set: update },
        { returnDocument: "after" }
      );
      res.json(serialize(result));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/products/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const result = await products.deleteOne({ _id });
      if (result.deletedCount === 0)
        return res.status(404).json({ error: "Product not found" });
      res.json({ success: true, id: req.params.id });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/suppliers", async (req, res) => {
    try {
      const docs = await suppliers.find({}).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/suppliers", async (req, res) => {
    try {
      const { name, phone, address, email, agentName, agentPhone } = req.body;
      if (!name || !phone)
        return res.status(400).json({ error: "name and phone are required" });

      const doc = {
        name,
        phone,
        address: address || null,
        email: email || null,
        agentName: agentName || null,
        agentPhone: agentPhone || null,
        createdAt: new Date().toISOString(),
      };
      const result = await suppliers.insertOne(doc);
      res.status(201).json(serialize({ _id: result.insertedId, ...doc }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/suppliers/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const update = { ...req.body };
      delete update.id;
      delete update._id;

      const result = await suppliers.findOneAndUpdate(
        { _id },
        { $set: update },
        { returnDocument: "after" }
      );
      if (!result) return res.status(404).json({ error: "Supplier not found" });
      res.json(serialize(result));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/suppliers/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const result = await suppliers.deleteOne({ _id });
      if (result.deletedCount === 0)
        return res.status(404).json({ error: "Supplier not found" });
      res.json({ success: true, id: req.params.id });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/customers", async (req, res) => {
    try {
      const docs = await customers.find({}).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/customers/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const doc = await customers.findOne({ _id });
      if (!doc) return res.status(404).json({ error: "Customer not found" });
      res.json(serialize(doc));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/customers/:id/history", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const customer = await customers.findOne({ _id });
      if (!customer)
        return res.status(404).json({ error: "Customer not found" });

      const idStr = req.params.id;
      const custPurchases = await sales.find({ customerId: idStr }).toArray();
      const custPayments = await payments.find({ customerId: idStr }).toArray();
      const custDues = await dues.find({ customerId: idStr }).toArray();

      res.json({
        customer: serialize(customer),
        purchases: serializeArray(custPurchases),
        payments: serializeArray(custPayments),
        dues: serializeArray(custDues),
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post("/api/customers", async (req, res) => {
    try {
      const { name, phone, address, email, notes } = req.body;
      if (!name || !phone)
        return res.status(400).json({ error: "name and phone are required" });

      const doc = {
        name,
        phone,
        address: address || null,
        email: email || null,
        notes: notes || null,
        totalPurchases: 0,
        totalPaid: 0,
        totalDue: 0,
        status: "active",
        createdAt: todayStr(),
      };
      const result = await customers.insertOne(doc);
      res.status(201).json(serialize({ _id: result.insertedId, ...doc }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/customers/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const update = { ...req.body };
      delete update.id;
      delete update._id;

      const result = await customers.findOneAndUpdate(
        { _id },
        { $set: update },
        { returnDocument: "after" }
      );
      if (!result) return res.status(404).json({ error: "Customer not found" });
      res.json(serialize(result));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/customers/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const result = await customers.deleteOne({ _id });
      if (result.deletedCount === 0)
        return res.status(404).json({ error: "Customer not found" });
      res.json({ success: true, id: req.params.id });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/sales", async (req, res) => {
    try {
      const docs = await sales.find({}).sort({ date: -1 }).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/sales/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const doc = await sales.findOne({ _id });
      if (!doc) return res.status(404).json({ error: "Sale not found" });
      res.json(serialize(doc));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post("/api/sales", async (req, res) => {
    try {
      const {
        invoiceNumber,
        customerId,
        customerName,
        date,
        items,
        subtotal,
        discount,
        total,
        paid,
        due,
        profit,
        status,
        dueDate,
      } = req.body;

      if (!invoiceNumber || !customerId || !date || !items || !items.length) {
        return res.status(400).json({ error: "Missing required sale fields" });
      }

      for (const item of items) {
        if (!item.productId || !ObjectId.isValid(item.productId)) {
          return res.status(400).json({ error: "Invalid productId in items" });
        }
      }

      const doc = {
        invoiceNumber,
        customerId: customerId.toString(),
        customerName: customerName || null,
        date,
        items,
        subtotal: Number(subtotal || 0),
        discount: Number(discount || 0),
        total: Number(total || 0),
        paid: Number(paid || 0),
        due: Number(due || 0),
        profit: Number(profit || 0),
        status: status || "completed",
        dueDate: dueDate || null,
        createdAt: new Date().toISOString(),
      };

      const result = await sales.insertOne(doc);
      const saleId = result.insertedId;

      await adjustStock(items, -1, invoiceNumber);

      if (doc.due > 0) {
        await dues.insertOne({
          customerId: doc.customerId,
          customerName: doc.customerName,
          saleId: saleId.toString(),
          invoiceNumber,
          saleDate: date,
          totalAmount: doc.total,
          paid: doc.paid,
          due: doc.due,
          dueDate: doc.dueDate,
          status: "unpaid",
          createdAt: new Date().toISOString(),
        });
      }

      await recomputeCustomer(doc.customerId);

      res.status(201).json(serialize({ _id: saleId, ...doc }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.patch("/api/sales/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const oldSale = await sales.findOne({ _id });
      if (!oldSale) return res.status(404).json({ error: "Sale not found" });

      await adjustStock(oldSale.items, 1, `${oldSale.invoiceNumber}-reversal`);
      await dues.deleteMany({ saleId: req.params.id });

      const {
        invoiceNumber,
        customerId,
        customerName,
        date,
        items,
        subtotal,
        discount,
        total,
        paid,
        due,
        profit,
        status,
        dueDate,
      } = req.body;

      const update = {
        invoiceNumber: invoiceNumber ?? oldSale.invoiceNumber,
        customerId: customerId ? customerId.toString() : oldSale.customerId,
        customerName: customerName ?? oldSale.customerName,
        date: date ?? oldSale.date,
        items: items ?? oldSale.items,
        subtotal: subtotal !== undefined ? Number(subtotal) : oldSale.subtotal,
        discount: discount !== undefined ? Number(discount) : oldSale.discount,
        total: total !== undefined ? Number(total) : oldSale.total,
        paid: paid !== undefined ? Number(paid) : oldSale.paid,
        due: due !== undefined ? Number(due) : oldSale.due,
        profit: profit !== undefined ? Number(profit) : oldSale.profit,
        status: status ?? oldSale.status,
        dueDate: dueDate ?? oldSale.dueDate,
      };

      await sales.updateOne({ _id }, { $set: update });
      await adjustStock(update.items, -1, update.invoiceNumber);

      if (update.due > 0) {
        await dues.insertOne({
          customerId: update.customerId,
          customerName: update.customerName,
          saleId: req.params.id,
          invoiceNumber: update.invoiceNumber,
          saleDate: update.date,
          totalAmount: update.total,
          paid: update.paid,
          due: update.due,
          dueDate: update.dueDate,
          status: "unpaid",
          createdAt: new Date().toISOString(),
        });
      }

      await recomputeCustomer(update.customerId);

      const updated = await sales.findOne({ _id });
      res.json(serialize(updated));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/sales/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const sale = await sales.findOne({ _id });
      if (!sale) return res.status(404).json({ error: "Sale not found" });

      await adjustStock(sale.items, 1, `${sale.invoiceNumber}-delete`);
      await dues.deleteMany({ saleId: req.params.id });
      await sales.deleteOne({ _id });
      await recomputeCustomer(sale.customerId);

      res.json({ success: true, id: req.params.id });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/purchases", async (req, res) => {
    try {
      const docs = await purchases.find({}).sort({ date: -1 }).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/purchases/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const doc = await purchases.findOne({ _id });
      if (!doc) return res.status(404).json({ error: "Purchase not found" });
      res.json(serialize(doc));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post("/api/purchases", async (req, res) => {
    try {
      const {
        purchaseNumber,
        supplierId,
        supplierName,
        agentName,
        agentPhone,
        date,
        items,
        subtotal,
        discount,
        additionalCost,
        total,
        paid,
        due,
        status,
      } = req.body;

      if (!purchaseNumber || !supplierId || !date || !items || !items.length) {
        return res
          .status(400)
          .json({ error: "Missing required purchase fields" });
      }

      const doc = {
        purchaseNumber,
        supplierId: supplierId.toString(),
        supplierName: supplierName || null,
        agentName: agentName || null,
        agentPhone: agentPhone || null,
        date,
        items,
        subtotal: Number(subtotal || 0),
        discount: Number(discount || 0),
        additionalCost: Number(additionalCost || 0),
        total: Number(total || 0),
        paid: Number(paid || 0),
        due: Number(due || 0),
        status: status || "completed",
        createdAt: new Date().toISOString(),
      };

      const result = await purchases.insertOne(doc);

      for (const item of items) {
        const product = await products.findOne({ name: item.productName });
        if (!product) continue;
        const newStock = (product.currentStock || 0) + (item.quantity || 0);
        const newStatus = getStockStatus(newStock, product.minimumStock || 0);
        await products.updateOne(
          { _id: product._id },
          { $set: { currentStock: newStock, status: newStatus } }
        );
        await stockMovements.insertOne({
          productId: product._id.toString(),
          productName: product.name,
          type: "in",
          quantity: item.quantity || 0,
          previousStock: product.currentStock || 0,
          newStock,
          reference: purchaseNumber,
          date: todayStr(),
          createdAt: new Date().toISOString(),
        });
      }

      res.status(201).json(serialize({ _id: result.insertedId, ...doc }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/purchases/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const update = { ...req.body };
      delete update.id;
      delete update._id;
      if (update.supplierId !== undefined)
        update.supplierId = update.supplierId?.toString() ?? null;

      const result = await purchases.findOneAndUpdate(
        { _id },
        { $set: update },
        { returnDocument: "after" }
      );
      if (!result) return res.status(404).json({ error: "Purchase not found" });
      res.json(serialize(result));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/purchases/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const result = await purchases.deleteOne({ _id });
      if (result.deletedCount === 0)
        return res.status(404).json({ error: "Purchase not found" });
      res.json({ success: true, id: req.params.id });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/expenses", async (req, res) => {
    try {
      const docs = await expenses.find({}).sort({ date: -1 }).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/expenses", async (req, res) => {
    try {
      const { category, description, amount, paymentMethod, date } = req.body;
      if (!description || amount === undefined) {
        return res
          .status(400)
          .json({ error: "description and amount are required" });
      }

      const doc = {
        category: category || "general",
        description,
        amount: Number(amount),
        paymentMethod: paymentMethod || "cash",
        date: date || todayStr(),
        createdAt: new Date().toISOString(),
      };
      const result = await expenses.insertOne(doc);
      res.status(201).json(serialize({ _id: result.insertedId, ...doc }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/expenses/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const update = { ...req.body };
      delete update.id;
      delete update._id;
      if (update.amount !== undefined) update.amount = Number(update.amount);

      const result = await expenses.findOneAndUpdate(
        { _id },
        { $set: update },
        { returnDocument: "after" }
      );
      if (!result) return res.status(404).json({ error: "Expense not found" });
      res.json(serialize(result));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/expenses/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const result = await expenses.deleteOne({ _id });
      if (result.deletedCount === 0)
        return res.status(404).json({ error: "Expense not found" });
      res.json({ success: true, id: req.params.id });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/dues", async (req, res) => {
    try {
      const docs = await dues.find({}).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/dues/overdue", async (req, res) => {
    try {
      const today = todayStr();
      const docs = await dues
        .find({ dueDate: { $lt: today }, status: { $ne: "paid" } })
        .toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/dues", async (req, res) => {
    try {
      const {
        customerId,
        customerName,
        saleId,
        invoiceNumber,
        saleDate,
        totalAmount,
        paid,
        due,
        dueDate,
        status,
      } = req.body;
      if (!customerId || due === undefined) {
        return res
          .status(400)
          .json({ error: "customerId and due are required" });
      }

      const doc = {
        customerId: customerId.toString(),
        customerName: customerName || null,
        saleId: saleId || null,
        invoiceNumber: invoiceNumber || null,
        saleDate: saleDate || null,
        totalAmount: Number(totalAmount || 0),
        paid: Number(paid || 0),
        due: Number(due),
        dueDate: dueDate || null,
        status: status || "unpaid",
        createdAt: new Date().toISOString(),
      };
      const result = await dues.insertOne(doc);
      res.status(201).json(serialize({ _id: result.insertedId, ...doc }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/dues/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const update = { ...req.body };
      delete update.id;
      delete update._id;

      const result = await dues.findOneAndUpdate(
        { _id },
        { $set: update },
        { returnDocument: "after" }
      );
      if (!result) return res.status(404).json({ error: "Due not found" });
      res.json(serialize(result));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/dues/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const result = await dues.deleteOne({ _id });
      if (result.deletedCount === 0)
        return res.status(404).json({ error: "Due not found" });
      res.json({ success: true, id: req.params.id });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/payments", async (req, res) => {
    try {
      const docs = await payments.find({}).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/payments", async (req, res) => {
    try {
      const { customerId, saleId, invoiceNumber, amount, method, date, note } =
        req.body;
      if (!customerId || amount === undefined) {
        return res
          .status(400)
          .json({ error: "customerId and amount are required" });
      }

      const doc = {
        customerId: customerId.toString(),
        saleId: saleId || null,
        invoiceNumber: invoiceNumber || null,
        amount: Number(amount),
        method: method || "cash",
        date: date || todayStr(),
        note: note || null,
        createdAt: new Date().toISOString(),
      };
      const result = await payments.insertOne(doc);

      const dueQuery = saleId
        ? { saleId }
        : invoiceNumber
          ? { invoiceNumber }
          : null;

      if (dueQuery) {
        const relatedDue = await dues.findOne(dueQuery);
        if (relatedDue) {
          const newPaid = (relatedDue.paid || 0) + doc.amount;
          const newDue = (relatedDue.due || 0) - doc.amount;
          const newStatus = newDue <= 0 ? "paid" : "partial";

          await dues.updateOne(
            { _id: relatedDue._id },
            { $set: { paid: newPaid, due: newDue, status: newStatus } }
          );
        }
      }

      await recomputeCustomer(doc.customerId);

      res.status(201).json(serialize({ _id: result.insertedId, ...doc }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/payments/:id", async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      const payment = await payments.findOne({ _id });
      if (!payment) return res.status(404).json({ error: "Payment not found" });

      const dueQuery = payment.saleId
        ? { saleId: payment.saleId }
        : payment.invoiceNumber
          ? { invoiceNumber: payment.invoiceNumber }
          : null;

      if (dueQuery) {
        const relatedDue = await dues.findOne(dueQuery);
        if (relatedDue) {
          const newPaid = (relatedDue.paid || 0) - payment.amount;
          const newDue = (relatedDue.due || 0) + payment.amount;
          const newStatus =
            newDue <= 0 ? "paid" : newPaid > 0 ? "partial" : "unpaid";

          await dues.updateOne(
            { _id: relatedDue._id },
            { $set: { paid: newPaid, due: newDue, status: newStatus } }
          );
        }
      }

      await payments.deleteOne({ _id });
      await recomputeCustomer(payment.customerId);

      res.json({ success: true, id: req.params.id });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/stock-movements", async (req, res) => {
    try {
      const docs = await stockMovements.find({}).sort({ date: -1 }).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/stock-movements/:productId", async (req, res) => {
    try {
      const docs = await stockMovements
        .find({ productId: req.params.productId })
        .sort({ date: -1 })
        .toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/stock-movements", async (req, res) => {
    try {
      const { productId, productName, type, quantity, reference } = req.body;
      if (!productId || !type || quantity === undefined) {
        return res
          .status(400)
          .json({ error: "productId, type and quantity are required" });
      }

      const prodId = toObjectId(productId);
      const product = await products.findOne({ _id: prodId });
      if (!product) return res.status(404).json({ error: "Product not found" });

      const direction = type === "in" ? 1 : -1;
      const qty = Number(quantity);
      const newStock = (product.currentStock || 0) + direction * qty;
      const newStatus = getStockStatus(newStock, product.minimumStock || 0);

      await products.updateOne(
        { _id: prodId },
        { $set: { currentStock: newStock, status: newStatus } }
      );

      const doc = {
        productId: prodId.toString(),
        productName: productName || product.name,
        type,
        quantity: qty,
        reference: reference || "manual-adjustment",
        date: todayStr(),
        createdAt: new Date().toISOString(),
      };
      const result = await stockMovements.insertOne(doc);
      res.status(201).json(serialize({ _id: result.insertedId, ...doc }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/settings", async (req, res) => {
    try {
      let doc = await settings.findOne({});
      if (!doc) {
        const defaultSettings = {
          businessName: "",
          ownerName: "",
          phone: "",
          address: "",
          email: "",
          invoicePrefix: "INV",
          paymentTerms: "",
          invoiceFooter: "",
          currency: "BDT",
          createdAt: new Date().toISOString(),
        };
        const result = await settings.insertOne(defaultSettings);
        doc = { _id: result.insertedId, ...defaultSettings };
      }
      res.json(serialize(doc));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/settings", async (req, res) => {
    try {
      const {
        businessName,
        ownerName,
        phone,
        address,
        email,
        invoicePrefix,
        paymentTerms,
        invoiceFooter,
        currency,
      } = req.body;

      const update = {
        businessName,
        ownerName,
        phone,
        address,
        email,
        invoicePrefix,
        paymentTerms,
        invoiceFooter,
        currency,
        updatedAt: new Date().toISOString(),
      };

      const existing = await settings.findOne({});
      let result;
      if (existing) {
        result = await settings.findOneAndUpdate(
          { _id: existing._id },
          { $set: update },
          { returnDocument: "after" }
        );
      } else {
        const insertResult = await settings.insertOne({
          ...update,
          createdAt: new Date().toISOString(),
        });
        result = await settings.findOne({ _id: insertResult.insertedId });
      }

      res.json(serialize(result));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/statements/generate", async (req, res) => {
    try {
      const { from, to } = req.body;
      if (!from || !to)
        return res.status(400).json({ error: "from and to are required" });

      const dateFilter = { date: { $gte: from, $lte: to } };

      const rangeSales = await sales.find(dateFilter).toArray();
      const rangePurchases = await purchases.find(dateFilter).toArray();
      const rangeExpenses = await expenses.find(dateFilter).toArray();
      const rangeDues = await dues
        .find({ saleDate: { $gte: from, $lte: to } })
        .toArray();

      const totalSalesAmount = rangeSales.reduce(
        (s, x) => s + (x.total || 0),
        0
      );
      const totalSalesPaid = rangeSales.reduce((s, x) => s + (x.paid || 0), 0);
      const totalSalesDue = rangeSales.reduce((s, x) => s + (x.due || 0), 0);
      const totalSalesReturned = rangeSales
        .filter((x) => x.status === "returned")
        .reduce((s, x) => s + (x.total || 0), 0);

      const totalPurchaseAmount = rangePurchases.reduce(
        (s, x) => s + (x.total || 0),
        0
      );
      const totalPurchasePaid = rangePurchases.reduce(
        (s, x) => s + (x.paid || 0),
        0
      );
      const totalPurchaseDue = rangePurchases.reduce(
        (s, x) => s + (x.due || 0),
        0
      );
      const totalPurchaseReturned = rangePurchases
        .filter((x) => x.status === "returned")
        .reduce((s, x) => s + (x.total || 0), 0);

      const totalExpensesAmount = rangeExpenses.reduce(
        (s, x) => s + (x.amount || 0),
        0
      );

      const revenue = totalSalesAmount;
      const cogs = rangeSales.reduce(
        (s, x) => s + ((x.total || 0) - (x.profit || 0)),
        0
      );
      const grossProfit = revenue - cogs;
      const netProfit = grossProfit - totalExpensesAmount;
      const margin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

      const openingBalance = 0;
      const closingBalance =
        openingBalance + totalSalesPaid - totalExpensesAmount;

      const expenseByCategory = {};
      for (const e of rangeExpenses) {
        const cat = e.category || "general";
        expenseByCategory[cat] =
          (expenseByCategory[cat] || 0) + (e.amount || 0);
      }
      const byCategory = Object.entries(expenseByCategory).map(
        ([category, amount]) => ({ category, amount })
      );

      const dueOpening = 0;
      const dueNew = rangeDues.reduce((s, x) => s + (x.due || 0), 0);
      const dueCollected = rangeDues.reduce((s, x) => s + (x.paid || 0), 0);
      const dueClosing = dueOpening + dueNew - dueCollected;

      const allProducts = await products.find({}).toArray();
      const currentStockValue = allProducts.reduce(
        (s, p) => s + (p.currentStock || 0) * (p.purchasePrice || 0),
        0
      );
      const purchasedValue = totalPurchaseAmount;
      const soldValue = rangeSales.reduce(
        (s, x) => s + ((x.total || 0) - (x.profit || 0)),
        0
      );

      res.json({
        range: { from, to },
        business: {
          openingBalance,
          totalSales: totalSalesAmount,
          totalPurchase: totalPurchaseAmount,
          totalExpenses: totalExpensesAmount,
          totalCollection: totalSalesPaid,
          totalDue: totalSalesDue,
          grossProfit,
          netProfit,
          closingBalance,
        },
        sales: {
          count: rangeSales.length,
          amount: totalSalesAmount,
          paid: totalSalesPaid,
          due: totalSalesDue,
          returned: totalSalesReturned,
        },
        purchases: {
          count: rangePurchases.length,
          cost: totalPurchaseAmount,
          paid: totalPurchasePaid,
          due: totalPurchaseDue,
          returned: totalPurchaseReturned,
        },
        expenses: {
          total: totalExpensesAmount,
          byCategory,
        },
        profit: {
          revenue,
          cogs,
          grossProfit,
          expenses: totalExpensesAmount,
          netProfit,
          margin,
        },
        stock: {
          openingValue: currentStockValue - purchasedValue + soldValue,
          purchasedValue,
          soldValue,
          currentValue: currentStockValue,
        },
        due: {
          opening: dueOpening,
          newDue: dueNew,
          collected: dueCollected,
          closing: dueClosing,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/sales", async (req, res) => {
    try {
      const { from, to } = req.query;
      const filter = {};
      if (from && to) filter.date = { $gte: from, $lte: to };

      const docs = await sales.find(filter).sort({ date: -1 }).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/purchases", async (req, res) => {
    try {
      const { from, to } = req.query;
      const filter = {};
      if (from && to) filter.date = { $gte: from, $lte: to };

      const docs = await purchases.find(filter).sort({ date: -1 }).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/profit", async (req, res) => {
    try {
      const { from, to } = req.query;
      const filter = {};
      if (from && to) filter.date = { $gte: from, $lte: to };

      const rangeSales = await sales.find(filter).toArray();
      const rangeExpenses = await expenses.find(filter).toArray();

      const revenue = rangeSales.reduce((s, x) => s + (x.total || 0), 0);
      const cogs = rangeSales.reduce(
        (s, x) => s + ((x.total || 0) - (x.profit || 0)),
        0
      );
      const grossProfit = revenue - cogs;
      const expensesTotal = rangeExpenses.reduce(
        (s, x) => s + (x.amount || 0),
        0
      );
      const netProfit = grossProfit - expensesTotal;
      const margin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

      const monthlyMap = {};
      for (const s of rangeSales) {
        const month = (s.date || "").slice(0, 7);
        if (!monthlyMap[month])
          monthlyMap[month] = { revenue: 0, cost: 0, profit: 0 };
        monthlyMap[month].revenue += s.total || 0;
        monthlyMap[month].cost += (s.total || 0) - (s.profit || 0);
        monthlyMap[month].profit += s.profit || 0;
      }
      const monthly = Object.entries(monthlyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, v]) => ({ month, ...v }));

      res.json({
        revenue,
        cogs,
        grossProfit,
        expenses: expensesTotal,
        netProfit,
        margin,
        monthly,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/expenses", async (req, res) => {
    try {
      const { from, to } = req.query;
      const filter = {};
      if (from && to) filter.date = { $gte: from, $lte: to };

      const entries = await expenses.find(filter).sort({ date: -1 }).toArray();
      const total = entries.reduce((s, x) => s + (x.amount || 0), 0);

      const byCategoryMap = {};
      for (const e of entries) {
        const cat = e.category || "general";
        byCategoryMap[cat] = (byCategoryMap[cat] || 0) + (e.amount || 0);
      }
      const byCategory = Object.entries(byCategoryMap).map(
        ([category, amount]) => ({ category, amount })
      );

      res.json({ total, byCategory, entries: serializeArray(entries) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/stock", async (req, res) => {
    try {
      const allProducts = await products.find({}).toArray();
      const totalProducts = allProducts.length;
      const totalUnits = allProducts.reduce(
        (s, p) => s + (p.currentStock || 0),
        0
      );
      const totalValue = allProducts.reduce(
        (s, p) => s + (p.currentStock || 0) * (p.purchasePrice || 0),
        0
      );
      const lowStock = allProducts.filter(
        (p) => p.status === "low-stock"
      ).length;
      const outOfStock = allProducts.filter(
        (p) => p.status === "out-of-stock"
      ).length;

      res.json({
        totalProducts,
        totalUnits,
        totalValue,
        lowStock,
        outOfStock,
        products: serializeArray(allProducts),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/dues", async (req, res) => {
    try {
      const allCustomers = await customers
        .find({ totalDue: { $gt: 0 } })
        .toArray();
      res.json(serializeArray(allCustomers));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/products", async (req, res) => {
    try {
      const allSales = await sales.find({}).toArray();
      const allProducts = await products.find({}).toArray();

      const perf = {};
      for (const s of allSales) {
        for (const item of s.items || []) {
          const key = item.productId;
          if (!perf[key]) {
            perf[key] = {
              productName: item.productName,
              sold: 0,
              revenue: 0,
              cost: 0,
              profit: 0,
            };
          }
          perf[key].sold += item.quantity || 0;
          perf[key].revenue += item.subtotal || 0;
          perf[key].cost += (item.purchasePrice || 0) * (item.quantity || 0);
          perf[key].profit += item.profit || 0;
        }
      }

      const result = Object.entries(perf).map(([productId, v]) => {
        const product = allProducts.find((p) => p._id.toString() === productId);
        return {
          productId,
          productName: v.productName,
          sold: v.sold,
          stock: product ? product.currentStock : null,
          revenue: v.revenue,
          cost: v.cost,
          profit: v.profit,
          margin: v.revenue > 0 ? (v.profit / v.revenue) * 100 : 0,
        };
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/dashboard/summary", async (req, res) => {
    try {
      const now = new Date();
      const last30Start = new Date(now);
      last30Start.setDate(now.getDate() - 30);
      const prev30Start = new Date(now);
      prev30Start.setDate(now.getDate() - 60);

      const last30 = dateStr(last30Start);
      const prev30 = dateStr(prev30Start);
      const todayD = dateStr(now);

      const allSales = await sales.find({}).toArray();
      const allPurchases = await purchases.find({}).toArray();
      const allProducts = await products.find({}).toArray();
      const allCustomers = await customers.find({}).toArray();
      const allExpenses = await expenses.find({}).toArray();

      const totalSales = allSales.reduce((s, x) => s + (x.total || 0), 0);
      const totalPurchase = allPurchases.reduce(
        (s, x) => s + (x.total || 0),
        0
      );
      const totalProfit = allSales.reduce((s, x) => s + (x.profit || 0), 0);
      const totalDue = allCustomers.reduce((s, x) => s + (x.totalDue || 0), 0);

      const stockValue = allProducts.reduce(
        (s, p) => s + (p.currentStock || 0) * (p.purchasePrice || 0),
        0
      );

      const totalPaidAll = allSales.reduce((s, x) => s + (x.paid || 0), 0);
      const totalExpensesAll = allExpenses.reduce(
        (s, x) => s + (x.amount || 0),
        0
      );
      const cashBalance = totalPaidAll - totalExpensesAll;

      const last30Sales = allSales.filter(
        (s) => s.date >= last30 && s.date <= todayD
      );
      const prev30Sales = allSales.filter(
        (s) => s.date >= prev30 && s.date < last30
      );

      const last30SalesTotal = last30Sales.reduce(
        (s, x) => s + (x.total || 0),
        0
      );
      const prev30SalesTotal = prev30Sales.reduce(
        (s, x) => s + (x.total || 0),
        0
      );
      const last30Profit = last30Sales.reduce((s, x) => s + (x.profit || 0), 0);
      const prev30Profit = prev30Sales.reduce((s, x) => s + (x.profit || 0), 0);

      const totalSalesChange =
        prev30SalesTotal > 0
          ? ((last30SalesTotal - prev30SalesTotal) / prev30SalesTotal) * 100
          : 0;
      const totalProfitChange =
        prev30Profit > 0
          ? ((last30Profit - prev30Profit) / prev30Profit) * 100
          : 0;

      const recentSalesCount = last30Sales.length;
      const lowStockCount = allProducts.filter(
        (p) => (p.currentStock || 0) <= (p.minimumStock || 0)
      ).length;
      const dueCustomersCount = allCustomers.filter(
        (c) => (c.totalDue || 0) > 0
      ).length;

      res.json({
        totalSales,
        totalPurchase,
        totalProfit,
        stockValue,
        totalDue,
        cashBalance,
        totalSalesChange,
        totalProfitChange,
        recentSalesCount,
        lowStockCount,
        dueCustomersCount,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/dashboard/charts", async (req, res) => {
    try {
      const range = req.query.range || "30d";
      const now = new Date();

      const allSales = await sales.find({}).toArray();
      const allPurchases = await purchases.find({}).toArray();

      let series = [];

      if (range === "7d" || range === "30d") {
        const days = range === "7d" ? 7 : 30;
        for (let i = days - 1; i >= 0; i--) {
          const d = new Date(now);
          d.setDate(now.getDate() - i);
          const dayStr = dateStr(d);

          const daySales = allSales.filter((s) => s.date === dayStr);
          const dayPurchases = allPurchases.filter((p) => p.date === dayStr);

          series.push({
            name: dayStr,
            sales: daySales.reduce((s, x) => s + (x.total || 0), 0),
            purchases: dayPurchases.reduce((s, x) => s + (x.total || 0), 0),
            profit: daySales.reduce((s, x) => s + (x.profit || 0), 0),
          });
        }
      } else if (range === "6m" || range === "1y") {
        const months = range === "6m" ? 6 : 12;
        for (let i = months - 1; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const mStr = monthStr(d);

          const monthSales = allSales.filter((s) =>
            (s.date || "").startsWith(mStr)
          );
          const monthPurchases = allPurchases.filter((p) =>
            (p.date || "").startsWith(mStr)
          );

          series.push({
            name: mStr,
            sales: monthSales.reduce((s, x) => s + (x.total || 0), 0),
            purchases: monthPurchases.reduce((s, x) => s + (x.total || 0), 0),
            profit: monthSales.reduce((s, x) => s + (x.profit || 0), 0),
          });
        }
      } else {
        return res
          .status(400)
          .json({ error: "Invalid range. Use 7d, 30d, 6m, or 1y" });
      }

      res.json({ series });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/dashboard/sales-by-category", async (req, res) => {
    try {
      const allSales = await sales.find({}).toArray();
      const allCategories = await categories.find({}).toArray();
      const allProducts = await products.find({}).toArray();

      const productToCategory = new Map();
      for (const p of allProducts) {
        productToCategory.set(p._id.toString(), p.categoryId);
      }

      const totals = {};
      for (const s of allSales) {
        for (const item of s.items || []) {
          const catId = productToCategory.get(item.productId);
          if (!catId) continue;
          totals[catId] = (totals[catId] ?? 0) + (item.subtotal || 0);
        }
      }

      const result = allCategories.map((c) => ({
        id: c._id.toString(),
        name: c.name,
        color: c.color ?? "#64748b",
        value: totals[c._id.toString()] ?? 0,
      }));

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/dashboard/recent-sales", async (req, res) => {
    try {
      const docs = await sales.find({}).sort({ date: -1 }).limit(6).toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/dashboard/recent-dues", async (req, res) => {
    try {
      const docs = await dues
        .find({ due: { $gt: 0 } })
        .sort({ saleDate: -1 })
        .limit(6)
        .toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/dashboard/low-stock", async (req, res) => {
    try {
      const docs = await products
        .find({ $expr: { $lte: ["$currentStock", "$minimumStock"] } })
        .toArray();
      res.json(serializeArray(docs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

run().catch(console.dir);

process.on("SIGINT", async () => {
  await client.close();
  console.log("MongoDB connection closed");
  process.exit(0);
});