const Driver = require('../models/Driver');
const Purchase = require('../models/Purchase');
const PackagingRequest = require('../models/PackagingRequest');
const PackagingDispatch = require('../models/PackagingDispatch');

// Helper to calculate freight amount from weight, rate, and unit
const calcFreight = (weightKg, rate, unit) => {
  const w = Number(weightKg) || 0;
  const r = Number(rate) || 0;
  if (w <= 0 || r <= 0) return 0;
  if (unit === 'paise') {
    return Math.round((w * r / 100) * 100) / 100;
  }
  return Math.round((w * r) * 100) / 100;
};

// Get all drivers with ledger summaries
exports.getDrivers = async (req, res) => {
  try {
    const drivers = await Driver.find().sort({ createdAt: -1 }).lean();
    const purchases = await Purchase.find({
      $or: [
        { driverId: { $ne: null } },
        { driverName: { $exists: true, $ne: '' } }
      ]
    }).lean();
    const dispatches = await PackagingDispatch.find({
      $or: [
        { driverId: { $ne: null } },
        { driverName: { $exists: true, $ne: '' } }
      ]
    }).lean();
    const pkgRequests = await PackagingRequest.find({
      $or: [
        { driverId: { $ne: null } },
        { driverName: { $exists: true, $ne: '' } }
      ]
    }).lean();

    const driverSummaries = drivers.map(d => {
      const dIdStr = d._id.toString();
      const dNameClean = (d.name || '').trim().toLowerCase();

      // Find all purchases handled by this driver
      const driverPurchases = purchases.filter(p => {
        if (p.driverId && p.driverId.toString() === dIdStr) return true;
        if (p.driverName && p.driverName.trim().toLowerCase() === dNameClean) return true;
        return false;
      });

      // Find all store dispatches handled by this driver
      const driverDispatches = dispatches.filter(dp => {
        if (dp.driverId && dp.driverId.toString() === dIdStr) return true;
        if (dp.driverName && dp.driverName.trim().toLowerCase() === dNameClean) return true;
        return false;
      });

      // Find all raw stock transfers to packaging handled by this driver
      const driverRequests = pkgRequests.filter(r => {
        if (r.driverId && r.driverId.toString() === dIdStr) return true;
        if (r.driverName && r.driverName.trim().toLowerCase() === dNameClean) return true;
        return false;
      });

      let totalWeightKg = 0;
      let totalFreight = 0;
      let totalTripAdvances = 0;

      driverPurchases.forEach(p => {
        const wt = p.receivedQuantity != null ? Number(p.receivedQuantity) : Number(p.quantity) || 0;
        totalWeightKg += wt;

        let freight = 0;
        if (p.driverFreightTotal != null && p.driverFreightTotal > 0) {
          freight = Number(p.driverFreightTotal);
        } else if (p.driverRatePerKg && p.driverRatePerKg > 0) {
          freight = calcFreight(wt, p.driverRatePerKg, p.driverRateUnit || 'rupee');
        } else if (p.transportCost && p.transportCost > 0) {
          freight = Number(p.transportCost);
        }
        totalFreight += freight;
        totalTripAdvances += Number(p.driverAdvance) || 0;
      });

      driverDispatches.forEach(dp => {
        const wt = Number(dp.weightToDispatchKg) || 0;
        totalWeightKg += wt;

        let freight = 0;
        if (dp.driverFreightTotal != null && dp.driverFreightTotal > 0) {
          freight = Number(dp.driverFreightTotal);
        } else if (dp.driverRatePerKg && dp.driverRatePerKg > 0) {
          freight = calcFreight(wt, dp.driverRatePerKg, dp.driverRateUnit || 'rupee');
        } else if (d.defaultRatePerKg && d.defaultRatePerKg > 0) {
          freight = calcFreight(wt, d.defaultRatePerKg, d.rateUnit || 'rupee');
        }
        totalFreight += freight;
        totalTripAdvances += Number(dp.driverAdvance) || 0;
      });

      driverRequests.forEach(r => {
        const wt = Number(r.sentQuantity) || 0;
        totalWeightKg += wt;

        let freight = 0;
        if (r.driverFreightTotal != null && r.driverFreightTotal > 0) {
          freight = Number(r.driverFreightTotal);
        } else if (r.driverRatePerKg && r.driverRatePerKg > 0) {
          freight = calcFreight(wt, r.driverRatePerKg, r.driverRateUnit || 'rupee');
        } else if (d.defaultRatePerKg && d.defaultRatePerKg > 0) {
          freight = calcFreight(wt, d.defaultRatePerKg, d.rateUnit || 'rupee');
        }
        totalFreight += freight;
        totalTripAdvances += Number(r.driverAdvance) || 0;
      });

      const totalDirectAdvances = (d.advances || []).reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
      const totalAdvance = totalTripAdvances + totalDirectAdvances;
      const balanceDue = Math.round((totalFreight - totalAdvance) * 100) / 100;

      return {
        ...d,
        totalTrips: driverPurchases.length + driverDispatches.length + driverRequests.length,
        totalWeightKg: Math.round(totalWeightKg * 100) / 100,
        totalFreight: Math.round(totalFreight * 100) / 100,
        totalAdvance: Math.round(totalAdvance * 100) / 100,
        balanceDue: balanceDue
      };
    });

    res.status(200).json(driverSummaries);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching drivers', error: error.message });
  }
};

