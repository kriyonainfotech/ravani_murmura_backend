const ProductSetting = require('../models/ProductSetting');
const Stock = require('../models/Stock');
const Purchase = require('../models/Purchase');
const MachineRun = require('../models/MachineRun');
const ReadyStock = require('../models/ReadyStock');
const ShopStock = require('../models/ShopStock');

// Product setting for a packed product (exact packet size first, then any size)
const findSetting = async (productType, packetSizeGrams) => {
  if (!productType) return null;
  const pName = String(productType).trim();
  const reg = new RegExp(`^${pName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  if (packetSizeGrams) {
    const exact = await ProductSetting.findOne({ productName: reg, packetSizeGrams: Number(packetSizeGrams) });
    if (exact) return exact;
  }
  return ProductSetting.findOne({ productName: reg });
};

// Packaging / transport / other cost entered on the purchase of a raw batch
const batchCostsOf = async (stock) => {
  const purchase = stock && stock.purchaseId ? await Purchase.findById(stock.purchaseId._id || stock.purchaseId) : null;
  return {
    costingUnit: (purchase && purchase.costingUnit) || (stock && stock.costingUnit) || 'theli',
    packagingCost: purchase ? purchase.packagingCost : 0,
    transportCost: purchase ? purchase.transportCost : 0,
    otherCost: purchase ? purchase.otherCost : 0
  };
};

// Cost calculated primarily on KG and Gram basis, and derived for Theli (packets):
// Cost per KG = raw rate (₹/KG) + packaging cost/KG + transport cost/KG + other cost/KG + wastage cost/KG.
// Cost per Gram = Cost per KG / 1000.
// Cost per Packet (Theli) = Cost per KG / packetsPerKg (or Cost per KG * (packetSizeGrams / 1000)).
const calcTheliCost = ({ purchaseRate, batchCosts, packetSizeGrams, rawConsumedKg, totalPackets, setting }) => {
  const s = setting || {};
  const b = batchCosts || {};
  const costingUnit = b.costingUnit || 'theli';
  const rate = Number(purchaseRate) || 0; // ₹ per KG
  const packetGrams = Number(packetSizeGrams) || 0;
  const packetsPerKg = Number(s.packetsPerKg) || (packetGrams > 0 ? 1000 / packetGrams : 0);
  
  const rawPackagingCost = Number(b.packagingCost) || 0;
  const rawTransportCost = Number(b.transportCost) || 0;
  const rawOtherCost = Number(b.otherCost) || 0;

  // Normalize extra costs to a PER KG basis
  let packagingCostPerKg = rawPackagingCost;
  let transportCostPerKg = rawTransportCost;
  let otherCostPerKg = rawOtherCost;

  if (costingUnit === 'theli') {
    packagingCostPerKg = packetsPerKg > 0 ? rawPackagingCost * packetsPerKg : rawPackagingCost;
    transportCostPerKg = packetsPerKg > 0 ? rawTransportCost * packetsPerKg : rawTransportCost;
    otherCostPerKg = packetsPerKg > 0 ? rawOtherCost * packetsPerKg : rawOtherCost;
  } else if (costingUnit === 'gram') {
    packagingCostPerKg = rawPackagingCost * 1000;
    transportCostPerKg = rawTransportCost * 1000;
    otherCostPerKg = rawOtherCost * 1000;
  } else {
    // Already in ₹/KG
    packagingCostPerKg = rawPackagingCost;
    transportCostPerKg = rawTransportCost;
    otherCostPerKg = rawOtherCost;
  }

  // Raw material that went into machine but was lost
  let wastageCostPerKg = 0;
  const readyWeightKg = (Number(totalPackets) || 0) * (packetGrams / 1000);
  if (s.spreadWastage && readyWeightKg > 0 && Number(rawConsumedKg) > 0) {
    const rawCostTotal = Number(rawConsumedKg) * rate;
    const stdCostTotal = readyWeightKg * rate;
    if (rawCostTotal > stdCostTotal) {
      wastageCostPerKg = (rawCostTotal - stdCostTotal) / readyWeightKg;
    }
  }

  // Native per KG cost
  const costPerKg = rate + packagingCostPerKg + transportCostPerKg + otherCostPerKg + wastageCostPerKg;
  // Native per Gram cost
  const costPerGram = costPerKg / 1000;
  // Derived per Packet (Theli) cost
  const costPerPacket = packetsPerKg > 0 ? costPerKg / packetsPerKg : (packetGrams > 0 ? (costPerKg * packetGrams) / 1000 : 0);

  // Per packet breakdown for compatibility
  const rawCost = packetsPerKg > 0 ? rate / packetsPerKg : (packetGrams > 0 ? (rate * packetGrams) / 1000 : 0);
  const packagingCost = packetsPerKg > 0 ? packagingCostPerKg / packetsPerKg : 0;
  const transportCost = packetsPerKg > 0 ? transportCostPerKg / packetsPerKg : 0;
  const otherCost = packetsPerKg > 0 ? otherCostPerKg / packetsPerKg : 0;
  const wastageCost = packetsPerKg > 0 ? wastageCostPerKg / packetsPerKg : 0;

  return {
    costing: {
      purchaseRate: rate,
      packetsPerKg,
      costPerKg,
      costPerGram,
      costPerPacket,
      rawCost,
      packagingCost,
      transportCost,
      otherCost,
      wastageCost,
      packagingCostPerKg,
      transportCostPerKg,
      otherCostPerKg,
      wastageCostPerKg,
      spreadWastage: !!s.spreadWastage,
      costingUnit,
      unitPackagingCost: rawPackagingCost,
      unitTransportCost: rawTransportCost,
      unitOtherCost: rawOtherCost
    },
    costPerKg,
    costPerGram,
    costPerPacket
  };
};

// Work out the costing of one ready-stock batch from its raw batch, machine run and product setting
const costForReadyStock = async (readyStock) => {
  const [stock, run, setting] = await Promise.all([
    readyStock.stockBatchId ? Stock.findOne({ batchId: readyStock.stockBatchId }) : null,
    readyStock.machineRunId ? MachineRun.findById(readyStock.machineRunId) : null,
    findSetting(readyStock.productType, readyStock.packetSizeGrams)
  ]);
  const batchCosts = await batchCostsOf(stock);
  if (readyStock.costingUnit) {
    batchCosts.costingUnit = readyStock.costingUnit;
  }
  const result = calcTheliCost({
    purchaseRate: stock ? stock.purchaseRate : 0,
    batchCosts,
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
  const { costing, costPerPacket, costPerKg, costPerGram } = await costForReadyStock(readyStock);
  readyStock.costing = costing;
  readyStock.costPerPacket = costPerPacket;
  readyStock.costPerKg = costPerKg;
  readyStock.costPerGram = costPerGram;
  if (!readyStock.costingUnit && costing.costingUnit) {
    readyStock.costingUnit = costing.costingUnit;
  }
  await readyStock.save();
  await ShopStock.updateMany({ readyStockId: readyStock._id }, { 
    costPerPacket,
    costPerKg,
    costPerGram,
    costingUnit: readyStock.costingUnit || costing.costingUnit || 'theli'
  });
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
