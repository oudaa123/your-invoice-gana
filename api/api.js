// api.js - سيرفر وسيط بين كودك و Neon
const { Pool } = require('pg');

// اتصال Neon - الرابط مباشر
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_mDMcoZYzC1n5@ep-royal-credit-apwita9n-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { action, ...params } = req.body;
  
  try {
    let result;
    
    switch(action) {
      
      // ========== LOGIN ==========
      case 'login':
        const userQuery = `SELECT id, name, role FROM users WHERE mobile = $1 AND password = $2 AND is_active = true`;
        const userResult = await pool.query(userQuery, [params.mobile, params.password]);
        
        if (userResult.rows.length > 0) {
          const u = userResult.rows[0];
          const invQuery = `SELECT i.*, c.name as "customerName" FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.status = 'نشط'`;
          const invResult = await pool.query(invQuery);
          
          result = {
            success: true,
            customerId: u.id,
            name: u.name,
            role: u.role,
            isAdmin: u.role === 'مدير',
            userType: 'employee',
            invoices: invResult.rows
          };
        } else {
          const custQuery = `SELECT id, name FROM customers WHERE mobile = $1 AND password = $2 AND is_active = true`;
          const custResult = await pool.query(custQuery, [params.mobile, params.password]);
          
          if (custResult.rows.length > 0) {
            const c = custResult.rows[0];
            result = {
              success: true,
              customerId: c.id,
              name: c.name,
              role: 'عميل',
              isAdmin: false,
              userType: 'client',
              invoices: []
            };
          } else {
            result = { success: false, message: 'بيانات خاطئة' };
          }
        }
        break;
        
      // ========== SEARCH CUSTOMERS ==========
      case 'searchCustomers':
        const custSearch = await pool.query(
          `SELECT id as "customerId", name, mobile FROM customers WHERE (name ILIKE $1 OR mobile ILIKE $1) AND is_active = true LIMIT 10`,
          [`%${params.query}%`]
        );
        result = custSearch.rows;
        break;
        
      // ========== ADD CUSTOMER ==========
      case 'addCustomerWithMobile':
        const pwd = Math.random().toString(36).slice(-6);
        try {
          const newCust = await pool.query(
            `INSERT INTO customers (name, mobile, password) VALUES ($1, $2, $3) RETURNING id as "customerId"`,
            [params.name, params.mobile, pwd]
          );
          result = { success: true, customerId: newCust.rows[0].customerId, password: pwd };
        } catch(e) {
          result = { success: false, message: 'الرقم موجود مسبقاً' };
        }
        break;
        
      // ========== AUTO ADD CUSTOMER ==========
      case 'addCustomerAuto':
        const existCust = await pool.query(`SELECT id FROM customers WHERE name = $1`, [params.name]);
        if (existCust.rows.length > 0) {
          result = { success: true, customerId: existCust.rows[0].id };
        } else {
          const autoCust = await pool.query(
            `INSERT INTO customers (name, mobile, password) VALUES ($1, 'auto', '123456') RETURNING id as "customerId"`,
            [params.name]
          );
          result = { success: true, customerId: autoCust.rows[0].customerId };
        }
        break;
        
      // ========== GET ALL INVOICES ==========
      case 'getAllInvoices':
        const invs = await pool.query(
          `SELECT i.id as "invoiceId", i.*, c.name as "customerName" FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.status = 'نشط' ORDER BY i.created_at DESC`
        );
        result = invs.rows;
        break;
        
      // ========== GET NEXT INVOICE NUMBER ==========
      case 'getNextInvoiceNumber':
        const lastCode = await pool.query(`SELECT code FROM invoices ORDER BY code DESC LIMIT 1`);
        let num = 1;
        if (lastCode.rows.length > 0) {
          num = parseInt(lastCode.rows[0].code.replace('F-', '')) + 1;
        }
        result = { code: 'F-' + String(num).padStart(4, '0') };
        break;
        
      // ========== ADD INVOICE ==========
      case 'addInvoice':
        const items = JSON.parse(params.items);
        let total = 0;
        items.forEach(item => { total += Math.max(0, item.quantity * item.unitPrice - (item.discount || 0)); });
        
        const codeRes = await pool.query(`SELECT code FROM invoices ORDER BY code DESC LIMIT 1`);
        let invNum = 1;
        if (codeRes.rows.length > 0) invNum = parseInt(codeRes.rows[0].code.replace('F-', '')) + 1;
        const code = 'F-' + String(invNum).padStart(4, '0');
        
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const invRes = await client.query(
            `INSERT INTO invoices (code, date, customer_id, customer_name, total_amount, paid_amount) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [code, params.date, params.customerId, params.customerName, total, params.paidAmount || 0]
          );
          const invId = invRes.rows[0].id;
          
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            await client.query(
              `INSERT INTO invoice_items (invoice_id, item_number, product, quantity, unit_price, discount) VALUES ($1,$2,$3,$4,$5,$6)`,
              [invId, i+1, item.product, item.quantity, item.unitPrice, item.discount || 0]
            );
          }
          await client.query('COMMIT');
          result = { success: true, message: '✅ تم حفظ الفاتورة ' + code, code };
        } catch(e) {
          await client.query('ROLLBACK');
          result = { success: false, message: 'خطأ في الحفظ' };
        } finally {
          client.release();
        }
        break;
        
      // ========== GET INVOICE DETAILS ==========
      case 'getInvoice':
        const itemsRes = await pool.query(
          `SELECT product, quantity, unit_price as "unitPrice", discount, net_total as "netTotal", item_number as "itemNumber" FROM invoice_items WHERE invoice_id = $1 ORDER BY item_number`,
          [params.invoiceId]
        );
        const invInfo = await pool.query(
          `SELECT paid_amount as "paidAmount", customer_name as "customerName" FROM invoices WHERE id = $1`,
          [params.invoiceId]
        );
        result = [...itemsRes.rows, invInfo.rows[0] || {}];
        break;
        
      // ========== UPDATE INVOICE ==========
      case 'updateInvoice':
        const editItems = JSON.parse(params.items);
        let editTotal = 0;
        editItems.forEach(item => { editTotal += Math.max(0, item.quantity * item.unitPrice - (item.discount || 0)); });
        
        const editClient = await pool.connect();
        try {
          await editClient.query('BEGIN');
          await editClient.query(
            `UPDATE invoices SET date = $1, total_amount = $2, paid_amount = $3 WHERE id = $4`,
            [params.date, editTotal, params.paidAmount || 0, params.invoiceId]
          );
          await editClient.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [params.invoiceId]);
          
          for (let i = 0; i < editItems.length; i++) {
            const item = editItems[i];
            await editClient.query(
              `INSERT INTO invoice_items (invoice_id, item_number, product, quantity, unit_price, discount) VALUES ($1,$2,$3,$4,$5,$6)`,
              [params.invoiceId, i+1, item.product, item.quantity, item.unitPrice, item.discount || 0]
            );
          }
          await editClient.query('COMMIT');
          result = { success: true, message: '✅ تم تحديث الفاتورة' };
        } catch(e) {
          await editClient.query('ROLLBACK');
          result = { success: false, message: 'خطأ في التحديث' };
        } finally {
          editClient.release();
        }
        break;
        
      // ========== DELETE INVOICE ==========
      case 'deleteInvoice':
        const delClient = await pool.connect();
        try {
          await delClient.query('BEGIN');
          const inv = await delClient.query(`SELECT * FROM invoices WHERE id = $1`, [params.invoiceId]);
          if (inv.rows.length > 0) {
            const i = inv.rows[0];
            await delClient.query(
              `INSERT INTO trash (original_type, original_id, code, date, amount, full_data) VALUES ($1,$2,$3,$4,$5,$6)`,
              ['فاتورة', i.id, i.code, i.date, i.total_amount, JSON.stringify(i)]
            );
            await delClient.query(`UPDATE invoices SET status = 'محذوف' WHERE id = $1`, [params.invoiceId]);
          }
          await delClient.query('COMMIT');
          result = { success: true, message: 'تم النقل للمحذوفات' };
        } catch(e) {
          await delClient.query('ROLLBACK');
          result = { success: false, message: 'خطأ' };
        } finally {
          delClient.release();
        }
        break;
        
      // ========== GET TRASH ==========
      case 'getTrash':
        const trash = await pool.query(`SELECT id as "trashId", code, date, amount, deleted_at as "deleteDate" FROM trash ORDER BY deleted_at DESC`);
        result = trash.rows;
        break;
        
      // ========== RESTORE INVOICE ==========
      case 'restoreInvoice':
        const restTrash = await pool.query(`SELECT * FROM trash WHERE id = $1`, [params.trashId]);
        if (restTrash.rows.length > 0) {
          await pool.query(`UPDATE invoices SET status = 'نشط' WHERE id = $1`, [restTrash.rows[0].original_id]);
          await pool.query(`DELETE FROM trash WHERE id = $1`, [params.trashId]);
          result = { success: true, message: 'تم الاستعادة' };
        }
        break;
        
      // ========== PERMANENT DELETE ==========
      case 'permanentDelete':
        const permTrash = await pool.query(`SELECT * FROM trash WHERE id = $1`, [params.trashId]);
        if (permTrash.rows.length > 0) {
          await pool.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [permTrash.rows[0].original_id]);
          await pool.query(`DELETE FROM invoices WHERE id = $1`, [permTrash.rows[0].original_id]);
          await pool.query(`DELETE FROM trash WHERE id = $1`, [params.trashId]);
          result = { success: true, message: 'تم الحذف النهائي' };
        }
        break;
        
      // ========== INVENTORY ==========
      case 'getInventory':
        const inv = await pool.query(`SELECT product_name as name, quantity, cost_price as "costPrice", sell_price as "sellPrice", total_value as "totalValue" FROM inventory WHERE quantity > 0`);
        result = inv.rows;
        break;
        
      // ========== SUPPLIERS ==========
      case 'searchSuppliers':
        const supSearch = await pool.query(
          `SELECT id as "supplierId", name, mobile FROM suppliers WHERE (name ILIKE $1 OR mobile ILIKE $1) AND is_active = true LIMIT 10`,
          [`%${params.query}%`]
        );
        result = supSearch.rows;
        break;
        
      case 'addSupplier':
        const newSup = await pool.query(
          `INSERT INTO suppliers (name, mobile) VALUES ($1, $2) RETURNING id as "supplierId"`,
          [params.name, params.mobile || '']
        );
        result = { success: true, supplierId: newSup.rows[0].supplierId };
        break;
        
      case 'getSuppliers':
        const sups = await pool.query(`SELECT id as "supplierId", name, mobile, balance FROM suppliers WHERE is_active = true`);
        result = sups.rows;
        break;
        
      case 'getAllCustomers':
        const custs = await pool.query(`SELECT id as "customerId", name, mobile, balance FROM customers WHERE is_active = true`);
        result = custs.rows;
        break;
        
      case 'getNextPurchaseNumber':
        const lastPur = await pool.query(`SELECT code FROM purchases ORDER BY code DESC LIMIT 1`);
        let purNum = 1;
        if (lastPur.rows.length > 0) purNum = parseInt(lastPur.rows[0].code.replace('P-', '')) + 1;
        result = { code: 'P-' + String(purNum).padStart(4, '0') };
        break;
        
      case 'getAllPurchases':
        const purs = await pool.query(`SELECT p.*, s.name as "supplierName" FROM purchases p LEFT JOIN suppliers s ON p.supplier_id = s.id WHERE p.status = 'نشط' ORDER BY p.created_at DESC`);
        result = purs.rows;
        break;
        
      case 'addPurchase':
        const purItems = JSON.parse(params.items);
        let purTotal = 0;
        purItems.forEach(item => { purTotal += item.quantity * item.unitPrice; });
        
        const purCodeRes = await pool.query(`SELECT code FROM purchases ORDER BY code DESC LIMIT 1`);
        let pNum = 1;
        if (purCodeRes.rows.length > 0) pNum = parseInt(purCodeRes.rows[0].code.replace('P-', '')) + 1;
        const purCode = 'P-' + String(pNum).padStart(4, '0');
        
        const purClient = await pool.connect();
        try {
          await purClient.query('BEGIN');
          const purRes = await purClient.query(
            `INSERT INTO purchases (code, date, supplier_id, supplier_name, total_amount, paid_amount) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [purCode, params.date, params.supplierId, params.supplierName, purTotal, params.paidAmount || 0]
          );
          const purId = purRes.rows[0].id;
          
          for (let i = 0; i < purItems.length; i++) {
            const item = purItems[i];
            await purClient.query(
              `INSERT INTO purchase_items (purchase_id, item_number, product, quantity, cost_price, sell_price) VALUES ($1,$2,$3,$4,$5,$6)`,
              [purId, i+1, item.product, item.quantity, item.unitPrice, item.sellPrice || item.unitPrice * 1.2]
            );
            await purClient.query(
              `INSERT INTO inventory (product_name, quantity, cost_price, sell_price) VALUES ($1,$2,$3,$4) ON CONFLICT (product_name) DO UPDATE SET quantity = inventory.quantity + $2, cost_price = $3, sell_price = $4`,
              [item.product, item.quantity, item.unitPrice, item.sellPrice || item.unitPrice * 1.2]
            );
          }
          await purClient.query('COMMIT');
          result = { success: true, message: '✅ تم حفظ الشراء ' + purCode, code: purCode };
        } catch(e) {
          await purClient.query('ROLLBACK');
          result = { success: false, message: 'خطأ في الحفظ' };
        } finally {
          purClient.release();
        }
        break;
        
      // ========== SEARCH ALL ==========
      case 'searchAll':
        const custsSearch = await pool.query(`SELECT id as "customerId", name, mobile FROM customers WHERE (name ILIKE $1 OR mobile ILIKE $1) AND is_active = true LIMIT 5`, [`%${params.query}%`]);
        const supsSearch = await pool.query(`SELECT id as "supplierId", name, mobile FROM suppliers WHERE (name ILIKE $1 OR mobile ILIKE $1) AND is_active = true LIMIT 5`, [`%${params.query}%`]);
        result = { customers: custsSearch.rows, suppliers: supsSearch.rows };
        break;
        
      // ========== ADD TRANSACTION ==========
      case 'addTransaction':
        const isCol = params.type === 'تحصيل';
        await pool.query(
          `INSERT INTO transactions (date, entity_type, entity_id, type, amount, description, is_collection) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [params.date, 'عميل', params.customerId, params.type, params.amount, params.description, isCol]
        );
        await pool.query(
          `INSERT INTO cashbox (date, type, amount, description, is_collection) VALUES ($1,$2,$3,$4,$5)`,
          [params.date, params.type, params.amount, params.description, isCol]
        );
        result = { success: true, message: '✅ تمت المعاملة' };
        break;
        
      // ========== GET BALANCE ==========
      case 'getBalance':
        const trans = await pool.query(
          `SELECT *, SUM(CASE WHEN is_collection = true THEN amount ELSE -amount END) OVER (ORDER BY date, created_at) as "runningBalance" FROM transactions WHERE entity_id = $1 ORDER BY date, created_at`,
          [params.customerId]
        );
        const totDebit = trans.rows.filter(t => !t.is_collection).reduce((s, t) => s + parseFloat(t.amount), 0);
        const totCredit = trans.rows.filter(t => t.is_collection).reduce((s, t) => s + parseFloat(t.amount), 0);
        result = { transactions: trans.rows, totalDebit: totDebit, totalCredit: totCredit };
        break;
        
      // ========== GET CASHBOX ==========
      case 'getCashbox':
        const cashTrans = await pool.query(`SELECT * FROM cashbox ORDER BY date, created_at`);
        const col = cashTrans.rows.filter(t => t.is_collection).reduce((s, t) => s + parseFloat(t.amount), 0);
        const pay = cashTrans.rows.filter(t => !t.is_collection).reduce((s, t) => s + parseFloat(t.amount), 0);
        result = { transactions: cashTrans.rows, totalCollections: col, totalPayments: pay };
        break;
        
      // ========== SET OPENING CASH ==========
      case 'setOpeningCash':
        await pool.query(
          `INSERT INTO cashbox (date, type, amount, description, is_collection) VALUES ($1,'رصيد_افتتاحي',$2,$3,true)`,
          [params.date, params.amount, params.notes]
        );
        result = { success: true, message: 'تم حفظ الرصيد الافتتاحي' };
        break;
        
      // ========== ADD EXPENSE ==========
      case 'addExpense':
        await pool.query(`INSERT INTO expenses (date, amount, description) VALUES ($1,$2,$3)`, [params.date, params.amount, params.description]);
        await pool.query(`INSERT INTO cashbox (date, type, amount, description, is_collection) VALUES ($1,'مصروف',$2,$3,false)`, [params.date, params.amount, params.description]);
        result = { success: true, message: '✅ تم حفظ المصروف' };
        break;
        
      // ========== GET EXPENSES ==========
      case 'getExpenses':
        const exps = await pool.query(`SELECT * FROM expenses ORDER BY date DESC`);
        result = exps.rows;
        break;
        
      // ========== GET FINANCIAL CENTER ==========
      case 'getFinancialCenter':
        const sales = await pool.query(`SELECT COALESCE(SUM(total_amount),0) as total FROM invoices WHERE status = 'نشط'`);
        const purchases = await pool.query(`SELECT COALESCE(SUM(total_amount),0) as total FROM purchases WHERE status = 'نشط'`);
        const expenses = await pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM expenses`);
        result = {
          totalSales: sales.rows[0].total,
          totalPurchases: purchases.rows[0].total,
          totalExpenses: expenses.rows[0].total
        };
        break;
        
      // ========== GET USERS ==========
      case 'getUsers':
        const users = await pool.query(`SELECT * FROM users WHERE is_active = true`);
        result = users.rows;
        break;
        
      // ========== ADD USER ==========
      case 'addUser':
        try {
          await pool.query(`INSERT INTO users (name, mobile, password, role, permissions) VALUES ($1,$2,$3,$4,$5)`, [params.name, params.mobile, params.password, params.role, params.permissions || '*']);
          result = { success: true, message: '✅ تم إضافة المستخدم' };
        } catch(e) {
          result = { success: false, message: 'رقم الموبايل موجود مسبقاً' };
        }
        break;
        
      default:
        result = { success: false, message: 'إجراء غير معروف' };
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('Error:', error);
    res.json({ success: false, message: 'خطأ في الخادم' });
  }
};
