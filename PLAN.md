# Budgeting Tool Plan

## Tech Stack

**Client-side Web App (Single HTML file)**

- Pure HTML/JS/CSS - no build steps, easy to run
- **Papa Parse** - CSV parsing
- **Chart.js** - doughnut/ring charts
- **Local Storage** - persists all data (transactions, categories, budgets, merchant defaults)

---

## Completed Features

### 1. CSV Import ✅
- Historical import from budget spreadsheet (Actual Expenses & Income sections)
- Drag-and-drop or file picker for CSV files
- **Bulk import** - select multiple CSV files at once
- Auto-detects section headers and parses transactions
- **Handles negative amounts in parentheses** (e.g., `($ 10.00)`) as negative values
- Auto-adds new categories from imported data
- Stops budget parsing at "Total" row in Expenses Budget section
- Extracts month from filename (e.g., "January 2025 - Monthly Budget.csv")

### 2. UI/Navigation ✅
- **Left sidebar navigation** with Monthly, Yearly, and Import tabs
- Clean, modern layout with cards and grids
- Monthly page: doughnut chart + budget list + transactions
- Yearly page: doughnut chart + yearly income + yearly budget with totals

### 3. Monthly View ✅
- Month selector dropdown
- Doughnut chart showing spending by category
- **Income section** showing all income transactions for the month (green, positive)
- **Budget list** with editable budget amounts per category
- Budget copy functionality - copy budgets from one month to another
- Progress bars showing budget usage
- **Transactions section** (expenses only - income shown separately)

### 4. Yearly View ✅
- Year selector dropdown
- Doughnut chart showing yearly spending by category
- **Income section** with breakdown by income type (Zach Paychecks combined)
- **Yearly Budget** with:
  - Total section showing Total Budget, Total Spent, Surplus
  - Budget list showing sum of monthly budgets for months with data
  - Surplus calculation accounts for refunds (negative amounts)
  - Floating point precision handling for near-zero values

### 5. Data Management ✅
- All data stored in browser localStorage
- Export/Import functionality for backup and cross-device sync
- Dynamic date filters (month/year) populated from transaction data
- Clear All Data button to reset

### 6. Budget System ✅
- Per-month budget storage (not single yearly value)
- Budgets stored as `{'Category': {'2025-01': 400, '2025-02': 350}}`
- **Auto-apply default budgets** when importing data
- Import budgets from CSV (Expected Amount column in Expenses Budget section)
- Budget copied from one month to another via dropdown

### 7. Refund/Reimbursement Handling ✅
- Negative amounts in parentheses parsed as negative
- **Monthly income** displays negative amounts as green positive
- **Yearly income** includes negative amounts (refunds) as income
- **Yearly budget** calculates net correctly (budget - actual including negatives)
- Small floating point values (near zero) handled with threshold to show as +$0.00 green

### 8. Transaction Display ✅
- Filterable transactions list (by type, category, month)
- Expenses only in transactions section (income shown in income section)
- Color coding: income = green, expenses = red, refunds = green
- Shows description, merchant, date, amount, category

### 9. Visualizations ✅
- Monthly doughnut chart
- Yearly doughnut chart
- Progress bars in budget items

---

## Not Yet Implemented

### 1. Transaction Splitting
- Option to split a single transaction across multiple categories
- Not started

### 2. Savings Tracking
- Savings categories with growth targets
- Track deposits/withdrawals to savings
- Not started

### 3. Duplicate Detection
- Detect and skip duplicate transactions on import
- Not started

---

## Project Structure

```
/Budget
├── index.html        # Main app (all HTML/CSS/JS)
├── transactions.csv  # Sample data (reference)
├── budgets.csv       # Sample data (reference)
├── categories.csv    # Sample data (reference)
└── PLAN.md           # This plan
```

---

## Data Handling Rules

- Negative amounts in parentheses in CSV = negative values (refunds)
- Negative amounts in non-Income categories = refunds (displayed as green +)
- Income category transactions = green +
- All other expense transactions = red -
- Categories auto-added from imported data
- Manual category addition supported
- Budget stored per-month, yearly budget sums monthly budgets for months with data
- Near-zero values (within 0.01) treated as zero for display purposes