# Mobile Access + Cross-Device Sync Plan

## Overview

Make the budget tool accessible on mobile devices and enable cross-device data synchronization using Firebase (Google Sign-In + Firestore).

**Hosting:** GitHub Pages at `https://zmstiles-dev.github.io/budget-tool/`

---

## Part 1: Mobile Responsive CSS

**Files modified:** `index.html`

### 1.1 Add Hamburger Button (HTML)

Add before the sidebar in the HTML:

```html
<button class="hamburger" id="hamburger">☰</button>
<div class="sidebar-overlay" id="sidebarOverlay"></div>
```

### 1.2 Hamburger + Overlay CSS

```css
.hamburger {
  display: none;
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 1001;
  background: var(--sidebar-bg);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 1.2rem;
  cursor: pointer;
}
.sidebar-overlay {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5);
  z-index: 999;
}
.sidebar-overlay.active {
  display: block;
}
```

### 1.3 Media Queries

```css
@media (max-width: 768px) {
  .hamburger { display: block; }

  .sidebar {
    position: fixed;
    left: -220px;
    top: 0;
    height: 100vh;
    transition: left 0.3s ease;
    z-index: 1000;
  }
  .sidebar.open { left: 0; }

  .main-content {
    padding: 15px;
    padding-top: 50px;
  }

  .grid {
    grid-template-columns: 1fr !important;
  }

  .stats {
    grid-template-columns: 1fr !important;
  }

  .month-calendar {
    min-width: unset;
    width: 100%;
  }

  #monthlySummary, #yearlySummary {
    flex-direction: column;
    gap: 10px;
  }

  .filters {
    flex-direction: column;
  }

  .transactions-list {
    max-height: none;
  }

  .transaction {
    flex-wrap: wrap;
    gap: 5px;
  }
}
```

### 1.4 JavaScript for Hamburger Toggle

```js
document.getElementById('hamburger').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('active');
});

document.getElementById('sidebarOverlay').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('active');
});

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelector('.sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('active');
  });
});
```

---

## Part 2: Firebase Cross-Device Sync

### 2.1 Firebase Project Setup (One-Time)

