require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileUpload());
app.use(express.static('public'));

const config = require('./config.json');

// Handle unhandled rejections gracefully without crashing
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't crash the app, just log the error
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Log but don't immediately exit in production
});

const db = new sqlite3.Database('messages.db');
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS sent_messages (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      device_id TEXT NOT NULL,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'pending'
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'offline',
      last_active DATETIME
    )
  `);
});

// Device Manager
class DeviceManager {
  constructor() {
    this.devices = new Map();
    this.activeSessions = new Map();
  }

  async init() {
    // Load devices from DB
    return new Promise((resolve, reject) => {
      db.all("SELECT * FROM devices", [], (err, rows) => {
        if (err) return reject(err);
        
        rows.forEach(row => {
          this.devices.set(row.id, {
            ...row,
            client: null
          });
        });
        resolve();
      });
    });
  }

  async addDevice(deviceName) {
    const deviceId = uuidv4();
    
    return new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO devices (id, name, status) VALUES (?, ?, ?)",
        [deviceId, deviceName, 'offline'],
        (err) => {
          if (err) return reject(err);
          
          this.devices.set(deviceId, {
            id: deviceId,
            name: deviceName,
            status: 'offline',
            client: null
          });
          
          resolve(deviceId);
        }
      );
    });
  }

  async startDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error("Device not found");
    
    try {
      // Close existing client if any
      if (device.client) {
        try {
          await device.client.destroy();
        } catch (error) {
          console.error(`Error destroying existing client for ${deviceId}:`, error);
        }
      }
      
      device.client = new Client({
        authStrategy: new LocalAuth({ clientId: deviceId }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
          ]
        }
      });
      
      // Event handlers
      device.client.on('qr', qr => {
        this.activeSessions.set(deviceId, qr);
        device.status = 'awaiting_qr';
        db.run("UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?", ['awaiting_qr', deviceId]);
        console.log(`Device ${deviceId} QR generated`);
      });

      device.client.on('ready', () => {
        device.status = 'online';
        db.run("UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?", ['online', deviceId]);
        console.log(`Device ${deviceId} is ready!`);
      });

      device.client.on('disconnected', async (reason) => {
        console.log(`Device ${deviceId} disconnected: ${reason}`);
        try {
          await this.handleDeviceDisconnection(deviceId, reason);
        } catch (error) {
          console.error(`Error handling disconnection for ${deviceId}:`, error);
        }
      });

      device.client.on('auth_failure', (msg) => {
        device.status = 'auth_failed';
        db.run("UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?", ['auth_failed', deviceId]);
        console.log(`Device ${deviceId} auth failed: ${msg}`);
      });

      device.client.on('error', (error) => {
        console.error(`Client error for device ${deviceId}:`, error);
      });

      // Start the client
      await device.client.initialize();
      
      return { status: 'initialized' };
    } catch (err) {
      console.error(`Device ${deviceId} error:`, err);
      device.status = 'error';
      db.run("UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?", ['error', deviceId]);
      throw err;
    }
  }

  async handleDeviceDisconnection(deviceId, reason) {
    const device = this.devices.get(deviceId);
    if (!device) return;
    
    try {
      // Update status
      device.status = 'offline';
      device.client = null;
      
      // Update database
      db.run("UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?", ['offline', deviceId]);
      
      // Clean up sessions
      this.activeSessions.delete(deviceId);
      
      console.log(`Device ${deviceId} properly cleaned up after disconnection`);
    } catch (error) {
      console.error(`Error during cleanup for ${deviceId}:`, error);
    }
  }

  async logoutDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return;
    
    console.log(`Logging out device ${deviceId}`);
    try {
      if (device.client) {
        await device.client.destroy();
      }
      this.devices.delete(deviceId);
      db.run("DELETE FROM devices WHERE id = ?", [deviceId]);
      this.activeSessions.delete(deviceId);
    } catch (err) {
      console.error(`Logout failed for ${deviceId}:`, err);
    }
  }

  async logoutAll() {
    const results = [];
    for (const [deviceId] of this.devices) {
      try {
        await this.logoutDevice(deviceId);
        results.push({ deviceId, success: true });
      } catch (err) {
        results.push({ deviceId, success: false, error: err.message });
      }
    }
    console.log(`All devices logged out: ${results.length} devices processed`);
    return results;
  }

  async getDevices() {
    return Array.from(this.devices.values()).map(device => ({
      id: device.id,
      name: device.name,
      status: device.status,
      last_active: device.last_active
    }));
  }

  async sendMessage(phone, message) {
    // Find next available device (round-robin)
    const onlineDevices = Array.from(this.devices.values())
      .filter(d => d.status === 'online' && d.client);
      
    if (onlineDevices.length === 0) {
      throw new Error("No online devices available");
    }
    
    // Get next device in rotation
    const device = onlineDevices[Math.floor(Math.random() * onlineDevices.length)];
    
    // Create message ID for deduplication
    const msgId = uuidv4();
    
    try {
      // Format phone number correctly for WhatsApp
      let formattedPhone = phone.replace(/\D/g, '');
      
      // Add country code if not present (assuming India +91 as default)
      if (formattedPhone.length === 10) {
        formattedPhone = '91' + formattedPhone;
      }
      
      // WhatsApp format: number@c.us
      const whatsappId = formattedPhone + '@c.us';
      
      console.log(`Sending message to ${whatsappId} via device ${device.id}`);
      
      // Check if client is ready
      if (!device.client) {
        throw new Error(`Device ${device.id} client not available`);
      }

      const state = await device.client.getState();
      if (state !== 'CONNECTED') {
        throw new Error(`Device ${device.id} not connected. State: ${state}`);
      }
      
      // Insert into DB first to prevent duplicates
      await new Promise((resolve, reject) => {
        db.run(
          "INSERT INTO sent_messages (id, phone, message, device_id) VALUES (?, ?, ?, ?)",
          [msgId, formattedPhone, message, device.id],
          (err) => err ? reject(err) : resolve()
        );
      });
      
      // Add a small delay to ensure page is stable
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Send the message
      await device.client.sendMessage(whatsappId, message);
      
      // Update status in DB
      db.run("UPDATE sent_messages SET status = ? WHERE id = ?", ['sent', msgId]);
      
      console.log(`Message sent successfully to ${formattedPhone}`);
      return { success: true, deviceId: device.id, messageId: msgId };
    } catch (err) {
      console.error(`Send message error for ${phone}:`, err.message);
      db.run("UPDATE sent_messages SET status = ? WHERE id = ?", ['failed', msgId]);
      
      // If it's an evaluation error, try to restart the client
      if (err.message.includes('Evaluation failed') || err.message.includes('Target closed')) {
        console.log(`Restarting client for device ${device.id} due to connection error`);
        setTimeout(() => {
          this.restartDevice(device.id);
        }, 5000);
      }
      
      throw new Error(`Failed to send message: ${err.message}`);
    }
  }

  async restartDevice(deviceId) {
    console.log(`Restarting device ${deviceId}`);
    try {
      await this.handleDeviceDisconnection(deviceId, 'restart');
      // Wait a bit before reinitializing
      setTimeout(() => {
        this.startDevice(deviceId).catch(err => {
          console.error(`Failed to restart device ${deviceId}:`, err);
        });
      }, 5000);
    } catch (error) {
      console.error(`Error restarting device ${deviceId}:`, error);
    }
  }
}

// Initialize device manager
const deviceManager = new DeviceManager();
deviceManager.init().catch(err => console.error('Device init error:', err));

// Auto-clean old messages (TTL 7 days)
cron.schedule('0 0 * * *', () => {
  db.run("DELETE FROM sent_messages WHERE sent_at < datetime('now', '-7 days')", (err) => {
    if (err) {
      console.error('Auto-cleanup error:', err);
    } else {
      console.log('Old messages cleaned up');
    }
  });
});

// Web Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/devices', async (req, res) => {
  try {
    const devices = await deviceManager.getDevices();
    res.json(devices);
  } catch (err) {
    console.error('Get devices error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/add-device', async (req, res) => {
  try {
    const { deviceName } = req.body;
    if (!deviceName || !deviceName.trim()) {
      return res.status(400).json({ error: 'Device name is required' });
    }
    
    const deviceId = await deviceManager.addDevice(deviceName.trim());
    res.json({ success: true, deviceId });
  } catch (err) {
    console.error('Add device error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/start-device/:id', async (req, res) => {
  try {
    const result = await deviceManager.startDevice(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Start device error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/qr-code/:deviceId', async (req, res) => {
  try {
    const qrData = deviceManager.activeSessions.get(req.params.deviceId);
    if (!qrData) {
      return res.status(404).json({ error: "QR not available" });
    }
    
    // Generate QR image
    const qrImage = await new Promise((resolve, reject) => {
      require('qrcode').toDataURL(qrData, (err, url) => {
        if (err) reject(err);
        else resolve(url);
      });
    });
    
    res.json({ qrImage });
  } catch (err) {
    console.error('QR code error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/logout-device/:id', async (req, res) => {
  try {
    await deviceManager.logoutDevice(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Logout device error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/logout-all', async (req, res) => {
  try {
    const results = await deviceManager.logoutAll();
    res.json({ success: true, results });
  } catch (err) {
    console.error('Logout all error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/upload-csv', async (req, res) => {
  try {
    let messages = [];
    
    if (req.files && req.files.csv) {
      const csvFile = req.files.csv;
      const filePath = path.join(__dirname, 'uploads', `${Date.now()}.csv`); 
      if (!fs.existsSync('uploads')) {
        fs.mkdirSync('uploads');
      }
      csvFile.mv(filePath, (err) => {
        if (err) return res.status(500).json({ error: err.message }); 
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => {
            if (row.phone && row.message) {
              messages.push({
                phone: row.phone.toString().replace(/\D/g, ''),
                message: row.message
              });
            }
          })
          .on('end', () => {
            processMessages(messages, res);
          });
      });
    } else if (Array.isArray(req.body)) {
      messages = req.body.map(item => ({
        phone: item.phone.toString().replace(/\D/g, ''),
        message: item.message
      }));
      processMessages(messages, res);
    } else {
      return res.status(400).json({ error: "Invalid request format" });
    }
  } catch (err) {
    console.error('Upload CSV error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function processMessages(messages, res) {
  res.json({ success: true, count: messages.length });
  
  let successCount = 0;
  let failCount = 0;
  
  console.log(`Starting to process ${messages.length} messages`);
  
  for (const msg of messages) {
    try {
      await deviceManager.sendMessage(msg.phone, msg.message);
      successCount++;
      console.log(`✓ Message ${successCount}/${messages.length} sent to ${msg.phone}`);
      
      if (successCount < messages.length) {
        await new Promise(resolve => 
          setTimeout(resolve, config.messageInterval || 30000)
        );
      }
    } catch (err) {
      console.error(`✗ Failed to send message ${successCount + failCount + 1}/${messages.length} to ${msg.phone}:`, err.message);
      failCount++;
    }
  }
  
  console.log(`Message processing complete: ${successCount} sent, ${failCount} failed`);
}

app.delete('/clear-db', (req, res) => {
  try {
    db.run("DELETE FROM sent_messages", (err) => {
      if (err) {
        console.error('Clear DB error:', err);
        return res.status(500).json({ error: err.message });
      }
      console.log('Database cleared');
      res.json({ success: true });
    });
  } catch (err) {
    console.error('Clear DB error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    devices: deviceManager.devices.size,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || config.port || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Bulk Sender running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  try {
    await deviceManager.logoutAll();
    db.close();
    console.log('✅ Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('❌ Shutdown error:', err);
    process.exit(1);
  }
});