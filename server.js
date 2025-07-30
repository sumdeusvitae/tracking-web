const express = require('express');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage for tracking links and sessions
// In production, use Redis or a database
const trackingLinks = new Map();
const driverToLinkId = new Map(); // Map of driverName → linkId

// const users = new Map([
//   ['admin', { password: 'password123', name: 'Administrator' }],
//   ['user1', { password: 'demo123', name: 'Demo User' }]
// ]);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-here',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Set EJS as template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
};

// Fetch drivers from your actual API
async function fetchDriversFromAPI() {
  try {
    console.log('Fetching drivers from API...');
    
    const response = await fetch('https://server-eld-666563578864.us-south1.run.app/drivers', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Driver-Tracking-Server/1.0'
      },
      timeout: 10000 // 10 second timeout
    });
    
    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status} ${response.statusText}`);
    }
    
    const drivers = await response.json();
    console.log(`Successfully fetched ${drivers.length} drivers from API`);
    
    // Validate the response format
    if (!Array.isArray(drivers)) {
      throw new Error('API response is not an array');
    }
    
    // Validate each driver has required fields
    drivers.forEach((driver, index) => {
      const requiredFields = ['name', 'truck_id', 'location', 'status', 'last_updated'];
      const missingFields = requiredFields.filter(field => !driver[field]);
      
      if (missingFields.length > 0) {
        console.warn(`Driver ${index} missing fields: ${missingFields.join(', ')}`);
      }
    });
    
    return drivers;
    
  } catch (error) {
    console.error('Error fetching drivers from API:', error.message);
    
    // Return mock data as fallback for development/testing
    console.log('Falling back to mock data for development...');
    return [
      {
        "name": "Albert Davis (Demo)",
        "status": "Off Duty",
        "location": "2mi SSE from Tremonton, UT",
        "truck_id": "507889",
        "shift_start": "08:00",
        "break_time": "09:14",
        "drive_time": "03:32",
        "cycle_time": "38:03",
        "connection_status": "",
        "reported_at": "08:54 AM CDT",
        "last_updated": "2025-07-15T17:55:04.913055887Z"
      },
      {
        "name": "Sarah Johnson (Demo)",
        "status": "Driving",
        "location": "Interstate 80, near Salt Lake City, UT",
        "truck_id": "507890",
        "shift_start": "06:00",
        "break_time": "07:30",
        "drive_time": "05:15",
        "cycle_time": "42:30",
        "connection_status": "Connected",
        "reported_at": "10:30 AM CDT",
        "last_updated": "2025-07-15T18:30:04.913055887Z"
      }
    ];
  }
}

// Routes

// Home page - redirect to login or dashboard
app.get('/', (req, res) => {
  if (req.session.user) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// Login page
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

// Login POST
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const envUsername = process.env.LOGIN_USERNAME;
  const envPassword = process.env.LOGIN_PASSWORD;

  if (username === envUsername && password === envPassword) {
    req.session.user = { username, name: 'Administrator' }; // You can customize the name here
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Invalid username or password' });
  }
});


// Dashboard page (requires authentication)
app.get('/dashboard', requireAuth, async (req, res) => {
  console.log('✅ /dashboard route hit');
  try {
    const drivers = await fetchDriversFromAPI();
    console.log('✅ Drivers loaded');

    res.render('dashboard', {
      user: req.session.user,
      drivers,
      message: null
    });
  } catch (err) {
    console.error('❌ Error in /dashboard:', err);
    res.status(500).send('Dashboard render failed');
  }
});


// Generate tracking link
app.post('/generate-link', requireAuth, async (req, res) => {
  const { driverName, expirationHours } = req.body;
  
  if (!driverName || !expirationHours) {
    return res.status(400).json({ error: 'Driver name and expiration time are required' });
  }
  
  try {
    const drivers = await fetchDriversFromAPI();
    const selectedDriver = drivers.find(d => d.name === driverName);
    
    if (!selectedDriver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    // Check for existing active link
    const existingLinkId = driverToLinkId.get(driverName);
    if (existingLinkId) {
      const existing = trackingLinks.get(existingLinkId);
      if (existing && new Date() < existing.expiresAt) {
        return res.status(400).json({ 
          error: 'Tracking link already exists for this driver',
          existingLink: `${req.protocol}://${req.get('host')}/track/${existingLinkId}`,
          expiresAt: existing.expiresAt.toISOString()
        });
      } else {
        // Clean up expired link
        trackingLinks.delete(existingLinkId);
        driverToLinkId.delete(driverName);
      }
    }

    const linkId = uuidv4();
    const expirationTime = new Date(Date.now() + (parseInt(expirationHours) * 60 * 60 * 1000));
    
    // Store new link
    trackingLinks.set(linkId, {
      driverName: selectedDriver.name,
      createdAt: new Date(),
      expiresAt: expirationTime,
      createdBy: req.session.user.username
    });
    driverToLinkId.set(driverName, linkId);
    
    const trackingUrl = `${req.protocol}://${req.get('host')}/track/${linkId}`;
    
    res.json({
      success: true,
      trackingUrl: trackingUrl,
      expiresAt: expirationTime.toISOString(),
      driverName: selectedDriver.name
    });
    
  } catch (error) {
    console.error('Error generating tracking link:', error);
    res.status(500).json({ error: 'Failed to generate tracking link' });
  }
});


