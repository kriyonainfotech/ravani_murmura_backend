const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const teamController = require('../controllers/teamController');

// 1. Team Members
router.get('/members', teamController.getMembers);
router.post('/members', protectSuperAdmin, teamController.createMember);
router.put('/members/:id', protectSuperAdmin, teamController.updateMember);
router.delete('/members/:id', protectSuperAdmin, teamController.deleteMember);

// 2. Attendance
router.get('/attendance', teamController.getAttendanceByDate);
router.post('/attendance/bulk', protectSuperAdmin, teamController.saveAttendanceBulk);
router.post('/attendance/mark', protectSuperAdmin, teamController.markSingleAttendance);
router.get('/attendance/monthly-summary', teamController.getMonthlyAttendanceSummary);
router.get('/attendance/member/:memberId', teamController.getMemberMonthlyAttendance);

// 3. Advance (Upad)
router.get('/advances', teamController.getAdvances);
router.get('/advances/balances', teamController.getMemberAdvanceBalances);
router.post('/advances', protectSuperAdmin, teamController.createAdvance);
router.delete('/advances/:id', protectSuperAdmin, teamController.deleteAdvance);

// 4. Salary & Payroll
router.get('/payroll', teamController.getPayroll);
router.post('/payroll/calculate', protectSuperAdmin, teamController.calculateMonthlyPayroll);
router.put('/payroll/:id/adjustment', protectSuperAdmin, teamController.updatePayrollAdjustment);
router.post('/payroll/:id/pay', protectSuperAdmin, teamController.recordPayrollPayment);

// 5. Monthly Advance & Salary Report Statement
router.get('/monthly-statement', teamController.getMonthlyStatement);

module.exports = router;
