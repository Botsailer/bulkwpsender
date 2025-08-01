require("dotenv").config();
const express = require("express");
const fileUpload = require("express-fileupload");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const cron = require("node-cron");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const puppeteer = require("puppeteer");
const qrcode = require("qrcode");
const os = require("os");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileUpload());
app.use(express.static("public"));

const config = require("./config.json");

// Database setup
const db = new sqlite3.Database("messages.db");
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
  
  db.run(`
    CREATE TABLE IF NOT EXISTS pending_messages (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      device_id TEXT NOT NULL,
      hi_sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      hi_message_id TEXT,
      status TEXT DEFAULT 'pending_reply'
    )
  `);

  // Add reconnect_attempts column if it doesn't exist
  db.run(`
    ALTER TABLE devices ADD COLUMN reconnect_attempts INTEGER DEFAULT 0
  `, (err) => {
    // Ignore "duplicate column" errors
    if (err && !err.message.includes("duplicate column")) {
      console.error("Error adding reconnect_attempts column:", err);
    }
  });
});

// Device Manager
class DeviceManager {
  constructor() {
    this.devices = new Map();
    this.activeSessions = new Map();
    this.messageListeners = new Map();
    this.reconnectTimers = new Map();
    this.MAX_RECONNECT_ATTEMPTS = 10;
    this.RECONNECT_BASE_DELAY = 5000; // 5 seconds
  }