// Cancel link
app.post('/cancel-link', requireAuth, (req, res) => {
  const { driverName } = req.body;

  const linkId = driverToLinkId.get(driverName);
  if (!linkId || !trackingLinks.has(linkId)) {
    return res.status(404).json({ error: 'No active tracking link found for this driver' });
  }

  trackingLinks.delete(linkId);
  driverToLinkId.delete(driverName);

  console.log(`Tracking link manually canceled for ${driverName}`);
  res.json({ success: true });
});



// Public tracking page
app.get('/track/:id', async (req, res) => {
  const linkId = req.params.id;
  const linkData = trackingLinks.get(linkId);
  
  if (!linkData) {
    return res.render('tracking', { 
      error: 'Invalid tracking link',
      driver: null 
    });
  }
  
  // Check if link has expired
  if (new Date() > linkData.expiresAt) {
    return res.render('tracking', { 
      error: 'This tracking link has expired',
      driver: null 
    });
  }
  
  try {
    const drivers = await fetchDriversFromAPI();
    const driver = drivers.find(d => d.name === linkData.driverName);
    const formattedLastUpdated = formatTimestampInCDT(driver.last_updated);
    
    if (!driver) {
      return res.render('tracking', { 
        error: 'Driver data not available',
        driver: null 
      });
    }
    
    res.render('tracking', { 
      error: null,
      driver: driver,
      formattedLastUpdated: formattedLastUpdated,
      expiresAt: linkData.expiresAt
    });
    
  } catch (error) {
    console.error('Error fetching driver data for tracking:', error);
    res.render('tracking', { 
      error: 'Unable to fetch current driver location',
      driver: null 
    });
  }
});

// API endpoint for refreshing tracking data
app.get('/api/track/:id', async (req, res) => {
  const linkId = req.params.id;
  const linkData = trackingLinks.get(linkId);
  
  if (!linkData || new Date() > linkData.expiresAt) {
    return res.status(404).json({ error: 'Invalid or expired tracking link' });
  }
  
  try {
    const drivers = await fetchDriversFromAPI();
    const driver = drivers.find(d => d.name === linkData.driverName);
    
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }
    
    res.json({
      driver: driver,
      expiresAt: linkData.expiresAt
    });
    
  } catch (error) {
    console.error('Error fetching driver data:', error);
    res.status(500).json({ error: 'Failed to fetch driver data' });
  }
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/login');
  });
});

// Cleanup expired links (run every hour)
setInterval(() => {
  const now = new Date();
  for (const [linkId, linkData] of trackingLinks.entries()) {
    if (now > linkData.expiresAt) {
      trackingLinks.delete(linkId);
      driverToLinkId.delete(linkData.driverName);
      console.log(`Cleaned up expired tracking link: ${linkId} for ${linkData.driverName}`);
    }
  }
}, 60 * 60 * 1000); // every hour


// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('Page not found');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Demo credentials:');
  console.log('Username: admin, Password: password123');
  console.log('Username: user1, Password: demo123');
});

// helper functions
function formatTimestampInCDT(isoTimestamp) {
  if (!isoTimestamp) return 'N/A';

  // Normalize nanoseconds to milliseconds precision
  const normalized = isoTimestamp.replace(/\.(\d{3})\d*Z$/, '.$1Z');
  const date = new Date(normalized);

  const options = { 
    year: 'numeric', month: 'long', day: 'numeric', 
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true,
    timeZone: 'America/Chicago',
    timeZoneName: 'short' 
  };

  return date.toLocaleString('en-US', options);
}


module.exports = app;