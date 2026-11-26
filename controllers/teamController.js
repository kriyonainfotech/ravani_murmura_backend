const mongoose = require('mongoose');
const TeamMember = require('../models/TeamMember');
const Attendance = require('../models/Attendance');
const Advance = require('../models/Advance');
const Payroll = require('../models/Payroll');
const Expense = require('../models/Expense');
const { nextExpenseId } = require('../utils/finance');

// Helper to generate sequential IDs (TM-0001, ADV-0001, PAY-0001)
const generateNextId = async (Model, field, prefix) => {
  const last = await Model.findOne({ [field]: new RegExp(`^${prefix}`) }).sort({ createdAt: -1 });
  const lastNum = last ? parseInt(last[field].replace(prefix, ''), 10) : 0;
  return `${prefix}${String((Number.isNaN(lastNum) ? 0 : lastNum) + 1).padStart(4, '0')}`;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Convert month string "2026-11" to month label "November 2026"
const formatMonthLabel = (monthStr) => {
  if (!monthStr || !monthStr.includes('-')) return '';
  const [y, m] = monthStr.split('-').map(Number);
  const date = new Date(y, m - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};

// Total calendar days in a month
const getDaysInMonth = (monthStr) => {
  if (!monthStr) return 30;
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};

// ==========================================
// 1. TEAM MEMBERS
// ==========================================

// Get all team members with optional search, filter, and computed stats
exports.getMembers = async (req, res) => {
  try {
    const { search, department, status } = req.query;
    const filter = {};

    if (status && status !== 'All') {
      filter.status = status;
    }
    if (department && department !== 'All') {
      filter.department = department;
    }
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { employeeId: { $regex: search, $options: 'i' } },
        { role: { $regex: search, $options: 'i' } }
      ];
    }

    const members = await TeamMember.find(filter).sort({ createdAt: -1 }).lean();

    // Compute active advances and this month's attendance for each member
    const currentMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    const memberIds = members.map(m => m._id);

    // Get pending advance totals per member
    const advances = await Advance.aggregate([
      { $match: { member: { $in: memberIds }, status: { $in: ['Pending', 'Partially Deducted'] } } },
      {
        $group: {
          _id: '$member',
          totalPending: { $sum: { $subtract: ['$amount', '$amountDeducted'] } },
          count: { $sum: 1 }
        }
      }
    ]);

    const advanceMap = {};
    advances.forEach(a => {
      advanceMap[a._id.toString()] = round2(a.totalPending);
    });

    // Get this month's attendance counts
    const attendanceAgg = await Attendance.aggregate([
      {
        $match: {
          member: { $in: memberIds },
          dateStr: { $regex: `^${currentMonth}` }
        }
      },
      {
        $group: {
          _id: '$member',
          presentDays: { $sum: '$dayValue' },
          totalLogs: { $sum: 1 }
        }
      }
    ]);

    const attendanceMap = {};
    attendanceAgg.forEach(att => {
      attendanceMap[att._id.toString()] = round2(att.presentDays);
    });

    const enrichedMembers = members.map(m => ({
      ...m,
      pendingAdvance: advanceMap[m._id.toString()] || 0,
      thisMonthAttendance: attendanceMap[m._id.toString()] || 0
    }));

    res.json({ success: true, members: enrichedMembers });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not fetch team members', error: err.message });
  }
};

// Create a new team member
exports.createMember = async (req, res) => {
  try {
    const { name, phone, role, department, salaryType, baseSalary, joiningDate, bankDetails, notes } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Employee name is required' });
    }

    let cleanPhone = '';
    if (phone && phone.trim()) {
      cleanPhone = phone.trim().replace(/\D/g, '');
      if (cleanPhone.length !== 10 || !/^[6-9]\d{9}$/.test(cleanPhone)) {
        return res.status(400).json({ success: false, message: 'Mobile number must be a valid 10-digit number (starting with 6, 7, 8, or 9)' });
      }
    }

    const employeeId = await generateNextId(TeamMember, 'employeeId', 'TM-');

    const member = new TeamMember({
      employeeId,
      name: name.trim(),
      phone: cleanPhone,
      role: role?.trim() || 'Worker',
      department: department?.trim() || 'General',
      salaryType: salaryType || 'Monthly',
      baseSalary: Number(baseSalary) || 0,
      joiningDate: joiningDate ? new Date(joiningDate) : new Date(),
      status: 'Active',
      bankDetails: bankDetails || {},
      notes: notes || '',
      createdBy: req.user?.name || 'Admin'
    });

    await member.save();
    res.status(201).json({ success: true, message: 'Team member added successfully', member });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error creating team member', error: err.message });
  }
};

