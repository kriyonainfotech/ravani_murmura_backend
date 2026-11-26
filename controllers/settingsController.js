
const ProductSetting = require('../models/ProductSetting');
const ReadyStock = require('../models/ReadyStock');
const Stock = require('../models/Stock');
const { recalcReadyStock, unsoldReadyStockIds } = require('../utils/costing');

// New costs apply to this product's theli that are not sold yet
const recalcProduct = async (productName) => {
  const batches = await unsoldReadyStockIds({ productType: productName });
  for (const rs of batches) await recalcReadyStock(rs);
};

exports.getProducts = async (req, res) => {
  try {
    const products = await ProductSetting.find().sort({ createdAt: -1 });
    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addProduct = async (req, res) => {
  try {
    const { productName, packetSizeGrams } = req.body;
    if (!productName || !productName.trim()) {
      return res.status(400).json({ message: 'Product name is required' });
    }
    const cleanName = productName.trim();
    const grams = Number(packetSizeGrams) || 1000;
    const ppk = req.body.packetsPerKg != null && req.body.packetsPerKg !== ''
      ? Number(req.body.packetsPerKg)
      : (grams > 0 ? Number((1000 / grams).toFixed(2)) : 1);

    let existing = await ProductSetting.findOne({
      productName: { $regex: new RegExp(`^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      packetSizeGrams: grams
    });

    if (existing) {
      Object.assign(existing, req.body, { productName: cleanName, packetSizeGrams: grams, packetsPerKg: ppk });
      await existing.save();
      await recalcProduct(existing.productName);
      return res.status(200).json(existing);
    }

    const newProduct = new ProductSetting({
      ...req.body,
      productName: cleanName,
      packetSizeGrams: grams,
      packetsPerKg: ppk
    });
    await newProduct.save();
    await recalcProduct(newProduct.productName);
    res.status(201).json(newProduct);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    await ProductSetting.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'Deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.productName) updates.productName = updates.productName.trim();
    if (updates.packetSizeGrams != null) {
      const grams = Number(updates.packetSizeGrams) || 1000;
      updates.packetSizeGrams = grams;
      if (updates.packetsPerKg == null) {
        updates.packetsPerKg = grams > 0 ? Number((1000 / grams).toFixed(2)) : 1;
      }
    }
    const updated = await ProductSetting.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (updated) await recalcProduct(updated.productName);
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getDistinctProducts = async (req, res) => {
  try {
    const [stockProds, settingProds] = await Promise.all([
      Stock.distinct('productName'),
      ProductSetting.distinct('productName')
    ]);
    const set = new Set([...(settingProds || []), ...(stockProds || [])].map(s => (s || '').trim()).filter(Boolean));
    res.status(200).json(Array.from(set));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Recalculate the cost of every ready-stock batch (e.g. batches packed before costing was set up)
exports.recalculateCosts = async (req, res) => {
  try {
    const all = await ReadyStock.find();
    for (const rs of all) await recalcReadyStock(rs);
    res.status(200).json({ message: 'Costs recalculated', count: all.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
