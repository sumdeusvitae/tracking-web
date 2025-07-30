const express = require('express');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();
const db = require('./firebase'); // Firestore

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-here',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const requireAuth = (req, res, next) => {
  if (req.session.user) next();
  else res.redirect('/login');
};

// Fetch drivers from API
async function fetchDriversFromAPI() {
  try {
    const response = await fetch('https://server-eld-666563578864.us-south1.run.app/drivers', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Driver-Tracking-Server/1.0' },
      timeout: 10000
    });

    if (!response.ok) throw new Error(`API responded with ${response.status}`);
    const drivers = await response.json();
    if (!Array.isArray(drivers)) throw new Error('Invalid driver data format');
    return drivers;
  } catch (err) {
    console.error('Driver API failed, returning mock data...');
    return [
      {
        name: "Albert Davis (Demo)",
        status: "Off Duty",
        location: "2mi SSE from Tremonton, UT",
        truck_id: "507889",
        shift_start: "08:00",
        break_time: "09:14",
        drive_time: "03:32",
        cycle_time: "38:03",
        connection_status: "",
        reported_at: "08:54 AM CDT",
        last_updated: "2025-07-15T17:55:04.913055887Z"
      }
    ];
  }
}

// Routes

app.get('/', (req, res) => {
  if (req.session.user) res.redirect('/dashboard');
  else res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.LOGIN_USERNAME && password === process.env.LOGIN_PASSWORD) {
    req.session.user = { username, name: 'Administrator' };
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Invalid username or password' });
  }
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const drivers = await fetchDriversFromAPI();
    res.render('dashboard', { user: req.session.user, drivers, message: null });
  } catch (err) {
    res.status(500).send('Dashboard load failed');
  }
});

// Generate link
app.post('/generate-link', requireAuth, async (req, res) => {
  const { driverName, expirationHours } = req.body;
  if (!driverName || !expirationHours) return res.status(400).json({ error: 'Missing fields' });

  try {
    const drivers = await fetchDriversFromAPI();
    const selectedDriver = drivers.find(d => d.name === driverName);
    if (!selectedDriver) return res.status(404).json({ error: 'Driver not found' });

    // Invalidate old links
    const existing = await db.collection('trackingLinks')
      .where('driverName', '==', driverName)
      .where('active', '==', true)
      .get();

    for (const doc of existing.docs) {
      await doc.ref.update({ active: false });
    }

    const linkId = uuidv4();
    const expirationTime = new Date(Date.now() + parseInt(expirationHours) * 60 * 60 * 1000);

    await db.collection('trackingLinks').doc(linkId).set({
      driverName,
      createdAt: new Date(),
      expiresAt: expirationTime,
      createdBy: req.session.user.username,
      active: true
    });

    const trackingUrl = `${req.protocol}://${req.get('host')}/track/${linkId}`;

    res.json({ success: true, trackingUrl, expiresAt: expirationTime.toISOString(), driverName });

  } catch (error) {
     console.error('❌ Error generating tracking link:', error.stack || error);
  res.status(500).json({ error: 'Failed to generate tracking link' });
  }
});

// Cancel link
app.post('/cancel-link', requireAuth, async (req, res) => {
  const { driverName } = req.body;

  const snapshot = await db.collection('trackingLinks')
    .where('driverName', '==', driverName)
    .where('active', '==', true)
    .get();

  if (snapshot.empty) return res.status(404).json({ error: 'No active tracking link' });

  for (const doc of snapshot.docs) {
    await doc.ref.update({ active: false });
  }

  res.json({ success: true });
});

// Tracking view
app.get('/track/:linkId', async (req, res) => {
  const { linkId } = req.params;
  const doc = await db.collection('trackingLinks').doc(linkId).get();
  if (!doc.exists) return res.status(403).send('Invalid or expired link');

  const link = doc.data();
  if (!link.active || new Date() > link.expiresAt.toDate()) {
    return res.status(403).send('Link expired or inactive');
  }

  try {
    const drivers = await fetchDriversFromAPI();
    const driver = drivers.find(d => d.name === link.driverName);
    if (!driver) {
      return res.render('tracking', { error: 'Driver data missing', driver: null });
    }

    const formattedLastUpdated = formatTimestampInCDT(driver.last_updated);
    res.render('tracking', {
      error: null,
      driver,
      formattedLastUpdated,
      expiresAt: link.expiresAt.toDate()
    });

  } catch (error) {
    res.render('tracking', { error: 'Unable to fetch driver', driver: null });
  }
});

// Tracking API
app.get('/api/track/:id', async (req, res) => {
  const doc = await db.collection('trackingLinks').doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Invalid link' });

  const link = doc.data();
  if (new Date() > link.expiresAt.toDate()) {
    return res.status(404).json({ error: 'Expired link' });
  }

  const drivers = await fetchDriversFromAPI();
  const driver = drivers.find(d => d.name === link.driverName);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  res.json({ driver, expiresAt: link.expiresAt.toDate() });
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Clean up expired links hourly
setInterval(async () => {
  const now = new Date();
  const snapshot = await db.collection('trackingLinks')
    .where('expiresAt', '<', now)
    .where('active', '==', true)
    .get();

  for (const doc of snapshot.docs) {
    await doc.ref.update({ active: false });
    console.log(`Expired link deactivated: ${doc.id}`);
  }
}, 60 * 60 * 1000);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

app.use((req, res) => res.status(404).send('Page not found'));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

function formatTimestampInCDT(isoTimestamp) {
  if (!isoTimestamp) return 'N/A';
  const normalized = isoTimestamp.replace(/\.(\d{3})\d*Z$/, '.$1Z');
  const date = new Date(normalized);
  return date.toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true, timeZone: 'America/Chicago', timeZoneName: 'short'
  });
}