// Update an existing team member
exports.updateMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, role, department, salaryType, baseSalary, joiningDate, status, bankDetails, notes } = req.body;

    const member = await TeamMember.findById(id);
    if (!member) {
      return res.status(404).json({ success: false, message: 'Team member not found' });
    }

    if (name) member.name = name.trim();
    if (phone !== undefined) {
      if (phone && phone.trim()) {
        const cleanPhone = phone.trim().replace(/\D/g, '');
        if (cleanPhone.length !== 10 || !/^[6-9]\d{9}$/.test(cleanPhone)) {
          return res.status(400).json({ success: false, message: 'Mobile number must be a valid 10-digit number (starting with 6, 7, 8, or 9)' });
        }
        member.phone = cleanPhone;
      } else {
        member.phone = '';
      }
    }
    if (role) member.role = role.trim();
    if (department) member.department = department.trim();
    if (salaryType) member.salaryType = salaryType;
    if (baseSalary !== undefined) member.baseSalary = Number(baseSalary) || 0;
    if (joiningDate) member.joiningDate = new Date(joiningDate);
    if (status) member.status = status;
    if (bankDetails) member.bankDetails = bankDetails;
    if (notes !== undefined) member.notes = notes;

    await member.save();
    res.json({ success: true, message: 'Team member updated successfully', member });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error updating team member', error: err.message });
  }
};

// Delete or toggle status of a member
exports.deleteMember = async (req, res) => {
  try {
    const { id } = req.params;
    const member = await TeamMember.findById(id);
    if (!member) {
      return res.status(404).json({ success: false, message: 'Team member not found' });
    }

    // Check if member has recorded attendance or advances
    const hasAttendance = await Attendance.exists({ member: id });
    const hasAdvance = await Advance.exists({ member: id });
    const hasPayroll = await Payroll.exists({ member: id });

    if (hasAttendance || hasAdvance || hasPayroll) {
      // Soft deactivate instead to keep financial records intact
      member.status = 'Inactive';
      await member.save();
      return res.json({ success: true, message: 'Member marked as Inactive to preserve attendance and payment records', member });
    }

    await TeamMember.findByIdAndDelete(id);
    res.json({ success: true, message: 'Team member deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error deleting team member', error: err.message });
  }
};

// ==========================================
// 2. ATTENDANCE
// ==========================================

// Get attendance for a specific date (dateStr: 'YYYY-MM-DD')
// Returns all active team members with their recorded attendance or default 'Present'
exports.getAttendanceByDate = async (req, res) => {
  try {
    const { dateStr } = req.query;
    if (!dateStr) {
      return res.status(400).json({ success: false, message: 'dateStr (YYYY-MM-DD) is required' });
    }

    const members = await TeamMember.find({ status: 'Active' }).sort({ name: 1 }).lean();
    const records = await Attendance.find({ dateStr }).lean();

    const recordMap = {};
    records.forEach(r => {
      recordMap[r.member.toString()] = r;
    });

    const attendanceList = members.map(m => {
      const rec = recordMap[m._id.toString()];
      return {
        memberId: m._id,
        employeeId: m.employeeId,
        name: m.name,
        role: m.role,
        department: m.department,
        salaryType: m.salaryType,
        baseSalary: m.baseSalary,
        status: rec ? rec.status : 'Present', // default to Present if not marked
        dayValue: rec ? rec.dayValue : 1.0,
        overtimeHours: rec ? rec.overtimeHours : 0,
        notes: rec ? rec.notes : '',
        isMarked: !!rec,
        recordId: rec ? rec._id : null
      };
    });

    // Summary counts for this date
    const summary = {
      total: attendanceList.length,
      present: attendanceList.filter(a => a.status === 'Present').length,
      halfDay: attendanceList.filter(a => a.status === 'Half Day').length,
      absent: attendanceList.filter(a => a.status === 'Absent').length,
      paidLeave: attendanceList.filter(a => a.status === 'Paid Leave').length
    };

    res.json({ success: true, dateStr, list: attendanceList, summary });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error loading attendance', error: err.message });
  }
};

