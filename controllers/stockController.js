const Stock = require('../models/Stock');
const ReadyStock = require('../models/ReadyStock');
const { costForReadyStock } = require('../utils/costing');

// Get all stocks
exports.getStocks = async (req, res) => {
  try {
    const stocks = await Stock.find().sort({ createdAt: -1 }).populate('purchaseId');
    res.status(200).json(stocks);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching stocks', error: error.message });
  }
};

// Get a single stock by ID
exports.getStockById = async (req, res) => {
  try {
    const { id } = req.params;
    const stock = await Stock.findById(id).populate('purchaseId');
    if (!stock) {
      return res.status(404).json({ message: 'Stock batch not found' });
    }
    res.status(200).json(stock);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching stock batch', error: error.message });
  }
};

// Get stocks by product name
exports.getStocksByProduct = async (req, res) => {
  try {
    const { productName } = req.params;
    const stocks = await Stock.find({ productName: new RegExp('^' + productName + '$', 'i') }).sort({ createdAt: -1 });
    res.status(200).json(stocks);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching stocks for product', error: error.message });
  }
};

// Update stock (e.g., location, status, or manual remaining quantity adjustment)
exports.updateStock = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const updatedStock = await Stock.findByIdAndUpdate(id, updates, { new: true });
    if (!updatedStock) {
      return res.status(404).json({ message: 'Stock batch not found' });
    }
    res.status(200).json(updatedStock);
  } catch (error) {
    res.status(500).json({ message: 'Error updating stock batch', error: error.message });
  }
};

// Delete stock batch
exports.deleteStock = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedStock = await Stock.findByIdAndDelete(id);
    if (!deletedStock) {
      return res.status(404).json({ message: 'Stock batch not found' });
    }
    res.status(200).json({ message: 'Stock batch deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting stock batch', error: error.message });
  }
};

// Theli costing per production batch: raw cost, packaging + transport, total, selling rate, profit
exports.getCostingReport = async (req, res) => {
  try {
    const readyStocks = await ReadyStock.find().sort({ productionDate: -1 });
    const rows = [];
    for (const rs of readyStocks) {
      const live = await costForReadyStock(rs);
      // Use the cost saved at packing time; batches packed before costing existed fall back to a live calculation
      const saved = rs.costing && rs.costing.packetsPerKg > 0;
      const costing = saved ? rs.costing.toObject() : live.costing;
      const costPerPacket = saved ? rs.costPerPacket : live.costPerPacket;
      const sellingRate = live.setting ? Number(live.setting.defaultSellingRate) || 0 : 0;
      rows.push({
        _id: rs._id,
        productionBatchId: rs.productionBatchId,
        stockBatchId: rs.stockBatchId,
        rawProductName: live.stock ? live.stock.productName : '',
        supplier: live.stock ? live.stock.supplier : '',
        purchaseDate: live.stock ? live.stock.purchaseDate : null,
        productType: rs.productType,
        packetSizeGrams: rs.packetSizeGrams,
        productionDate: rs.productionDate,
        totalPackets: rs.totalPackets,
        availablePackets: rs.availablePackets,
        costing,
        costPerPacket,
        sellingRate,
        profitPerPacket: sellingRate - costPerPacket
      });
    }
    res.status(200).json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error building costing report', error: error.message });
  }
};
