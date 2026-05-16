# Budget Categories Page Plan

## Data Model

**Category structure (enhanced)**:
```javascript
{
  name: "Groceries",
  type: "expense",
  group: "Living Expenses",      // or null for "Ungrouped"
  color: "#2ecc71",             // hex color
  isCumulative: false,
  cumulativeAmount: 0,          // monthly amount to add
  bankBalances: {               // keyed by month "2026-01"
    "2026-01": 400
  }
}
```

**Category Groups stored as**: Array of strings (group names), with "Ungrouped" as default.

## Cumulative Budget Logic

1. **On month change** - When viewing a new month:
   - Get all cumulative categories
   - For each, add `cumulativeAmount` to that month's `bankBalance`
   - If month already has a balance, it stays as-is (user override preserved)
2. **On transaction** - When spending from cumulative category:
   - Subtract from available bank (track separately from monthlyspent)
3. **Display** - Show "Bank: $X" instead of "Budget: $X" in budget views

## UI Components

### 1. New Nav Item
"Categories" in sidebar (between Yearly and Import)

### 2. Categories Panel
- Collapsible group sections (e.g., "Living Expenses")
- Each category shows: color dot, name, type badge (Regular/Cumulative)
- "Add Group" button at top
- "Add Category" button in each group (or floating action)

### 3. Add/Edit Category Modal
- Name input (required)
- Group dropdown + "Create new" option
- Color palette (12 preset colors)
- Type toggle: Regular / Cumulative
- If Cumulative: Monthly amount input, initial bank input

### 4. Edit Group Modal
- Group name input
- Delete group (moves categories to Ungrouped)

## Implementation Steps

1. Add Categories panel in HTML (sidebar + panel)
2. Update storage keys with migration for existing categories
3. Build categories page with group/category listing
4. Create Add/Edit Category modal with color picker
5. Create Add/Edit Group modal
6. Implement cumulative logic - auto-add to bank on month view
7. Update Monthly/Yearly budgets - show bank for cumulative categories
8. Add category color to charts - use category.color from data

## Color Palette

```javascript
['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6',
 '#1abc9c', '#34495e', '#e67e22', '#c0392b', '#27ae60',
 '#2980b9', '#8e44ad']
```

## Behavior Details

1. **Automatic bank addition**: When user views a new month, cumulative amounts are automatically added to that month's bank balance
2. **Default group**: "Ungrouped" is the default group for all categories
3. **Bank initialization**: Current month's budget becomes initial bank balance, user can override per month
4. **No group colors**: Groups do not need colors