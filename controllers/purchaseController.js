const Purchase = require('../models/Purchase');
const Stock = require('../models/Stock');
const ReadyStock = require('../models/ReadyStock');
const { recalcReadyStock } = require('../utils/costing');
const { buildSplit, resplit, splitSummary, recordLoss, removeLoss } = require('../utils/lossLedger');
const Expense = require('../models/Expense');
const { round2, purchasePaid, purchasePaymentError, payPurchase, fundsError } = require('../utils/finance');

const receivedOf = (p) => (p.receivedQuantity != null ? Number(p.receivedQuantity) : Number(p.quantity) || 0);

// Validate the ordered-vs-received split sent by the client (null when the client sent none)
const splitFromBody = (body, quantity, receivedQty) => {
  if (!body.loss) return { split: null };
  return buildSplit({ expected: quantity, actual: receivedQty, input: body.loss, mode: 'received', unitLabel: 'KG' });
};

// Move damaged quantity in / out of the stock batch so usable stock = received - wastage
const applyStockWastage = async (purchase, stock, wastageQty) => {
  const delta = (Number(wastageQty) || 0) - (Number(purchase.stockWastageQty) || 0);
  if (!stock || delta === 0) return;
  stock.purchasedQuantity = Number(stock.purchasedQuantity) - delta;
  stock.remainingQuantity = Math.max(0, Number(stock.remainingQuantity) - delta);
  await stock.save();
  purchase.stockWastageQty = Number(wastageQty) || 0;
};

// Stage 1 of the loss ledger: ordered vs received at the shop godown
const syncPurchaseLoss = async (purchase, split) => {
  const stock = await Stock.findOne({ purchaseId: purchase._id });
  if (purchase.status !== 'Completed') {
    await removeLoss(purchase._id, 'PURCHASE_RECEIVE');
    if (purchase.receiveLoss) {
      purchase.receiveLoss = undefined;
      await purchase.save();
    }
    return;
  }
  const finalSplit = split || resplit(
    purchase.receiveLoss || { differenceReason: purchase.wasteReason || '' },
    Number(purchase.quantity) || 0,
    receivedOf(purchase),
    'received'
  );
  await applyStockWastage(purchase, stock, finalSplit.wastageQty);
  purchase.receiveLoss = finalSplit;
  purchase.wasteReason = splitSummary(finalSplit, 'KG');
  await purchase.save();

  await recordLoss({
    stage: 'PURCHASE_RECEIVE', unit: 'KG', refModel: 'Purchase', refId: purchase._id, refCode: purchase.purchaseId,
    productName: purchase.item, stockBatchId: stock ? stock.batchId : '', party: purchase.supplier,
    split: finalSplit, recordedBy: purchase.createdBy, entryDate: purchase.purchaseDate
  });
};

// Helper to create stock batch from purchase
const createStockBatch = async (purchase) => {
  // Check if stock batch already exists for this purchase to prevent duplicates
  const existingStock = await Stock.findOne({ purchaseId: purchase._id });
  if (existingStock) return;

  const lastStock = await Stock.findOne().sort({ batchId: -1 });
  let nextNum = 1;
  if (lastStock && lastStock.batchId && lastStock.batchId.startsWith('BATCH-')) {
    const lastNum = parseInt(lastStock.batchId.replace('BATCH-', ''), 10);
    if (!isNaN(lastNum)) {
      nextNum = lastNum + 1;
    }
  }
  const batchId = `BATCH-${nextNum.toString().padStart(4, '0')}`;

  const newStock = new Stock({
    batchId,
    purchaseId: purchase._id,
    productName: purchase.item,
    supplier: purchase.supplier,
    purchaseDate: purchase.purchaseDate,
    purchaseRate: purchase.rate,
    purchasedQuantity: purchase.receivedQuantity || purchase.quantity,
    remainingQuantity: purchase.receivedQuantity || purchase.quantity,
    location: "Shop",
    status: "Available",
    createdBy: purchase.createdBy
  });

  await newStock.save();
};

// Get all purchases
exports.getPurchases = async (req, res) => {
  try {
    const [purchases, expenses] = await Promise.all([
      Purchase.find().sort({ createdAt: -1 }),
      Expense.find({ purchase: { $ne: null } }).sort({ expenseDate: 1, createdAt: 1 })
        .select('purchase expenseId amount paidFrom expenseDate reference')
    ]);
    // Supplier payments per bill (Purchase expenses), so the list shows paid / due and from which account
    const byPurchase = {};
    expenses.forEach(e => { (byPurchase[e.purchase] = byPurchase[e.purchase] || []).push(e); });
    res.status(200).json(purchases.map(p => ({ ...p.toObject(), payments: byPurchase[p._id] || [] })));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching purchases', error: error.message });
  }
};