// Bulk save or update attendance for a given date
exports.saveAttendanceBulk = async (req, res) => {
  try {
    const { dateStr, attendance } = req.body;
    if (!dateStr || !Array.isArray(attendance)) {
      return res.status(400).json({ success: false, message: 'dateStr and attendance array are required' });
    }

    const targetDate = new Date(`${dateStr}T12:00:00.000Z`);
    const createdBy = req.user?.name || 'Admin';

    const bulkOps = attendance.map(item => {
      let dayValue = 1.0;
      if (item.status === 'Half Day') dayValue = 0.5;
      else if (item.status === 'Absent') dayValue = 0.0;
      else if (item.status === 'Paid Leave') dayValue = 1.0;

      return {
        updateOne: {
          filter: { member: item.memberId, dateStr },
          update: {
            $set: {
              member: item.memberId,
              date: targetDate,
              dateStr,
              status: item.status || 'Present',
              dayValue,
              overtimeHours: Number(item.overtimeHours) || 0,
              notes: item.notes || '',
              createdBy
            }
          },
          upsert: true
        }
      };
    });

    if (bulkOps.length > 0) {
      await Attendance.bulkWrite(bulkOps);
    }

    res.json({ success: true, message: `Attendance saved for ${bulkOps.length} members on ${dateStr}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error saving attendance', error: err.message });
  }
};

// Get monthly attendance summary for all members
exports.getMonthlyAttendanceSummary = async (req, res) => {
  try {
    const { month } = req.query; // 'YYYY-MM'
    if (!month) {
      return res.status(400).json({ success: false, message: 'month query parameter is required (YYYY-MM)' });
    }

    const members = await TeamMember.find({ status: 'Active' }).sort({ name: 1 }).lean();
    const records = await Attendance.find({ dateStr: { $regex: `^${month}` } }).lean();

    const map = {};
    members.forEach(m => {
      map[m._id.toString()] = {
        member: m,
        present: 0,
        halfDay: 0,
        absent: 0,
        paidLeave: 0,
        totalDayValue: 0,
        overtimeHours: 0
      };
    });

    records.forEach(r => {
      const id = r.member.toString();
      if (map[id]) {
        if (r.status === 'Present') map[id].present += 1;
        else if (r.status === 'Half Day') map[id].halfDay += 1;
        else if (r.status === 'Absent') map[id].absent += 1;
        else if (r.status === 'Paid Leave') map[id].paidLeave += 1;

        map[id].totalDayValue += (r.dayValue || 0);
        map[id].overtimeHours += (r.overtimeHours || 0);
      }
    });

    const summaryList = Object.values(map);
    res.json({ success: true, month, daysInMonth: getDaysInMonth(month), list: summaryList });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error calculating monthly attendance', error: err.message });
  }
};

// Get monthly attendance details for a single member (for calendar view)
exports.getMemberMonthlyAttendance = async (req, res) => {
  try {
    const { memberId } = req.params;
    const { month } = req.query; // 'YYYY-MM'
    if (!memberId || !month) {
      return res.status(400).json({ success: false, message: 'memberId and month (YYYY-MM) are required' });
    }

    const member = await TeamMember.findById(memberId).lean();
    if (!member) {
      return res.status(404).json({ success: false, message: 'Team member not found' });
    }

    const records = await Attendance.find({
      member: memberId,
      dateStr: { $regex: `^${month}` }
    }).lean();

    const recordMap = {};
    let present = 0, halfDay = 0, absent = 0, paidLeave = 0, totalDayValue = 0, totalOT = 0;

    records.forEach(r => {
      recordMap[r.dateStr] = {
        status: r.status,
        dayValue: r.dayValue,
        overtimeHours: r.overtimeHours || 0,
        notes: r.notes || '',
        recordId: r._id
      };
      if (r.status === 'Present') present += 1;
      else if (r.status === 'Half Day') halfDay += 1;
      else if (r.status === 'Absent') absent += 1;
      else if (r.status === 'Paid Leave') paidLeave += 1;
      totalDayValue += (r.dayValue || 0);
      totalOT += (r.overtimeHours || 0);
    });

    res.json({
      success: true,
      member,
      month,
      daysInMonth: getDaysInMonth(month),
      records: recordMap,
      summary: {
        present,
        halfDay,
        absent,
        paidLeave,
        totalDayValue,
        totalOT,
        totalMarked: records.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error loading member monthly attendance', error: err.message });
  }
};

// Mark or update attendance for a single member on a specific date
exports.markSingleAttendance = async (req, res) => {
  try {
    const { memberId, dateStr, status, overtimeHours, notes } = req.body;
    if (!memberId || !dateStr || !status) {
      return res.status(400).json({ success: false, message: 'memberId, dateStr and status are required' });
    }

    const targetDate = new Date(`${dateStr}T12:00:00.000Z`);
    const createdBy = req.user?.name || 'Admin';

    let dayValue = 1.0;
    if (status === 'Half Day') dayValue = 0.5;
    else if (status === 'Absent') dayValue = 0.0;
    else if (status === 'Paid Leave') dayValue = 1.0;

    const record = await Attendance.findOneAndUpdate(
      { member: memberId, dateStr },
      {
        $set: {
          member: memberId,
          date: targetDate,
          dateStr,
          status,
          dayValue,
          overtimeHours: Number(overtimeHours) || 0,
          notes: notes || '',
          createdBy
        }
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: `Attendance marked as ${status} for ${dateStr}`, record });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error marking attendance', error: err.message });
  }
};

// ==========================================
// 3. ADVANCE (UPAD)
// ==========================================

// Get list of advances with filters
exports.getAdvances = async (req, res) => {
  try {
    const { memberId, status, from, to } = req.query;
    const filter = {};

    if (memberId && memberId !== 'All') {
      filter.member = memberId;
    }
    if (status && status !== 'All') {
      filter.status = status;
    }
    if (from || to) {
      filter.advanceDate = {};
      if (from) filter.advanceDate.$gte = new Date(new Date(from).setHours(0, 0, 0, 0));
      if (to) filter.advanceDate.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
    }

    const advances = await Advance.find(filter)
      .populate('member', 'name employeeId role phone')
      .sort({ advanceDate: -1, createdAt: -1 })
      .lean();

    // Summary calculations
    const allAdvances = await Advance.find().lean();
    const totalGiven = allAdvances.reduce((sum, a) => sum + (a.amount || 0), 0);
    const totalDeducted = allAdvances.reduce((sum, a) => sum + (a.amountDeducted || 0), 0);
    const pendingBalance = totalGiven - totalDeducted;

    res.json({
      success: true,
      advances,
      summary: {
        totalGiven: round2(totalGiven),
        totalDeducted: round2(totalDeducted),
        pendingBalance: round2(pendingBalance)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error loading advances', error: err.message });
  }
};

// Record a new Advance (Upad)
exports.createAdvance = async (req, res) => {
  try {
    const { memberId, amount, advanceDate, paymentMode, paidFrom, reason, notes, recordInFinance } = req.body;

    if (!memberId) {
      return res.status(400).json({ success: false, message: 'Please select a team member' });
    }
    const numAmount = round2(amount);
    if (!(numAmount > 0)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid advance amount' });
    }

    const member = await TeamMember.findById(memberId);
    if (!member) {
      return res.status(404).json({ success: false, message: 'Team member not found' });
    }

    const advanceId = await generateNextId(Advance, 'advanceId', 'ADV-');

    // Optionally create an Expense in Finance for cash/bank ledger integration
    let linkedExpenseId = '';
    if (recordInFinance !== false) {
      try {
        const expId = await nextExpenseId();
        await Expense.create({
          expenseId: expId,
          expenseDate: advanceDate ? new Date(advanceDate) : new Date(),
          amount: numAmount,
          paidFrom: paidFrom || 'Cash',
          category: 'Salary / Payout',
          paidTo: member.name,
          description: `Staff Advance - ${member.name} (${advanceId})`,
          reference: advanceId,
          createdBy: req.user?.name || 'Admin'
        });
        linkedExpenseId = expId;
      } catch (expErr) {
        console.warn('Could not auto-create Expense for Advance:', expErr.message);
      }
    }

    const advance = new Advance({
      advanceId,
      member: memberId,
      advanceDate: advanceDate ? new Date(advanceDate) : new Date(),
      amount: numAmount,
      paymentMode: paymentMode || 'Cash',
      paidFrom: paidFrom || 'Cash',
      reason: reason?.trim() || 'Advance',
      status: 'Pending',
      amountDeducted: 0,
      linkedExpenseId,
      notes: notes || '',
      createdBy: req.user?.name || 'Admin'
    });

    await advance.save();

    res.status(201).json({ success: true, message: `Advance of ₹${numAmount} recorded for ${member.name}`, advance });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error recording advance', error: err.message });
  }
};

// Delete an advance (only allowed if not yet deducted)
exports.deleteAdvance = async (req, res) => {
  try {
    const { id } = req.params;
    const advance = await Advance.findById(id);
    if (!advance) {
      return res.status(404).json({ success: false, message: 'Advance record not found' });
    }

    if (advance.amountDeducted > 0 || advance.status === 'Deducted') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete advance that has already been deducted in payroll. Please reverse payroll deduction first.'
      });
    }

    // Remove linked expense if exists
    if (advance.linkedExpenseId) {
      await Expense.findOneAndDelete({ expenseId: advance.linkedExpenseId }).catch(err => {
        console.warn('Could not delete linked expense:', err.message);
      });
    }

    await Advance.findByIdAndDelete(id);
    res.json({ success: true, message: 'Advance record deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error deleting advance', error: err.message });
  }
};

// Get member-wise advance summary
exports.getMemberAdvanceBalances = async (req, res) => {
  try {
    const members = await TeamMember.find({ status: 'Active' }).sort({ name: 1 }).lean();

    const advances = await Advance.aggregate([
      {
        $group: {
          _id: '$member',
          totalGiven: { $sum: '$amount' },
          totalDeducted: { $sum: '$amountDeducted' },
          pendingCount: {
            $sum: {
              $cond: [{ $in: ['$status', ['Pending', 'Partially Deducted']] }, 1, 0]
            }
          }
        }
      }
    ]);

    const advMap = {};
    advances.forEach(a => {
      advMap[a._id.toString()] = {
        totalGiven: round2(a.totalGiven),
        totalDeducted: round2(a.totalDeducted),
        pendingBalance: round2(a.totalGiven - a.totalDeducted),
        pendingCount: a.pendingCount
      };
    });

    const result = members.map(m => {
      const stats = advMap[m._id.toString()] || { totalGiven: 0, totalDeducted: 0, pendingBalance: 0, pendingCount: 0 };
      return {
        member: m,
        ...stats
      };
    });

    res.json({ success: true, balances: result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error getting advance balances', error: err.message });
  }
};

// ==========================================
// 4. SALARY & PAYROLL
// ==========================================

// Get payroll for a specific month (month: 'YYYY-MM')
exports.getPayroll = async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) {
      return res.status(400).json({ success: false, message: 'month parameter is required (YYYY-MM)' });
    }

    const payrolls = await Payroll.find({ month })
      .populate('member', 'name employeeId role phone salaryType baseSalary department')
      .sort({ createdAt: 1 })
      .lean();

    // Summary calculations
    const summary = {
      count: payrolls.length,
      totalGross: round2(payrolls.reduce((s, p) => s + (p.grossEarned || 0), 0)),
      totalBonus: round2(payrolls.reduce((s, p) => s + (p.bonus || 0) + (p.overtimePay || 0), 0)),
      totalAdvanceDeducted: round2(payrolls.reduce((s, p) => s + (p.advanceDeducted || 0), 0)),
      totalNetPayable: round2(payrolls.reduce((s, p) => s + (p.netPayable || 0), 0)),
      totalPaid: round2(payrolls.reduce((s, p) => s + (p.amountPaid || 0), 0)),
      totalBalanceDue: round2(payrolls.reduce((s, p) => s + (p.balanceDue || 0), 0))
    };

    res.json({ success: true, month, payrolls, summary });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching payroll', error: err.message });
  }
};

// Synchronize advance records with payroll deductions for a member
const syncMemberAdvanceDeductions = async (memberId) => {
  try {
    // Find all payrolls for this member that have advanceDeducted > 0
    const payrolls = await Payroll.find({ member: memberId, advanceDeducted: { $gt: 0 } }).sort({ month: 1 });
    const totalDeductedInPayroll = payrolls.reduce((sum, p) => sum + (p.advanceDeducted || 0), 0);

    // Find all advances for this member sorted chronologically
    const advances = await Advance.find({ member: memberId }).sort({ advanceDate: 1, createdAt: 1 });

    let remainingDeduction = totalDeductedInPayroll;

    for (const adv of advances) {
      if (remainingDeduction <= 0) {
        adv.amountDeducted = 0;
        adv.status = 'Pending';
        adv.deductedInPayrolls = [];
      } else {
        const deductForThis = Math.min(adv.amount, remainingDeduction);
        adv.amountDeducted = round2(deductForThis);
        remainingDeduction = round2(remainingDeduction - deductForThis);

        if (adv.amountDeducted >= adv.amount - 0.01) {
          adv.status = 'Deducted';
        } else {
          adv.status = 'Partially Deducted';
        }
      }
      await adv.save();
    }
  } catch (err) {
    console.error('Error syncing advance deductions:', err);
  }
};

// Calculate or re-calculate payroll for all active members for a month
exports.calculateMonthlyPayroll = async (req, res) => {
  try {
    const { month } = req.body;
    if (!month) {
      return res.status(400).json({ success: false, message: 'month is required (YYYY-MM)' });
    }

    const daysInMonth = getDaysInMonth(month);
    const monthLabel = formatMonthLabel(month);
    const members = await TeamMember.find({ status: 'Active' }).sort({ name: 1 });

    // Fetch month's attendance for all members
    const attendanceRecords = await Attendance.find({ dateStr: { $regex: `^${month}` } }).lean();
    const attMap = {};
    attendanceRecords.forEach(r => {
      const id = r.member.toString();
      if (!attMap[id]) {
        attMap[id] = { presentDays: 0, halfDays: 0, absentDays: 0, paidLeaveDays: 0, overtimeHours: 0 };
      }
      if (r.status === 'Present') attMap[id].presentDays += 1;
      else if (r.status === 'Half Day') { attMap[id].halfDays += 1; attMap[id].presentDays += 0.5; }
      else if (r.status === 'Absent') attMap[id].absentDays += 1;
      else if (r.status === 'Paid Leave') { attMap[id].paidLeaveDays += 1; attMap[id].presentDays += 1.0; }

      attMap[id].overtimeHours += (r.overtimeHours || 0);
    });

    // Fetch pending advance balance per member (excluding deductions already in other months)
    const openAdvances = await Advance.aggregate([
      { $match: { status: { $in: ['Pending', 'Partially Deducted'] } } },
      {
        $group: {
          _id: '$member',
          totalPending: { $sum: { $subtract: ['$amount', '$amountDeducted'] } }
        }
      }
    ]);
    const advMap = {};
    openAdvances.forEach(a => {
      advMap[a._id.toString()] = round2(a.totalPending);
    });

    const results = [];

    for (const member of members) {
      const mId = member._id.toString();
      const att = attMap[mId] || { presentDays: 0, halfDays: 0, absentDays: 0, paidLeaveDays: 0, overtimeHours: 0 };
      const pendingAdvance = advMap[mId] || 0;

      // Calculate Gross Salary and Effective Days
      let grossEarned = 0;
      let effectivePresentDays = att.presentDays;

      if (member.salaryType === 'Daily') {
        // Daily: paid per present day
        grossEarned = round2(att.presentDays * member.baseSalary);
        effectivePresentDays = att.presentDays;
      } else {
        // Monthly Fixed Salary: ALWAYS full base salary.
        // As requested: Only advances are deducted; leave/half-day deductions are done manually if needed.
        grossEarned = member.baseSalary;
        effectivePresentDays = Math.max(0, round2(daysInMonth - att.absentDays - (att.halfDays * 0.5)));
      }

      // Check if a payroll record already exists for this member and month
      let payroll = await Payroll.findOne({ member: member._id, month });

      // Automatically determine advance to deduct
      let advanceToDeduct = 0;
      if (!payroll || payroll.amountPaid === 0) {
        // When no salary payment has been made yet, automatically deduct pending advances!
        const totalAvailablePending = pendingAdvance + (payroll ? (payroll.advanceDeducted || 0) : 0);
        advanceToDeduct = Math.min(totalAvailablePending, grossEarned);
      } else {
        advanceToDeduct = payroll.advanceDeducted || 0;
      }

      if (payroll) {
        // Update attendance & gross, sync advance deduction
        payroll.totalDaysInMonth = daysInMonth;
        payroll.presentDays = effectivePresentDays;
        payroll.halfDays = att.halfDays;
        payroll.absentDays = att.absentDays;
        payroll.paidLeaveDays = att.paidLeaveDays;
        payroll.overtimeHours = att.overtimeHours;
        payroll.grossEarned = grossEarned;
        payroll.advanceDeducted = advanceToDeduct;

        // Recalculate Net
        payroll.netPayable = round2(
          payroll.grossEarned + (payroll.bonus || 0) + (payroll.overtimePay || 0) - payroll.advanceDeducted - (payroll.otherDeductions || 0)
        );
        payroll.balanceDue = Math.max(0, round2(payroll.netPayable - (payroll.amountPaid || 0)));

        if (payroll.balanceDue <= 0.01 && payroll.amountPaid > 0) {
          payroll.status = 'Paid';
        } else if (payroll.amountPaid > 0) {
          payroll.status = 'Partial';
        } else {
          payroll.status = 'Unpaid';
        }

        await payroll.save();
        results.push(payroll);
      } else {
        // Create new payroll record
        const payrollId = await generateNextId(Payroll, 'payrollId', 'PAY-');
        const netPayable = round2(grossEarned - advanceToDeduct);

        payroll = new Payroll({
          payrollId,
          member: member._id,
          month,
          monthLabel,
          salaryType: member.salaryType,
          baseSalary: member.baseSalary,
          totalDaysInMonth: daysInMonth,
          presentDays: effectivePresentDays,
          halfDays: att.halfDays,
          absentDays: att.absentDays,
          paidLeaveDays: att.paidLeaveDays,
          overtimeHours: att.overtimeHours,
          overtimePay: 0,
          grossEarned,
          bonus: 0,
          advanceDeducted: advanceToDeduct,
          otherDeductions: 0,
          netPayable,
          amountPaid: 0,
          balanceDue: netPayable,
          status: 'Unpaid',
          createdBy: req.user?.name || 'Admin'
        });

        await payroll.save();
        results.push(payroll);
      }

      // Synchronize advance records so they reflect deduction
      await syncMemberAdvanceDeductions(member._id);
    }

    res.json({
      success: true,
      message: `Payroll calculated successfully for ${results.length} members for ${monthLabel}`,
      count: results.length
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error calculating payroll', error: err.message });
  }
};

// Update payroll adjustments (grossEarned, bonus, overtimePay, advanceDeducted, otherDeductions, notes)
exports.updatePayrollAdjustment = async (req, res) => {
  try {
    const { id } = req.params;
    const { grossEarned, bonus, overtimePay, advanceDeducted, otherDeductions, notes } = req.body;

    const payroll = await Payroll.findById(id).populate('member', 'name employeeId');
    if (!payroll) {
      return res.status(404).json({ success: false, message: 'Payroll record not found' });
    }

    if (grossEarned !== undefined && !isNaN(grossEarned) && grossEarned !== null) {
      payroll.grossEarned = round2(grossEarned);
    }
    if (bonus !== undefined) payroll.bonus = round2(bonus);
    if (overtimePay !== undefined) payroll.overtimePay = round2(overtimePay);
    if (advanceDeducted !== undefined) payroll.advanceDeducted = round2(advanceDeducted);
    if (otherDeductions !== undefined) payroll.otherDeductions = round2(otherDeductions);
    if (notes !== undefined) payroll.notes = notes;

    // Recalculate net and balance
    payroll.netPayable = round2(
      payroll.grossEarned + (payroll.bonus || 0) + (payroll.overtimePay || 0) - (payroll.advanceDeducted || 0) - (payroll.otherDeductions || 0)
    );
    payroll.balanceDue = Math.max(0, round2(payroll.netPayable - (payroll.amountPaid || 0)));

    if (payroll.balanceDue <= 0.01 && payroll.amountPaid > 0) {
      payroll.status = 'Paid';
    } else if (payroll.amountPaid > 0) {
      payroll.status = 'Partial';
    } else {
      payroll.status = 'Unpaid';
    }

    await payroll.save();

    // Re-sync advances for this member
    await syncMemberAdvanceDeductions(payroll.member._id || payroll.member);

    res.json({ success: true, message: 'Payroll updated successfully', payroll });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error updating payroll', error: err.message });
  }
};

// Make payment towards payroll
exports.recordPayrollPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, paidFrom, paymentMode, reference, notes, recordInFinance } = req.body;

    const numAmount = round2(amount);
    if (!(numAmount > 0)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid payment amount' });
    }

    const payroll = await Payroll.findById(id).populate('member', 'name employeeId');
    if (!payroll) {
      return res.status(404).json({ success: false, message: 'Payroll record not found' });
    }

    if (numAmount > round2(payroll.balanceDue) + 0.01) {
      return res.status(400).json({
        success: false,
        message: `Payment amount ₹${numAmount} cannot exceed balance due ₹${payroll.balanceDue}`
      });
    }

    // Optionally create Expense in Finance
    let linkedExpenseId = '';
    if (recordInFinance !== false) {
      try {
        const expId = await nextExpenseId();
        await Expense.create({
          expenseId: expId,
          expenseDate: new Date(),
          amount: numAmount,
          paidFrom: paidFrom || 'Cash',
          category: 'Salary / Payout',
          paidTo: payroll.member.name,
          description: `Salary Payout - ${payroll.member.name} (${payroll.monthLabel || payroll.month})`,
          reference: reference || payroll.payrollId,
          createdBy: req.user?.name || 'Admin'
        });
        linkedExpenseId = expId;
      } catch (expErr) {
        console.warn('Could not auto-create Expense for Payroll payment:', expErr.message);
      }
    }

    // Add payment record
    const paymentRecord = {
      paymentId: `PAY-REC-${Date.now().toString().slice(-6)}`,
      paymentDate: new Date(),
      amount: numAmount,
      paidFrom: paidFrom || 'Cash',
      paymentMode: paymentMode || 'Cash',
      reference: reference || '',
      linkedExpenseId,
      notes: notes || '',
      createdBy: req.user?.name || 'Admin'
    };

    payroll.payments.push(paymentRecord);
    payroll.amountPaid = round2(payroll.amountPaid + numAmount);
    payroll.balanceDue = Math.max(0, round2(payroll.netPayable - payroll.amountPaid));

    if (payroll.balanceDue <= 0.01) {
      payroll.status = 'Paid';
    } else {
      payroll.status = 'Partial';
    }

    // Settle pending advances up to advanceDeducted
    if (payroll.advanceDeducted > 0) {
      let remainingToSettle = payroll.advanceDeducted;
      const memberAdvances = await Advance.find({
        member: payroll.member._id,
        status: { $in: ['Pending', 'Partially Deducted'] }
      }).sort({ advanceDate: 1 });

      for (const adv of memberAdvances) {
        if (remainingToSettle <= 0) break;
        const advPending = round2(adv.amount - adv.amountDeducted);
        const settleAmount = Math.min(advPending, remainingToSettle);

        adv.amountDeducted = round2(adv.amountDeducted + settleAmount);
        adv.deductedInPayrolls.push({
          payroll: payroll._id,
          amount: settleAmount,
          date: new Date()
        });

        if (adv.amountDeducted >= adv.amount - 0.01) {
          adv.status = 'Deducted';
        } else {
          adv.status = 'Partially Deducted';
        }

        await adv.save();
        remainingToSettle = round2(remainingToSettle - settleAmount);
      }
    }

    await payroll.save();

    res.json({
      success: true,
      message: `Payment of ₹${numAmount} recorded for ${payroll.member.name}. Balance remaining: ₹${payroll.balanceDue}`,
      payroll
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error processing payroll payment', error: err.message });
  }
};

// ==========================================
// 5. MONTHLY STATEMENT & ADVANCE REPORT
// ==========================================
exports.getMonthlyStatement = async (req, res) => {
  try {
    const { month, memberId } = req.query; // 'YYYY-MM'
    if (!month) {
      return res.status(400).json({ success: false, message: 'month parameter (YYYY-MM) is required' });
    }

    const [y, m] = month.split('-').map(Number);
    const startOfMonth = new Date(y, m - 1, 1, 0, 0, 0, 0);
    const endOfMonth = new Date(y, m, 0, 23, 59, 59, 999);

    const memberFilter = { status: 'Active' };
    if (memberId && memberId !== 'All') {
      memberFilter._id = memberId;
    }

    const members = await TeamMember.find(memberFilter).sort({ name: 1 }).lean();
    const payrolls = await Payroll.find({ month }).lean();
    const payrollMap = {};
    payrolls.forEach(p => {
      payrollMap[p.member.toString()] = p;
    });

    // Fetch all advances taken by these members in this month
    const memberIds = members.map(m => m._id);
    const advances = await Advance.find({
      member: { $in: memberIds },
      advanceDate: { $gte: startOfMonth, $lte: endOfMonth }
    }).sort({ advanceDate: 1 }).lean();

    const advancesByMember = {};
    advances.forEach(adv => {
      const id = adv.member.toString();
      if (!advancesByMember[id]) advancesByMember[id] = [];
      advancesByMember[id].push({
        _id: adv._id,
        advanceId: adv.advanceId,
        date: adv.advanceDate,
        amount: adv.amount,
        paidFrom: adv.paidFrom,
        paymentMode: adv.paymentMode,
        reason: adv.reason,
        status: adv.status,
        amountDeducted: adv.amountDeducted
      });
    });

    const statements = members.map(member => {
      const mId = member._id.toString();
      const payroll = payrollMap[mId] || null;
      const memberAdvances = advancesByMember[mId] || [];
      const totalMonthAdvances = memberAdvances.reduce((sum, a) => sum + (a.amount || 0), 0);

      return {
        member: {
          _id: member._id,
          name: member.name,
          employeeId: member.employeeId,
          role: member.role,
          department: member.department,
          phone: member.phone,
          salaryType: member.salaryType,
          baseSalary: member.baseSalary
        },
        advances: memberAdvances,
        totalMonthAdvances: round2(totalMonthAdvances),
        attendance: {
          presentDays: payroll ? payroll.presentDays : 0,
          halfDays: payroll ? payroll.halfDays : 0,
          absentDays: payroll ? payroll.absentDays : 0,
          totalDays: payroll ? payroll.totalDaysInMonth : getDaysInMonth(month)
        },
        salary: {
          grossEarned: payroll ? payroll.grossEarned : 0,
          bonus: payroll ? (payroll.bonus || 0) : 0,
          overtimePay: payroll ? (payroll.overtimePay || 0) : 0,
          advanceDeducted: payroll ? (payroll.advanceDeducted || 0) : 0,
          otherDeductions: payroll ? (payroll.otherDeductions || 0) : 0,
          netPayable: payroll ? (payroll.netPayable || 0) : 0,
          amountPaid: payroll ? (payroll.amountPaid || 0) : 0,
          balanceRemaining: payroll ? (payroll.balanceDue || 0) : 0,
          status: payroll ? payroll.status : 'Unpaid',
          payrollId: payroll ? payroll.payrollId : ''
        }
      };
    });

    const summary = {
      staffCount: statements.length,
      totalAdvancesGiven: round2(statements.reduce((s, st) => s + st.totalMonthAdvances, 0)),
      totalGrossSalary: round2(statements.reduce((s, st) => s + st.salary.grossEarned, 0)),
      totalAdvanceDeducted: round2(statements.reduce((s, st) => s + st.salary.advanceDeducted, 0)),
      totalNetPayable: round2(statements.reduce((s, st) => s + st.salary.netPayable, 0)),
      totalPaid: round2(statements.reduce((s, st) => s + st.salary.amountPaid, 0)),
      totalBalanceRemaining: round2(statements.reduce((s, st) => s + st.salary.balanceRemaining, 0))
    };

    res.json({
      success: true,
      month,
      monthLabel: formatMonthLabel(month),
      statements,
      summary
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error generating monthly statement', error: err.message });
  }
};