// Get single driver with complete trip history and advance ledger
exports.getDriverLedger = async (req, res) => {
  try {
    const { id } = req.params;
    const driver = await Driver.findById(id).lean();
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const dIdStr = driver._id.toString();
    const dNameClean = (driver.name || '').trim().toLowerCase();

    // 1. Fetch Purchase trips
    const purchases = await Purchase.find({
      $or: [
        { driverId: driver._id },
        { driverName: new RegExp(`^${driver.name.trim()}$`, 'i') }
      ]
    }).sort({ purchaseDate: -1, createdAt: -1 }).lean();

    const trips = purchases.map(p => {
      const wt = p.receivedQuantity != null ? Number(p.receivedQuantity) : Number(p.quantity) || 0;
      let freight = 0;
      if (p.driverFreightTotal != null && p.driverFreightTotal > 0) {
        freight = Number(p.driverFreightTotal);
      } else if (p.driverRatePerKg && p.driverRatePerKg > 0) {
        freight = calcFreight(wt, p.driverRatePerKg, p.driverRateUnit || 'rupee');
      } else if (p.transportCost && p.transportCost > 0) {
        freight = Number(p.transportCost);
      }

      const adv = Number(p.driverAdvance) || 0;
      return {
        _id: `purchase_${p._id}`,
        dbId: p._id,
        tripType: 'Purchase',
        refId: p.purchaseId,
        billNumber: p.billNumber || '',
        date: p.purchaseDate,
        party: p.supplier,
        item: p.item,
        weightKg: wt,
        ratePerKg: p.driverRatePerKg || (driver.defaultRatePerKg || 0),
        rateUnit: p.driverRateUnit || (driver.rateUnit || 'rupee'),
        freightAmount: Math.round(freight * 100) / 100,
        advancePaid: adv,
        balance: Math.round((freight - adv) * 100) / 100,
        status: p.status,
        dbId: p._id
      };
    });

    // 2. Fetch Packaging Request trips (Raw material transfers to packaging)
    const pkgRequests = await PackagingRequest.find({
      $or: [
        { driverId: driver._id },
        { driverName: new RegExp(`^${driver.name.trim()}$`, 'i') }
      ]
    }).populate('targetPanelId', 'name location').sort({ dispatchedAt: -1 }).lean();

    const pkgRequestTrips = pkgRequests.map(r => {
      const wt = Number(r.sentQuantity) || 0;
      let freight = 0;
      if (r.driverFreightTotal != null && r.driverFreightTotal > 0) {
        freight = Number(r.driverFreightTotal);
      } else if (r.driverRatePerKg && r.driverRatePerKg > 0) {
        freight = calcFreight(wt, r.driverRatePerKg, r.driverRateUnit || 'rupee');
      } else {
        freight = calcFreight(wt, driver.defaultRatePerKg || 0, driver.rateUnit || 'rupee');
      }
      const adv = Number(r.driverAdvance) || 0;
      const destination = r.targetPanelId?.name ? `${r.targetPanelId.name} (Packaging)` : 'Packaging Godown';
      const rollsText = r.packagingRollQuantity ? `, ${r.packagingRollQuantity} rolls` : '';

      return {
        _id: `pkgreq_${r._id}`,
        dbId: r._id,
        tripType: 'Raw Transfer',
        refId: r.requestId,
        billNumber: '',
        date: r.dispatchedAt || r.createdAt,
        party: destination,
        item: `${r.productName || 'Raw Material'} (${wt} KG${rollsText})`,
        weightKg: wt,
        ratePerKg: r.driverRatePerKg != null && r.driverRatePerKg > 0 ? r.driverRatePerKg : (driver.defaultRatePerKg || 0),
        rateUnit: r.driverRateUnit || (driver.rateUnit || 'rupee'),
        freightAmount: Math.round(freight * 100) / 100,
        advancePaid: adv,
        balance: Math.round((freight - adv) * 100) / 100,
        status: r.status,
        dbId: r._id
      };
    });

    // 3. Fetch Packaging Dispatch trips (Finished goods to stores)
    const pkgDispatches = await PackagingDispatch.find({
      $or: [
        { driverId: driver._id },
        { driverName: new RegExp(`^${driver.name.trim()}$`, 'i') }
      ]
    }).sort({ dispatchedAt: -1 }).lean();

    const pkgDispatchTrips = pkgDispatches.map(d => {
      const wt = Number(d.weightToDispatchKg) || 0;
      let freight = 0;
      if (d.driverFreightTotal != null && d.driverFreightTotal > 0) {
        freight = Number(d.driverFreightTotal);
      } else if (d.driverRatePerKg && d.driverRatePerKg > 0) {
        freight = calcFreight(wt, d.driverRatePerKg, d.driverRateUnit || 'rupee');
      } else {
        freight = calcFreight(wt, driver.defaultRatePerKg || 0, driver.rateUnit || 'rupee');
      }
      return {
        _id: `dispatch_${d._id}`,
        dbId: d._id,
        tripType: 'Dispatch to Store',
        refId: d.dispatchId,
        billNumber: '',
        date: d.dispatchedAt || d.createdAt,
        party: d.destinationStore,
        item: `${d.productType} (${d.packetsToDispatch} theli)`,
        weightKg: wt,
        ratePerKg: d.driverRatePerKg != null && d.driverRatePerKg > 0 ? d.driverRatePerKg : (driver.defaultRatePerKg || 0),
        rateUnit: d.driverRateUnit || (driver.rateUnit || 'rupee'),
        freightAmount: Math.round(freight * 100) / 100,
        advancePaid: 0,
        balance: Math.round(freight * 100) / 100,
        status: d.status,
        dbId: d._id
      };
    });

    const allTrips = [...trips, ...pkgRequestTrips, ...pkgDispatchTrips].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate overall summaries
    const totalWeightKg = allTrips.reduce((acc, t) => acc + (Number(t.weightKg) || 0), 0);
    const totalFreight = allTrips.reduce((acc, t) => acc + (Number(t.freightAmount) || 0), 0);
    const totalTripAdvances = allTrips.reduce((acc, t) => acc + (Number(t.advancePaid) || 0), 0);
    const totalDirectAdvances = (driver.advances || []).reduce((acc, a) => acc + (Number(a.amount) || 0), 0);
    const totalAdvance = totalTripAdvances + totalDirectAdvances;
    const balanceDue = Math.round((totalFreight - totalAdvance) * 100) / 100;

    // Combine all advance/payroll entries (both direct cash/bank advances and trip advances)
    const tripAdvanceEntries = trips
      .filter(t => Number(t.advancePaid) > 0)
      .map(t => ({
        _id: `trip_adv_${t.dbId}`,
        amount: Number(t.advancePaid),
        date: t.date,
        paymentMode: 'Trip Advance',
        paidFrom: 'Purchase Bill',
        reference: t.refId,
        notes: `Advance given on trip ${t.refId} (${t.party || 'Supplier'})`,
        givenBy: 'Purchase Entry',
        isTripAdvance: true
      }));

    const pkgTripAdvances = pkgRequestTrips
      .filter(t => Number(t.advancePaid) > 0)
      .map(t => ({
        _id: `trip_adv_pkg_${t.dbId}`,
        amount: Number(t.advancePaid),
        date: t.date,
        paymentMode: 'Trip Advance',
        paidFrom: 'Stock Transfer',
        reference: t.refId,
        notes: `Advance given on raw transfer ${t.refId} (${t.party || 'Packaging'})`,
        givenBy: 'Stock Dispatch',
        isTripAdvance: true
      }));

    const directAdvanceEntries = (driver.advances || []).map(a => ({
      _id: a._id,
      amount: a.amount,
      date: a.date,
      paymentMode: a.paymentMode || 'Cash',
      paidFrom: a.paidFrom || 'Cash in Hand',
      reference: a.reference || '',
      notes: a.notes || '',
      givenBy: a.givenBy || 'Admin',
      isTripAdvance: false
    }));

    const allAdvances = [...directAdvanceEntries, ...tripAdvanceEntries, ...pkgTripAdvances].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.status(200).json({
      driver,
      trips: allTrips,
      advances: allAdvances,
      summary: {
        totalTrips: allTrips.length,
        totalWeightKg: Math.round(totalWeightKg * 100) / 100,
        totalFreight: Math.round(totalFreight * 100) / 100,
        totalTripAdvances: Math.round(totalTripAdvances * 100) / 100,
        totalDirectAdvances: Math.round(totalDirectAdvances * 100) / 100,
        totalAdvance: Math.round(totalAdvance * 100) / 100,
        balanceDue: balanceDue
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching driver ledger', error: error.message });
  }
};

// Create a new driver
exports.createDriver = async (req, res) => {
  try {
    const { name, phone, vehicleNumber, vehicleType, defaultRatePerKg, rateUnit, status, notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Driver name is required' });
    }

    const newDriver = new Driver({
      name: name.trim(),
      phone: phone ? phone.trim() : '',
      vehicleNumber: vehicleNumber ? vehicleNumber.trim().toUpperCase() : '',
      vehicleType: vehicleType || 'Tempo',
      defaultRatePerKg: Number(defaultRatePerKg) || 0,
      rateUnit: rateUnit === 'paise' ? 'paise' : 'rupee',
      status: status || 'Active',
      notes: notes || '',
      createdBy: req.user?.name || 'Super Admin'
    });

    const savedDriver = await newDriver.save();
    res.status(201).json(savedDriver);
  } catch (error) {
    res.status(500).json({ message: 'Error creating driver', error: error.message });
  }
};

// Update an existing driver
exports.updateDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    if (updates.name !== undefined) updates.name = updates.name.trim();
    if (updates.phone !== undefined) updates.phone = updates.phone.trim();
    if (updates.vehicleNumber !== undefined) updates.vehicleNumber = updates.vehicleNumber.trim().toUpperCase();
    if (updates.defaultRatePerKg !== undefined) updates.defaultRatePerKg = Number(updates.defaultRatePerKg) || 0;
    if (updates.rateUnit !== undefined) updates.rateUnit = updates.rateUnit === 'paise' ? 'paise' : 'rupee';

    const updated = await Driver.findByIdAndUpdate(id, updates, { new: true });
    if (!updated) {
      return res.status(404).json({ message: 'Driver not found' });
    }
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Error updating driver', error: error.message });
  }
};

// Delete driver
exports.deleteDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Driver.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: 'Driver not found' });
    }
    res.status(200).json({ message: 'Driver deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting driver', error: error.message });
  }
};