// Add a new purchase
exports.addPurchase = async (req, res) => {
  try {
    // Generate a unique Purchase ID
    const lastPurchase = await Purchase.findOne().sort({ purchaseId: -1 });
    let nextNum = 1;
    if (lastPurchase && lastPurchase.purchaseId && lastPurchase.purchaseId.startsWith('PUR-')) {
      const lastNum = parseInt(lastPurchase.purchaseId.replace('PUR-', ''), 10);
      if (!isNaN(lastNum)) {
        nextNum = lastNum + 1;
      }
    }
    const sequenceNumber = nextNum.toString().padStart(3, '0');
    const purchaseId = `PUR-${sequenceNumber}`;

    // Money paid to the supplier now (only when the purchase is added as Completed)
    const { payment, ...body } = req.body;
    // Created by = the logged-in panel (store name); super admin keeps the name the form sends
    if (req.user && req.user.role !== 'super_admin') body.createdBy = req.user.name;
    if (!body.createdBy) body.createdBy = req.user?.name || 'Admin';
    const payNow = body.status === 'Completed' ? payment : null;
    const payErr = purchasePaymentError(payNow, Number(body.totalPrice) || 0)
      || (payNow && await fundsError(payNow.paidFrom, payNow.amount));
    if (payErr) return res.status(400).json({ message: payErr });

    // Added as received: ordered vs received split (reason needed when they differ)
    let split = null;
    if (body.status === 'Completed' && body.receivedQuantity != null) {
      const checked = splitFromBody(req.body, Number(body.quantity) || 0, Number(body.receivedQuantity));
      if (checked.error) return res.status(400).json({ message: checked.error });
      split = checked.split;
    }

    const newPurchase = new Purchase({
      ...body,
      purchaseId,
      amountPaid: 0
    });

    const savedPurchase = await newPurchase.save();

    // Create stock batch if completed
    if (savedPurchase.status === 'Completed') {
      await createStockBatch(savedPurchase);
      await syncPurchaseLoss(savedPurchase, split);
      if (payNow) {
        await payPurchase(savedPurchase, {
          ...payNow,
          expenseDate: payNow.expenseDate || savedPurchase.purchaseDate,
          createdBy: savedPurchase.createdBy
        });
      }
    }

    res.status(201).json(savedPurchase);
  } catch (error) {
    res.status(500).json({ message: 'Error adding purchase', error: error.message });
  }
};

// Delete a purchase
exports.deletePurchase = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedPurchase = await Purchase.findByIdAndDelete(id);
    if (!deletedPurchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }
    // Delete the associated stock batch if it exists
    await Stock.deleteMany({ purchaseId: id });
    await removeLoss(id);
    await Expense.deleteMany({ purchase: id });

    res.status(200).json({ message: 'Purchase and associated stock deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting purchase', error: error.message });
  }
};

// Update purchase status
exports.updatePurchaseStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, receivedQty, wasteReason, payment, paidBy } = req.body;

    let updateFields = { status };
    let oldReceivedQty = null;
    let purchase = null;
    let split = null;

    // Supplier payment made while completing: check it against the bill total after this change
    const payNow = status === 'Completed' && round2(payment?.amount) > 0 ? payment : null;
    if (payNow) {
      const current = await Purchase.findById(id);
      if (!current) return res.status(404).json({ message: 'Purchase not found' });
      const newTotal = receivedQty !== undefined ? Number(receivedQty) * current.rate : Number(current.totalPrice) || 0;
      const payErr = purchasePaymentError(payNow, newTotal - purchasePaid(current))
        || await fundsError(payNow.paidFrom, payNow.amount);
      if (payErr) return res.status(400).json({ message: payErr });
    }

    if (receivedQty !== undefined) {
      purchase = await Purchase.findById(id);
      if (purchase) {
        if (status === 'Completed') {
          const checked = splitFromBody(req.body, purchase.quantity, Number(receivedQty));
          if (checked.error) return res.status(400).json({ message: checked.error });
          split = checked.split;
        }
        oldReceivedQty = purchase.receivedQuantity != null ? purchase.receivedQuantity : purchase.quantity;
        updateFields.receivedQuantity = Number(receivedQty);
        updateFields.totalPrice = Number(receivedQty) * purchase.rate;
        if (wasteReason !== undefined) {
          updateFields.wasteReason = wasteReason;
        }
      }
    }

    const updatedPurchase = await Purchase.findByIdAndUpdate(
      id,
      updateFields,
      { new: true }
    );
    if (!updatedPurchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }
    
    // Create or update stock batch
    if (updatedPurchase.status === 'Completed') {
      if (purchase && purchase.status === 'Completed' && oldReceivedQty !== null && Number(receivedQty) !== oldReceivedQty) {
        const diff = Number(receivedQty) - oldReceivedQty;
        const stockBatch = await Stock.findOne({ purchaseId: updatedPurchase._id });
        if (stockBatch) {
          stockBatch.purchasedQuantity = Number(stockBatch.purchasedQuantity) + diff;
          stockBatch.remainingQuantity = Number(stockBatch.remainingQuantity) + diff;
          await stockBatch.save();
        }
      } else {
        await createStockBatch(updatedPurchase);
      }
    }
    await syncPurchaseLoss(updatedPurchase, split);
    if (payNow) await payPurchase(updatedPurchase, { ...payNow, createdBy: paidBy || updatedPurchase.createdBy });

    res.status(200).json(updatedPurchase);
  } catch (error) {
    res.status(500).json({ message: 'Error updating status', error: error.message });
  }
};