1. Go to https://console.firebase.google.com
2. Create a new project (e.g., `budget-tracker-sync`)
3. Enable **Firestore Database**:
   - Go to Firestore Database > Create Database
   - Start in **test mode** (we'll add security rules later)
   - Choose a location close to you
4. Enable **Google Sign-In**:
   - Go to Authentication > Sign-in method
   - Enable **Google** as a provider
   - Set your support email
5. Register a **Web App**:
   - Go to Project Settings (gear icon) > General > Your apps > Add app > Web
   - Register with nickname (e.g., "Budget Tracker Web")
   - Copy the `firebaseConfig` object (you'll need this)
6. Add your GitHub Pages domain to **Authorized domains**:
   - Go to Authentication > Settings > Authorized domains
   - Add `zmstiles-dev.github.io`

### 2.2 Firebase Config Object

After setup, you'll have a config object like this (replace with your actual values):

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

### 2.3 Add Firebase SDK (CDN)

Add to `<head>`:

```html
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>
```

### 2.4 Initialize Firebase

```js
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const provider = new firebase.auth.GoogleAuthProvider();
```

### 2.5 Firestore Data Model

All data stored under `shared/data/` (shared across all authenticated users):

| Field | Firestore Path | Type |
|---|---|---|
| Transactions | `shared/data/main` (field: `transactions`) | Array |
| Categories | `shared/data/main` (field: `categories`) | Array |
| Budgets | `shared/data/main` (field: `budgets`) | Object |
| Merchant Defaults | `shared/data/main` (field: `merchantDefaults`) | Object |
| Category Groups | `shared/data/main` (field: `categoryGroups`) | Array |
| Category Colors | `shared/data/main` (field: `categoryColors`) | Object |
| Category Order | `shared/data/main` (field: `categoryOrder`) | Array |

**Note:** `budget_theme` stays in localStorage (device-specific preference).

### 2.6 Security Rules

Set in Firebase Console > Firestore > Rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /shared/{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

### 2.7 Login Screen

Add a login screen div (hidden by default) that shows before the app if the user isn't authenticated:

```html
<div id="loginScreen" class="hidden" style="display:flex;justify-content:center;align-items:center;min-height:100vh;background:var(--bg);">
  <div class="card" style="text-align:center;padding:40px;max-width:400px;">
    <h2 style="margin-bottom:20px;">Budget Tracker</h2>
    <p style="margin-bottom:20px;color:var(--muted);">Sign in to sync your budget across devices</p>
    <button class="btn btn-primary" id="googleSignIn" style="padding:12px 24px;font-size:1rem;">
      Sign in with Google
    </button>
  </div>
</div>
```

### 2.8 Auth Flow JS

```js
const ALLOWED_EMAILS = ['captainicebow@gmail.com', 'mgstiles13@gmail.com', 'zmstiles@gmail.com'];

// Show login screen or app based on auth state
auth.onAuthStateChanged((user) => {
  if (user) {
    if (!ALLOWED_EMAILS.includes(user.email)) {
      alert('Access denied. This account is not authorized.');
      auth.signOut();
      return;
    }
    document.getElementById('loginScreen').classList.add('hidden');
    document.querySelector('.app-layout').style.display = 'flex';
    currentUser = user;
    loadFromFirestore();
  } else {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.querySelector('.app-layout').style.display = 'none';
  }
});

// Google sign-in
document.getElementById('googleSignIn').addEventListener('click', () => {
  auth.signInWithPopup(provider).catch((error) => {
    console.error("Sign-in error:", error);
    alert("Sign-in failed: " + error.message);
  });
});
```

### 2.9 Replace localStorage with Firestore

**Replace `loadData()`** with Firestore reads:

```js
async function loadFromFirestore() {
  const doc = await db.collection('users').doc(currentUser.uid)
    .collection('data').doc('main').get();

  if (doc.exists) {
    const data = doc.data();
    transactions = data.transactions || [];
    categories = data.categories || [];
    budgets = data.budgets || {};
    merchantDefaults = data.merchantDefaults || {};
    categoryGroups = data.categoryGroups || [];
    categoryColors = data.categoryColors || {};
    categoryOrder = data.categoryOrder || [];
  } else {
    // First time: migrate from localStorage if data exists
    migrateFromLocalStorage();
    await saveToFirestore();
  }

  renderAll();
}
```

**Replace `saveData()` and related functions** with Firestore write:

```js
async function saveToFirestore() {
  const data = {
    transactions,
    categories,
    budgets,
    merchantDefaults,
    categoryGroups,
    categoryColors,
    categoryOrder,
    lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
  };

  await db.collection('users').doc(currentUser.uid)
    .collection('data').doc('main').set(data);

  // Also save to localStorage as offline backup
  localStorage.setItem('budget_transactions', JSON.stringify(transactions));
  localStorage.setItem('budget_categories', JSON.stringify(categories));
  localStorage.setItem('budget_budgets', JSON.stringify(budgets));
  localStorage.setItem('budget_merchant_defaults', JSON.stringify(merchantDefaults));
  localStorage.setItem('budget_category_groups', JSON.stringify(categoryGroups));
  localStorage.setItem('budget_category_colors', JSON.stringify(categoryColors));
  localStorage.setItem('budget_category_order', JSON.stringify(categoryOrder));
}
```

**Offline fallback** in `loadFromFirestore()`:

```js
async function loadFromFirestore() {
  try {
    const doc = await db.collection('users').doc(currentUser.uid)
      .collection('data').doc('main').get();

    if (doc.exists) {
      // Use Firestore data
      const data = doc.data();
      transactions = data.transactions || [];
      // ... etc
    }
  } catch (error) {
    console.warn("Firestore unavailable, using localStorage:", error);
    // Fall back to localStorage
    loadData(); // existing function
    return;
  }
  renderAll();
}
```

### 2.10 Migration from Existing localStorage Data

Add a function to migrate existing data on first login:

```js
function migrateFromLocalStorage() {
  try {
    transactions = JSON.parse(localStorage.getItem('budget_transactions') || '[]');
    categories = JSON.parse(localStorage.getItem('budget_categories') || '[]');
    budgets = JSON.parse(localStorage.getItem('budget_budgets') || '{}');
    merchantDefaults = JSON.parse(localStorage.getItem('budget_merchant_defaults') || '{}');
    categoryGroups = JSON.parse(localStorage.getItem('budget_category_groups') || '[]');
    categoryColors = JSON.parse(localStorage.getItem('budget_category_colors') || '{}');
    categoryOrder = JSON.parse(localStorage.getItem('budget_category_order') || '[]');
  } catch (e) {
    console.error("Migration error:", e);
  }
}
```

---

## Part 3: GitHub Pages Deployment

1. Go to repo **Settings** > **Pages**
2. Under **Source**, select "Deploy from a branch"
3. Branch: `main` (or `master`), folder: `/ (root)`
4. Click **Save**
5. Wait ~1-2 minutes for deployment
6. Site is live at: `https://zmstiles-dev.github.io/budget-tool/`

### Firebase Authorized Domains

Add `zmstiles-dev.github.io` to Firebase authorized domains:
- Firebase Console > Authentication > Settings > Authorized domains > Add domain

---

## Part 4: Add to Home Screen (Optional)

Add these meta tags to `<head>`:

```html
<meta name="theme-color" content="#2c3e50">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Budget Tracker">
<link rel="apple-touch-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%232c3e50'/><text x='50' y='65' font-size='50' text-anchor='middle' fill='white'>$</text></svg>">
```

This enables "Add to Home Screen" on iOS/Android with a custom icon.

---

## Implementation Order

1. Responsive CSS + hamburger menu (no dependencies)
2. Firebase project setup (manual step by user)
3. Firebase SDK + auth integration
4. Replace localStorage reads/writes with Firestore
5. Offline fallback (localStorage backup)
6. Deploy to GitHub Pages
7. Add to Home Screen meta tags

---

## Testing Checklist

- [ ] Desktop layout unchanged (sidebar visible, 2-column grids)
- [ ] Mobile: hamburger menu appears, sidebar slides in/out
- [ ] Mobile: grids stack to single column
- [ ] Mobile: summary banners stack vertically
- [ ] Mobile: transaction filters wrap properly
- [ ] Mobile: tap nav item closes sidebar
- [ ] Mobile: tap overlay closes sidebar
- [ ] Firebase: Google sign-in works
- [ ] Firebase: data saves to Firestore after login
- [ ] Firebase: data loads from Firestore on page refresh
- [ ] Firebase: data syncs between two devices/browsers
- [ ] Offline: app works with localStorage when offline
- [ ] Export/Import: JSON export still works
- [ ] Theme toggle: still works on both desktop and mobile
