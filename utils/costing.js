const ProductSetting = require('../models/ProductSetting');
const Stock = require('../models/Stock');
const Purchase = require('../models/Purchase');
const MachineRun = require('../models/MachineRun');
const ReadyStock = require('../models/ReadyStock');
const ShopStock = require('../models/ShopStock');

// Product setting for a packed product (exact packet size first, then any size)
const findSetting = async (productType, packetSizeGrams) => {
  const exact = await ProductSetting.findOne({ productName: productType, packetSizeGrams });
  return exact || ProductSetting.findOne({ productName: productType });
};

// Packaging / transport / other cost entered on the purchase of a raw batch
const batchCostsOf = async (stock) => {
  const purchase = stock && stock.purchaseId ? await Purchase.findById(stock.purchaseId._id || stock.purchaseId) : null;
  return {
    packagingCost: purchase ? purchase.packagingCost : 0,
    transportCost: purchase ? purchase.transportCost : 0,
    otherCost: purchase ? purchase.otherCost : 0
  };
};

// Cost per theli = raw material + packaging + transport + other
// (+ wastage share when the product has "spread wastage" switched on).
// Raw cost comes from the batch purchase rate: rate per KG / theli per KG;
// packaging, transport and other come from the batch's purchase.
const calcTheliCost = ({ purchaseRate, batchCosts, packetSizeGrams, rawConsumedKg, totalPackets, setting }) => {
  const s = setting || {};
  const b = batchCosts || {};
  const rate = Number(purchaseRate) || 0;
  const packetsPerKg = Number(s.packetsPerKg) || (packetSizeGrams ? 1000 / packetSizeGrams : 0);
  const rawCost = packetsPerKg > 0 ? rate / packetsPerKg : 0;
  const packagingCost = Number(b.packagingCost) || 0;
  const transportCost = Number(b.transportCost) || 0;
  const otherCost = Number(b.otherCost) || 0;

  // Raw material that went into the machine but did not come out as theli
  let wastageCost = 0;
  if (s.spreadWastage && Number(totalPackets) > 0 && Number(rawConsumedKg) > 0) {
    wastageCost = Math.max(0, (Number(rawConsumedKg) * rate) / Number(totalPackets) - rawCost);
  }

  return {
    costing: {
      purchaseRate: rate,
      packetsPerKg,
      rawCost,
      packagingCost,
      transportCost,
      otherCost,
      wastageCost,
      spreadWastage: !!s.spreadWastage
    },
    costPerPacket: rawCost + packagingCost + transportCost + otherCost + wastageCost
  };
};

// Work out the costing of one ready-stock batch from its raw batch, machine run and product setting
const costForReadyStock = async (readyStock) => {
  const [stock, run, setting] = await Promise.all([
    readyStock.stockBatchId ? Stock.findOne({ batchId: readyStock.stockBatchId }) : null,
    readyStock.machineRunId ? MachineRun.findById(readyStock.machineRunId) : null,
    findSetting(readyStock.productType, readyStock.packetSizeGrams)
  ]);
  const result = calcTheliCost({
    purchaseRate: stock ? stock.purchaseRate : 0,
    batchCosts: await batchCostsOf(stock),
    packetSizeGrams: readyStock.packetSizeGrams,
    rawConsumedKg: run ? run.actualRawConsumed : 0,
    totalPackets: readyStock.totalPackets,
    setting
  });
  return { ...result, setting, stock };
};

// Recalculate and save a ready-stock batch's cost; shop stock from it follows.
// Sales already made keep the cost they were sold at.
const recalcReadyStock = async (readyStock) => {
  const { costing, costPerPacket } = await costForReadyStock(readyStock);
  readyStock.costing = costing;
  readyStock.costPerPacket = costPerPacket;
  await readyStock.save();
  await ShopStock.updateMany({ readyStockId: readyStock._id }, { costPerPacket });
  return readyStock;
};

// Batches whose theli are still unsold (in packaging godown or at a shop)
const unsoldReadyStockIds = async (filter = {}) => {
  const inGodown = await ReadyStock.find({ ...filter, availablePackets: { $gt: 0 } }).select('_id');
  const atShop = await ShopStock.find({ availablePackets: { $gt: 0 } }).distinct('readyStockId');
  const ids = new Set(inGodown.map(r => String(r._id)));
  atShop.forEach(id => id && ids.add(String(id)));
  return ReadyStock.find({ ...filter, _id: { $in: [...ids] } });
};

module.exports = { findSetting, batchCostsOf, calcTheliCost, costForReadyStock, recalcReadyStock, unsoldReadyStockIds };