  async init() {
    return new Promise((resolve, reject) => {
      db.all("SELECT * FROM devices", [], (err, rows) => {
        if (err) return reject(err);
        rows.forEach((row) => {
          this.devices.set(row.id, {
            ...row,
            client: null,
            browser: null,
            reconnectAttempts: row.reconnect_attempts || 0
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
        [deviceId, deviceName, "offline"],
        (err) => {
          if (err) return reject(err);
          this.devices.set(deviceId, {
            id: deviceId,
            name: deviceName,
            status: "offline",
            client: null,
            browser: null,
            reconnectAttempts: 0
          });
          resolve(deviceId);
        },
      );
    });
  }

  async startDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error("Device not found");

    // Clear any existing reconnect timer
    this.clearReconnectTimer(deviceId);

    try {
      device.status = "starting";
      device.reconnectAttempts = 0; // Reset attempts on manual start
      db.run(
        "UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP, reconnect_attempts = ? WHERE id = ?",
        ["starting", 0, deviceId],
      );

      // Clean up existing sessions
      await this.cleanupDeviceResources(deviceId);

      let attempts = 0;
      const maxAttempts = 3;
      let success = false;

      while (attempts < maxAttempts && !success) {
        attempts++;
        try {
          console.log(`Starting device ${deviceId} (attempt ${attempts}/${maxAttempts})`);
          
          const browserConfig = await this.getBrowserConfig();
          console.log(`Using browser configuration:`, browserConfig.executablePath ? `Custom path: ${browserConfig.executablePath}` : 'Puppeteer bundled Chromium');

          // Launch browser with the detected configuration
          device.browser = await puppeteer.launch(browserConfig);

          device.client = new Client({
            authStrategy: new LocalAuth({ clientId: deviceId }),
            browser: device.browser,
            puppeteer: {
              handleSIGINT: false,
              handleSIGTERM: false,
              handleSIGHUP: false
            }
          });

          device.client.on("qr", (qr) => {
            this.activeSessions.set(deviceId, qr);
            device.status = "awaiting_qr";
            db.run(
              "UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?",
              ["awaiting_qr", deviceId],
            );
            console.log(`Device ${deviceId} QR generated`);
          });

          device.client.on("ready", () => {
            device.status = "online";
            device.reconnectAttempts = 0; // Reset on successful connection
            db.run(
              "UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP, reconnect_attempts = ? WHERE id = ?",
              ["online", 0, deviceId],
            );
            console.log(`Device ${deviceId} is ready!`);
            
            // Set up message listener when device is ready
            this.setupMessageListener(device.client, deviceId);
          });

          device.client.on("disconnected", async (reason) => {
            console.log(`Device ${deviceId} disconnected: ${reason}`);
            await this.handleDeviceDisconnection(deviceId, reason);
          });

          device.client.on("auth_failure", (msg) => {
            device.status = "auth_failed";
            db.run(
              "UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?",
              ["auth_failed", deviceId],
            );
            console.log(`Device ${deviceId} auth failed: ${msg}`);
          });

          device.client.on("error", (error) => {
            console.error(`Client error for device ${deviceId}:`, error);
          });

          await device.client.initialize();
          success = true;
          console.log(`Device ${deviceId} started successfully`);
          
        } catch (err) {
          console.error(`Attempt ${attempts} failed:`, err.message);
          
          // Clean up failed attempt
          await this.cleanupDeviceResources(deviceId);
          
          if (attempts < maxAttempts) {
            const delay = 2000 * attempts;
            console.log(`Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            throw new Error(`Start failed after ${maxAttempts} attempts: ${err.message}`);
          }
        }
      }

      return { status: "initialized" };
      
    } catch (err) {
      console.error(`Device ${deviceId} start error:`, err);
      device.status = "error";
      db.run(
        "UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?",
        ["error", deviceId],
      );
      
      // Schedule automatic reconnection
      this.scheduleReconnect(deviceId);
      throw err;
    }
  }

  async cleanupDeviceResources(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return;

    try {
      // Clean up message listener
      if (this.messageListeners.has(deviceId)) {
        const listener = this.messageListeners.get(deviceId);
        if (device.client) {
          device.client.removeListener('message', listener);
        }
        this.messageListeners.delete(deviceId);
        console.log(`🧹 Cleaned up message listener for device ${deviceId}`);
      }

      if (device.client) {
        try {
          await device.client.destroy();
        } catch (error) {
          console.error(`Error destroying client: ${error}`);
        }
        device.client = null;
      }

      if (device.browser) {
        try {
          if (device.browser.process() != null) {
            device.browser.process().kill('SIGINT');
          }
          await device.browser.close();
        } catch (error) {
          console.error(`Error closing browser: ${error}`);
        }
        device.browser = null;
      }
    } catch (error) {
      console.error(`Resource cleanup error for device ${deviceId}:`, error);
    }
  }

  async getBrowserConfig() {
    const { execSync } = require('child_process');
    
    // Base configuration
    const config = {
      headless: true,
      args: [
        "--disable-setuid-sandbox",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-translate",
        "--disable-sync",
        "--disable-notifications",
        "--disable-logging",
        "--disable-software-rasterizer",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      ],
      ignoreHTTPSErrors: true,
      defaultViewport: null
    };

    let executablePath = null;

    // 1. Check for custom config path first
    if (global.config && global.config.chromePath) {
      if (fs.existsSync(global.config.chromePath)) {
        executablePath = global.config.chromePath;
        console.log(`Using custom Chrome path: ${executablePath}`);
        config.executablePath = executablePath;
        return config;
      } else {
        console.warn(`Custom Chrome path ${global.config.chromePath} does not exist`);
      }
    }

    // 2. Try to find Puppeteer's bundled Chromium
    try {
      const puppeteerPath = require('puppeteer').executablePath();
      if (fs.existsSync(puppeteerPath)) {
        console.log(`Using Puppeteer bundled Chromium: ${puppeteerPath}`);
        config.executablePath = puppeteerPath;
        return config;
      }
    } catch (error) {
      console.log('Puppeteer bundled Chromium not found, checking system browsers...');
    }

    // 3. Check system browsers by platform
    const systemPaths = this.getSystemBrowserPaths();
    for (const path of systemPaths) {
      if (fs.existsSync(path)) {
        executablePath = path;
        console.log(`Found system browser: ${executablePath}`);
        config.executablePath = executablePath;
        return config;
      }
    }

    // 4. If no browser found, try to install Puppeteer's Chromium
    console.log('No browser found, attempting to install Puppeteer Chromium...');
    try {
      execSync('npx puppeteer browsers install chrome', { 
        stdio: 'inherit',
        timeout: 120000 // 2 minutes timeout
      });
      
      // Try to get Puppeteer path again after installation
      const puppeteerPath = require('puppeteer').executablePath();
      if (fs.existsSync(puppeteerPath)) {
        console.log(`Successfully installed and using Puppeteer Chromium: ${puppeteerPath}`);
        config.executablePath = puppeteerPath;
        return config;
      }
    } catch (installError) {
      console.error('Failed to install Puppeteer Chromium:', installError.message);
    }

    // 5. Final fallback - let Puppeteer handle it (might fail)
    console.log('Using Puppeteer default browser detection (last resort)');
    return config;
  }

  getSystemBrowserPaths() {
    const os = require('os');
    const platform = os.platform();
    
    if (platform === 'linux') {
      return [
          '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
          '/home/runner/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable'
      ];
    } else if (platform === 'win32') {
      const username = os.userInfo().username;
      return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        `C:\\Users\\${username}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
        'C:\\Program Files\\Chromium\\Application\\chromium.exe',
        'C:\\Program Files (x86)\\Chromium\\Application\\chromium.exe'
      ];
    } else if (platform === 'darwin') {
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
      ];
    }
    
    return [];
  }

  async handleDeviceDisconnection(deviceId, reason) {
    const device = this.devices.get(deviceId);
    if (!device) return;

    try {
      device.status = "offline";
      
      // Clean up resources
      await this.cleanupDeviceResources(deviceId);
      
      // Update database
      db.run(
        "UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?",
        ["offline", deviceId],
      );

      this.activeSessions.delete(deviceId);
      console.log(`Device ${deviceId} disconnected and cleaned up`);

      // Schedule reconnection unless it was a manual logout
      if (reason !== "manual_logout" && reason !== "restart") {
        this.scheduleReconnect(deviceId);
      }
    } catch (error) {
      console.error(`Disconnection error: ${error}`);
    }
  }

  scheduleReconnect(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return;

    // Clear any existing timer
    this.clearReconnectTimer(deviceId);

    // Increment reconnect attempts
    device.reconnectAttempts = (device.reconnectAttempts || 0) + 1;
    db.run(
      "UPDATE devices SET reconnect_attempts = ? WHERE id = ?",
      [device.reconnectAttempts, deviceId],
    );

    // Check max attempts
    if (device.reconnectAttempts > this.MAX_RECONNECT_ATTEMPTS) {
      console.error(`❌ Device ${deviceId} reconnect attempts exhausted (${this.MAX_RECONNECT_ATTEMPTS} attempts)`);
      device.status = "offline";
      db.run(
        "UPDATE devices SET status = ? WHERE id = ?",
        ["offline", deviceId],
      );
      return;
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.RECONNECT_BASE_DELAY * Math.pow(2, device.reconnectAttempts - 1),
      300000 // Max 5 minutes
    );

    console.log(`⏱ Scheduling reconnect for device ${deviceId} (attempt ${device.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}) in ${delay}ms`);

    const timer = setTimeout(() => {
      console.log(`🔌 Attempting to reconnect device ${deviceId} (attempt ${device.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
      this.startDevice(deviceId).catch(err => {
        console.error(`Reconnect attempt failed: ${err.message}`);
      });
    }, delay);

    this.reconnectTimers.set(deviceId, timer);
  }

  clearReconnectTimer(deviceId) {
    if (this.reconnectTimers.has(deviceId)) {
      clearTimeout(this.reconnectTimers.get(deviceId));
      this.reconnectTimers.delete(deviceId);
    }
  }

  async logoutDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return;

    console.log(`Logging out device ${deviceId}`);
    try {
      // Prevent automatic reconnection
      this.clearReconnectTimer(deviceId);
      
      await this.handleDeviceDisconnection(deviceId, "manual_logout");
      db.run("DELETE FROM devices WHERE id = ?", [deviceId]);
      this.devices.delete(deviceId);
      this.activeSessions.delete(deviceId);
      return true;
    } catch (err) {
      console.error(`Logout failed: ${err}`);
      return false;
    }
  }

  async logoutAll() {
    const results = [];
    for (const [deviceId] of this.devices) {
      try {
        const success = await this.logoutDevice(deviceId);
        results.push({ deviceId, success });
      } catch (err) {
        results.push({ deviceId, success: false, error: err.message });
      }
    }
    console.log(`All devices logged out: ${results.length} processed`);
    return results;
  }

  async getDevices() {
    return Array.from(this.devices.values()).map((device) => ({
      id: device.id,
      name: device.name,
      status: device.status,
      last_active: device.last_active,
      reconnect_attempts: device.reconnectAttempts
    }));
  }

  async sendMessage(phone, message) {
    const onlineDevices = Array.from(this.devices.values()).filter(
      (d) => d.status === "online" && d.client
    );

    if (onlineDevices.length === 0) {
      throw new Error("No online devices available");
    }

    const device = onlineDevices[Math.floor(Math.random() * onlineDevices.length)];
    const msgId = uuidv4();

    try {
      let formattedPhone = phone.replace(/\D/g, "");
      if (formattedPhone.length === 10) formattedPhone = "91" + formattedPhone;
      const whatsappId = formattedPhone + "@c.us";

      console.log(`📤 Sending Hi to ${formattedPhone} via device ${device.id}`);

      // Clean up any existing pending messages for this phone/device combo
      await new Promise((resolve, reject) => {
        db.run(
          "DELETE FROM pending_messages WHERE phone = ? AND device_id = ?",
          [formattedPhone, device.id],
          (err) => (err ? reject(err) : resolve())
        );
      });

      // STEP 1: Send "Hi" message
      const hiMessage = "Hi";
      const hiMsgResult = await device.client.sendMessage(whatsappId, hiMessage);
      
      // Store in pending messages table
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO pending_messages 
          (id, phone, message, device_id, hi_message_id, status) 
          VALUES (?, ?, ?, ?, ?, 'pending_reply')`,
          [msgId, formattedPhone, message, device.id, hiMsgResult.id.id],
          (err) => (err ? reject(err) : resolve())
        );
      });

      console.log(`✅ Sent 'Hi' to ${formattedPhone}, waiting for reply...`);
      return { 
        success: true, 
        deviceId: device.id, 
        messageId: msgId,
        status: 'pending_reply'
      };
    } catch (err) {
      console.error(`❌ Failed to send 'Hi' to ${phone}: ${err.message}`);

      if (err.message.includes("Evaluation failed") || 
          err.message.includes("Target closed") ||
          err.message.includes("Protocol error")) {
        console.log(`🔄 Restarting device ${device.id} due to connection error`);
        this.restartDevice(device.id);
      }

      throw new Error(`Failed to send: ${err.message}`);
    }
  }

  setupMessageListener(client, deviceId) {
    // Remove existing listener if any
    if (this.messageListeners.has(deviceId)) {
      client.removeListener('message', this.messageListeners.get(deviceId));
    }
    
    const messageHandler = async (msg) => {
      try {
        // Ignore our own messages and group messages
        if (msg.fromMe || msg.isGroupMsg) return;
        
        // Extract phone number
        const sender = msg.from.replace('@c.us', '').replace(/\D/g, '');
        const formattedSender = sender.length === 10 ? "91" + sender : sender;
        
        console.log(`📱 Received reply from ${formattedSender} on device ${deviceId}`);
        console.log(`Message: ${msg.body}`);

        // Check for pending message
        const pending = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM pending_messages 
            WHERE phone = ? AND device_id = ? AND status = 'pending_reply'
            ORDER BY hi_sent_at DESC LIMIT 1`,
            [formattedSender, deviceId],
            (err, row) => (err ? reject(err) : resolve(row))
          );
        });

        if (pending) {
          console.log(`📤 Processing pending message for ${formattedSender}`);
          const whatsappId = formattedSender + "@c.us";
          
          // Add small delay before sending actual message
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Send actual message
          const msgResult = await client.sendMessage(whatsappId, pending.message);
          console.log(`✅ Sent real message to ${formattedSender}: ${pending.message.substring(0, 50)}...`);
          
          // Move to sent messages and remove from pending
          await new Promise((resolve, reject) => {
            db.serialize(() => {
              db.run(
                `INSERT INTO sent_messages 
                (id, phone, message, device_id, status) 
                VALUES (?, ?, ?, ?, 'sent')`,
                [pending.id, pending.phone, pending.message, pending.device_id],
                (err) => {
                  if (err) {
                    console.error(`Error inserting sent message: ${err.message}`);
                    return reject(err);
                  }
                  
                  db.run(
                    "UPDATE pending_messages SET status = 'completed' WHERE id = ?",
                    [pending.id],
                    (err) => {
                      if (err) {
                        console.error(`Error updating pending message: ${err.message}`);
                        return reject(err);
                      }
                      resolve();
                    }
                  );
                }
              );
            });
          });

          console.log(`✅ Message flow completed for ${formattedSender}`);
        } else {
          console.log(`ℹ️ No pending message found for ${formattedSender} on device ${deviceId}`);
        }
      } catch (err) {
        console.error(`❌ Error processing reply from ${msg.from}: ${err.message}`);
        console.error(err.stack);
      }
    };

    // Add new listener and store reference
    client.on('message', messageHandler);
    this.messageListeners.set(deviceId, messageHandler);
    console.log(`👂 Message listener set up for device ${deviceId}`);
  }

  async restartDevice(deviceId) {
    console.log(`Restarting device ${deviceId}`);
    try {
      await this.handleDeviceDisconnection(deviceId, "restart");
      setTimeout(() => {
        this.startDevice(deviceId).catch((err) => {
          console.error(`Restart failed: ${err}`);
        });
      }, 5000);
    } catch (error) {
      console.error(`Restart error: ${error}`);
    }
  }
}

// Initialize device manager
const deviceManager = new DeviceManager();
deviceManager.init().catch((err) => console.error("Device init error:", err));

// Auto-clean old messages
cron.schedule("0 0 * * *", () => {
  // Clean sent messages older than 7 days
  db.run(
    "DELETE FROM sent_messages WHERE sent_at < datetime('now', '-7 days')",
    (err) => {
      if (err) console.error("Sent messages cleanup error:", err);
      else console.log("Old sent messages cleaned");
    }
  );
  
  // Clean pending messages older than 30 days
  db.run(
    "DELETE FROM pending_messages WHERE hi_sent_at < datetime('now', '-30 days')",
    (err) => {
      if (err) console.error("Pending messages cleanup error:", err);
      else console.log("Old pending messages cleaned");
    }
  );
});

// Web Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/devices", async (req, res) => {
  try {
    const devices = await deviceManager.getDevices();
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/add-device", async (req, res) => {
  try {
    const { deviceName } = req.body;
    if (!deviceName?.trim()) return res.status(400).json({ error: "Device name required" });
    
    const deviceId = await deviceManager.addDevice(deviceName.trim());
    res.json({ success: true, deviceId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/start-device/:id", async (req, res) => {
  try {
    const result = await deviceManager.startDevice(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/qr-code/:deviceId", async (req, res) => {
  try {
    const qrData = deviceManager.activeSessions.get(req.params.deviceId);
    if (!qrData) return res.status(404).json({ error: "QR not available" });

    const qrImage = await new Promise((resolve) => {
      qrcode.toDataURL(qrData, (err, url) => {
        resolve(err ? null : url);
      });
    });

    if (!qrImage) throw new Error("QR generation failed");
    res.json({ qrImage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/logout-device/:id", async (req, res) => {
  try {
    await deviceManager.logoutDevice(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/logout-all", async (req, res) => {
  try {
    const results = await deviceManager.logoutAll();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/upload-csv", async (req, res) => {
  try {
    let messages = [];

    if (req.files?.csv) {
      const csvFile = req.files.csv;
      const filePath = path.join(__dirname, "uploads", `${Date.now()}.csv`);
      
      if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
      
      await csvFile.mv(filePath);
      
      const stream = fs.createReadStream(filePath).pipe(csv());
      
      for await (const row of stream) {
        if (row.phone && row.message) {
          messages.push({
            phone: row.phone.toString().replace(/\D/g, ""),
            message: row.message,
          });
        }
      }
      
      fs.unlinkSync(filePath); // Cleanup file
    } else if (Array.isArray(req.body)) {
      messages = req.body.map((item) => ({
        phone: item.phone.toString().replace(/\D/g, ""),
        message: item.message,
      }));
    } else {
      return res.status(400).json({ error: "Invalid request" });
    }

    res.json({ success: true, count: messages.length });

    // Process messages in background
    processMessages(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function processMessages(messages) {
  console.log(`Processing ${messages.length} messages`);
  
  let successCount = 0;
  const interval = config.messageInterval || 30000;

  for (const [index, msg] of messages.entries()) {
    try {
      await deviceManager.sendMessage(msg.phone, msg.message);
      successCount++;
      console.log(`Initiated ${index + 1}/${messages.length} to ${msg.phone}`);
      
      // Add delay between messages except last one
      if (index < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    } catch (err) {
      console.error(`Failed ${index + 1}/${messages.length}: ${err.message}`);
    }
  }

  console.log(`Completed: ${successCount} initiated, ${messages.length - successCount} failed`);
}

app.delete("/clear-db", (req, res) => {
  db.run("DELETE FROM sent_messages", (err) => {
    if (err) return res.status(500).json({ error: err.message });
  });
  db.run("DELETE FROM pending_messages", (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get("/pending-messages", (req, res) => {
  db.all("SELECT * FROM pending_messages", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    devices: deviceManager.devices.size,
    timestamp: new Date().toISOString(),
  });
});

const PORT = config.port || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

process.on("SIGINT", async () => {
  console.log("🛑 Shutting down...");
  try {
    await deviceManager.logoutAll();
    db.close();
    console.log("✅ Clean shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("❌ Shutdown error:", err);
    process.exit(1);
  }
});