// Add advance payment to driver
exports.addAdvance = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, date, paymentMode, paidFrom, reference, notes } = req.body;
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
      return res.status(400).json({ message: 'Valid advance amount is required' });
    }

    const driver = await Driver.findById(id);
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const newAdvance = {
      amount: numAmount,
      date: date ? new Date(date) : new Date(),
      paymentMode: paymentMode || 'Cash',
      paidFrom: paidFrom || 'Cash in Hand',
      reference: reference || '',
      notes: notes || '',
      givenBy: req.user?.name || 'Super Admin',
      createdAt: new Date()
    };

    driver.advances.push(newAdvance);
    await driver.save();

    res.status(200).json({ message: 'Advance recorded successfully', driver });
  } catch (error) {
    res.status(500).json({ message: 'Error recording advance', error: error.message });
  }
};

// Delete advance payment from driver
exports.deleteAdvance = async (req, res) => {
  try {
    const { id, advanceId } = req.params;
    const driver = await Driver.findById(id);
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    driver.advances = driver.advances.filter(a => a._id.toString() !== advanceId);
    await driver.save();

    res.status(200).json({ message: 'Advance removed successfully', driver });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting advance', error: error.message });
  }
};

// Get all driver activity: All feras (trips) and all advance entries across all drivers
exports.getAllDriverActivity = async (req, res) => {
  try {
    const drivers = await Driver.find().sort({ createdAt: -1 }).lean();
    const driverMap = {};
    drivers.forEach(d => {
      driverMap[d._id.toString()] = d;
      if (d.name) driverMap[d.name.toLowerCase().trim()] = d;
    });

    const purchases = await Purchase.find({
      $or: [
        { driverId: { $ne: null } },
        { driverName: { $exists: true, $ne: '' } }
      ]
    }).sort({ purchaseDate: -1, createdAt: -1 }).lean();

    const dispatches = await PackagingDispatch.find({
      $or: [
        { driverId: { $ne: null } },
        { driverName: { $exists: true, $ne: '' } }
      ]
    }).sort({ dispatchedAt: -1, createdAt: -1 }).lean();

    const pkgRequests = await PackagingRequest.find({
      $or: [
        { driverId: { $ne: null } },
        { driverName: { $exists: true, $ne: '' } }
      ]
    }).populate('targetPanelId', 'name location').sort({ dispatchedAt: -1, createdAt: -1 }).lean();

    // 1. Map Purchase trips
    const purchaseTrips = purchases.map(p => {
      const dObj = p.driverId ? driverMap[p.driverId.toString()] : (p.driverName ? driverMap[p.driverName.toLowerCase().trim()] : null);
      const wt = p.receivedQuantity != null ? Number(p.receivedQuantity) : Number(p.quantity) || 0;
      let freight = 0;
      if (p.driverFreightTotal != null && p.driverFreightTotal > 0) {
        freight = Number(p.driverFreightTotal);
      } else if (p.driverRatePerKg && p.driverRatePerKg > 0) {
        freight = calcFreight(wt, p.driverRatePerKg, p.driverRateUnit || 'rupee');
      } else if (p.transportCost && p.transportCost > 0) {
        freight = Number(p.transportCost);
      } else if (dObj && dObj.defaultRatePerKg) {
        freight = calcFreight(wt, dObj.defaultRatePerKg, dObj.rateUnit || 'rupee');
      }
      return {
        _id: `purchase_${p._id}`,
        tripType: 'Purchase',
        refId: p.purchaseId,
        billNumber: p.billNumber || '',
        date: p.purchaseDate || p.createdAt,
        driverId: p.driverId || (dObj ? dObj._id : null),
        driverName: p.driverName || (dObj ? dObj.name : 'Tempo Driver'),
        tempoNumber: p.tempoNumber || (dObj ? dObj.vehicleNumber : ''),
        party: p.supplier,
        item: p.item,
        weightKg: wt,
        ratePerKg: p.driverRatePerKg || (dObj ? dObj.defaultRatePerKg : 0),
        rateUnit: p.driverRateUnit || (dObj ? dObj.rateUnit : 'rupee'),
        freightAmount: Math.round(freight * 100) / 100,
        advancePaid: Number(p.driverAdvance) || 0,
        balance: Math.round((freight - (Number(p.driverAdvance) || 0)) * 100) / 100,
        status: p.status || 'Completed'
      };
    });

    // 2. Map Store Dispatches
    const dispatchTrips = dispatches.map(d => {
      const dObj = d.driverId ? driverMap[d.driverId.toString()] : (d.driverName ? driverMap[d.driverName.toLowerCase().trim()] : null);
      const wt = Number(d.weightToDispatchKg) || 0;
      let freight = 0;
      if (d.driverFreightTotal != null && d.driverFreightTotal > 0) {
        freight = Number(d.driverFreightTotal);
      } else if (d.driverRatePerKg && d.driverRatePerKg > 0) {
        freight = calcFreight(wt, d.driverRatePerKg, d.driverRateUnit || 'rupee');
      } else if (dObj && dObj.defaultRatePerKg) {
        freight = calcFreight(wt, dObj.defaultRatePerKg, dObj.rateUnit || 'rupee');
      }
      return {
        _id: `dispatch_${d._id}`,
        tripType: 'Store Dispatch',
        refId: d.dispatchId,
        billNumber: '',
        date: d.dispatchedAt || d.createdAt,
        driverId: d.driverId || (dObj ? dObj._id : null),
        driverName: d.driverName || (dObj ? dObj.name : 'Tempo Driver'),
        tempoNumber: d.tempoNumberPlate || (dObj ? dObj.vehicleNumber : ''),
        party: d.destinationStore,
        item: `${d.productType} (${d.packetsToDispatch} theli)`,
        weightKg: wt,
        ratePerKg: d.driverRatePerKg || (dObj ? dObj.defaultRatePerKg : 0),
        rateUnit: d.driverRateUnit || (dObj ? dObj.rateUnit : 'rupee'),
        freightAmount: Math.round(freight * 100) / 100,
        advancePaid: 0,
        balance: Math.round(freight * 100) / 100,
        status: d.status || 'DISPATCHED'
      };
    });

    // 3. Map Raw Transfers
    const requestTrips = pkgRequests.map(r => {
      const dObj = r.driverId ? driverMap[r.driverId.toString()] : (r.driverName ? driverMap[r.driverName.toLowerCase().trim()] : null);
      const wt = Number(r.sentQuantity) || 0;
      let freight = 0;
      if (r.driverFreightTotal != null && r.driverFreightTotal > 0) {
        freight = Number(r.driverFreightTotal);
      } else if (r.driverRatePerKg && r.driverRatePerKg > 0) {
        freight = calcFreight(wt, r.driverRatePerKg, r.driverRateUnit || 'rupee');
      } else if (dObj && dObj.defaultRatePerKg) {
        freight = calcFreight(wt, dObj.defaultRatePerKg, dObj.rateUnit || 'rupee');
      }
      const adv = Number(r.driverAdvance) || 0;
      const destination = r.targetPanelId?.name ? `${r.targetPanelId.name} (Packaging)` : 'Packaging Godown';
      const rollsText = r.packagingRollQuantity ? `, ${r.packagingRollQuantity} rolls` : '';

      return {
        _id: `pkgreq_${r._id}`,
        tripType: 'Raw Transfer',
        refId: r.requestId,
        billNumber: '',
        date: r.dispatchedAt || r.createdAt,
        driverId: r.driverId || (dObj ? dObj._id : null),
        driverName: r.driverName || (dObj ? dObj.name : 'Tempo Driver'),
        tempoNumber: r.tempoNumberPlate || (dObj ? dObj.vehicleNumber : ''),
        party: destination,
        item: `${r.productName || 'Raw Material'} (${wt} KG${rollsText})`,
        weightKg: wt,
        ratePerKg: r.driverRatePerKg || (dObj ? dObj.defaultRatePerKg : 0),
        rateUnit: r.driverRateUnit || (dObj ? dObj.rateUnit : 'rupee'),
        freightAmount: Math.round(freight * 100) / 100,
        advancePaid: adv,
        balance: Math.round((freight - adv) * 100) / 100,
        status: r.status || 'DISPATCHED'
      };
    });

    const allTrips = [...purchaseTrips, ...dispatchTrips, ...requestTrips].sort((a, b) => new Date(b.date) - new Date(a.date));

    // 4. Map all advance entries
    const directAdvances = [];
    drivers.forEach(d => {
      (d.advances || []).forEach(a => {
        directAdvances.push({
          _id: a._id,
          driverId: d._id,
          driverName: d.name,
          tempoNumber: d.vehicleNumber || '',
          amount: Number(a.amount) || 0,
          date: a.date,
          paymentMode: a.paymentMode || 'Cash',
          paidFrom: a.paidFrom || 'Cash in Hand',
          reference: a.reference || '',
          notes: a.notes || '',
          givenBy: a.givenBy || 'Admin',
          isTripAdvance: false
        });
      });
    });

    const tripAdvances = purchaseTrips
      .filter(t => t.advancePaid > 0)
      .map(t => ({
        _id: `trip_adv_${t._id}`,
        driverId: t.driverId,
        driverName: t.driverName,
        tempoNumber: t.tempoNumber || '',
        amount: t.advancePaid,
        date: t.date,
        paymentMode: 'Trip Advance',
        paidFrom: 'Purchase Bill',
        reference: t.refId,
        notes: `Advance given on purchase ${t.refId} (${t.party || ''})`,
        givenBy: 'Purchase',
        isTripAdvance: true
      }));

    const pkgTripAdvances = requestTrips
      .filter(t => t.advancePaid > 0)
      .map(t => ({
        _id: `trip_adv_pkg_${t._id}`,
        driverId: t.driverId,
        driverName: t.driverName,
        tempoNumber: t.tempoNumber || '',
        amount: t.advancePaid,
        date: t.date,
        paymentMode: 'Trip Advance',
        paidFrom: 'Stock Transfer',
        reference: t.refId,
        notes: `Advance given on raw transfer ${t.refId} (${t.party || ''})`,
        givenBy: 'Stock Dispatch',
        isTripAdvance: true
      }));

    const allAdvances = [...directAdvances, ...tripAdvances, ...pkgTripAdvances].sort((a, b) => new Date(b.date) - new Date(a.date));

    const totalWeightKg = allTrips.reduce((sum, t) => sum + (Number(t.weightKg) || 0), 0);
    const totalFreight = allTrips.reduce((sum, t) => sum + (Number(t.freightAmount) || 0), 0);
    const totalAdvance = allAdvances.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
    const netBalanceDue = Math.round((totalFreight - totalAdvance) * 100) / 100;

    res.status(200).json({
      trips: allTrips,
      advances: allAdvances,
      summary: {
        totalDrivers: drivers.length,
        totalFeras: allTrips.length,
        totalWeightKg: Math.round(totalWeightKg * 100) / 100,
        totalFreight: Math.round(totalFreight * 100) / 100,
        totalAdvance: Math.round(totalAdvance * 100) / 100,
        netBalanceDue: netBalanceDue
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching driver activity', error: error.message });
  }
};

// Remove / Delete a Fera Trip from a driver (unlinks driver and freight from the trip)
exports.deleteTrip = async (req, res) => {
  try {
    const { tripId } = req.params;
    if (!tripId) {
      return res.status(400).json({ message: 'Trip ID is required' });
    }

    if (tripId.startsWith('purchase_')) {
      const rawId = tripId.replace('purchase_', '');
      const p = await Purchase.findById(rawId);
      if (p) {
        p.driverId = null;
        p.driverName = '';
        p.driverMobileNumber = '';
        p.tempoNumber = '';
        p.driverRatePerKg = 0;
        p.driverFreightTotal = 0;
        p.driverAdvance = 0;
        p.transportCost = 0;
        await p.save();
      }
    } else if (tripId.startsWith('dispatch_')) {
      const rawId = tripId.replace('dispatch_', '');
      const d = await PackagingDispatch.findById(rawId);
      if (d) {
        d.driverId = null;
        d.driverName = '';
        d.driverMobileNumber = '';
        d.tempoNumberPlate = '';
        d.driverRatePerKg = 0;
        d.driverFreightTotal = 0;
        d.driverAdvance = 0;
        await d.save();
      }
    } else if (tripId.startsWith('pkgreq_')) {
      const rawId = tripId.replace('pkgreq_', '');
      const r = await PackagingRequest.findById(rawId);
      if (r) {
        r.driverId = null;
        r.driverName = '';
        r.driverMobileNumber = '';
        r.tempoNumberPlate = '';
        r.driverRatePerKg = 0;
        r.driverRateUnit = 'rupee';
        r.driverFreightTotal = 0;
        r.driverAdvance = 0;
        await r.save();
      }
    } else {
      // Fallback: try by id
      let p = await Purchase.findById(tripId);
      if (p) {
        p.driverId = null;
        p.driverName = '';
        p.driverRatePerKg = 0;
        p.driverFreightTotal = 0;
        p.driverAdvance = 0;
        p.transportCost = 0;
        await p.save();
      } else {
        let d = await PackagingDispatch.findById(tripId);
        if (d) {
          d.driverId = null;
          d.driverName = '';
          d.driverRatePerKg = 0;
          d.driverFreightTotal = 0;
          d.driverAdvance = 0;
          await d.save();
        } else {
          let r = await PackagingRequest.findById(tripId);
          if (r) {
            r.driverId = null;
            r.driverName = '';
            r.driverMobileNumber = '';
            r.tempoNumberPlate = '';
            r.driverRatePerKg = 0;
            r.driverRateUnit = 'rupee';
            r.driverFreightTotal = 0;
            r.driverAdvance = 0;
            await r.save();
          }
        }
      }
    }

    res.status(200).json({ message: 'Fera entry removed successfully' });
  } catch (error) {
    console.error('Error removing driver trip:', error);
    res.status(500).json({ message: 'Error removing trip entry', error: error.message });
  }
};
