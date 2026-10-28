
const ProductSetting = require('../models/ProductSetting');
const ReadyStock = require('../models/ReadyStock');
const { recalcReadyStock, unsoldReadyStockIds } = require('../utils/costing');

// New costs apply to this product's theli that are not sold yet
const recalcProduct = async (productName) => {
  const batches = await unsoldReadyStockIds({ productType: productName });
  for (const rs of batches) await recalcReadyStock(rs);
};

exports.getProducts = async (req, res) => {
  try {
    const products = await ProductSetting.find();
    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addProduct = async (req, res) => {
  try {
    const newProduct = new ProductSetting(req.body);
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
    const updated = await ProductSetting.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (updated) await recalcProduct(updated.productName);
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const Stock = require('../models/Stock');
exports.getDistinctProducts = async (req, res) => {
  try {
    const products = await Stock.distinct('productName');
    res.status(200).json(products);
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