// Update purchase fully
exports.updatePurchase = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const purchase = await Purchase.findById(id);
    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }

    // Validate the wastage / difference split against the final quantities
    let split = null;
    const finalStatus = updates.status || purchase.status;
    if (finalStatus === 'Completed' && updates.loss) {
      const qty = updates.quantity !== undefined ? Number(updates.quantity) : Number(purchase.quantity);
      const got = updates.receivedQuantity !== undefined ? Number(updates.receivedQuantity) : receivedOf(purchase);
      const checked = splitFromBody(updates, qty, got);
      if (checked.error) return res.status(400).json({ message: checked.error });
      split = checked.split;
    }
    delete updates.loss;
    delete updates.receiveLoss;
    delete updates.amountPaid; // only changed through finance payments

    // Check if receivedQuantity is updated and status is Completed
    if (updates.receivedQuantity !== undefined && purchase.status === 'Completed') {
      const currentReceivedQty = purchase.receivedQuantity != null ? purchase.receivedQuantity : purchase.quantity;
      const diff = Number(updates.receivedQuantity) - currentReceivedQty;
      if (diff !== 0) {
        // Need to update the stock batch
        const Stock = require('../models/Stock');
        const stockBatch = await Stock.findOne({ purchaseId: purchase._id });
        if (stockBatch) {
          stockBatch.purchasedQuantity = Number(stockBatch.purchasedQuantity) + diff;
          stockBatch.remainingQuantity = Number(stockBatch.remainingQuantity) + diff;
          await stockBatch.save();
        }
      }
    }

    // Recalculate total price if rate or receivedQty changes
    if (updates.receivedQuantity !== undefined && updates.rate !== undefined) {
       updates.totalPrice = Number(updates.receivedQuantity) * Number(updates.rate);
    } else if (updates.receivedQuantity !== undefined) {
       updates.totalPrice = Number(updates.receivedQuantity) * purchase.rate;
    } else if (updates.rate !== undefined) {
       updates.totalPrice = (purchase.receivedQuantity || purchase.quantity) * Number(updates.rate);
    }

    const updatedPurchase = await Purchase.findByIdAndUpdate(
      id,
      updates,
      { new: true }
    );
    
    if (updatedPurchase.status === 'Completed') {
      await createStockBatch(updatedPurchase);
    }
    await syncPurchaseLoss(updatedPurchase, split);

    // Rate or per-theli costs changed: re-cost the theli already packed from this batch
    const costChanged = ['rate', 'packagingCost', 'transportCost', 'otherCost']
      .some(k => updates[k] !== undefined && Number(updates[k]) !== (Number(purchase[k]) || 0));
    if (costChanged) {
      const stockBatch = await Stock.findOne({ purchaseId: purchase._id });
      if (stockBatch) {
        if (updates.rate !== undefined) {
          stockBatch.purchaseRate = Number(updates.rate);
          await stockBatch.save();
        }
        const packed = await ReadyStock.find({ stockBatchId: stockBatch.batchId });
        for (const rs of packed) await recalcReadyStock(rs);
      }
    }
    
    res.status(200).json(updatedPurchase);
  } catch (error) {
    res.status(500).json({ message: 'Error updating purchase', error: error.message });
  }
};

