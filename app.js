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
const puppeteer = require("puppeteer-core");  // Updated to puppeteer-core
const qrcode = require("qrcode");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileUpload());
app.use(express.static("public"));

const config = require("./config.json");

// Handle unhandled rejections gracefully
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

const db = new sqlite3.Database("messages.db");
db.serialize(() => {
  // Create tables
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
  
  // New table for pending messages
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
});

// Device Manager
class DeviceManager {
  constructor() {
    this.devices = new Map();
    this.activeSessions = new Map();
    this.messageListeners = new Map();
  }

  async init() {
    return new Promise((resolve, reject) => {
      db.all("SELECT * FROM devices", [], (err, rows) => {
        if (err) return reject(err);

        rows.forEach((row) => {
          this.devices.set(row.id, {
            ...row,
            client: null,
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
          });

          resolve(deviceId);
        },
      );
    });
  }

  async startDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error("Device not found");

    try {
      device.status = "starting";
      db.run(
        "UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?",
        ["starting", deviceId],
      );

      // Close existing client if any
      if (device.client) {
        try {
          await device.client.destroy();
        } catch (error) {
          console.error(`Error destroying client: ${error}`);
        }
      }

      // Initialize with retries
      let attempts = 0;
      const maxAttempts = 3;
      let success = false;

      while (attempts < maxAttempts && !success) {
        attempts++;
        try {
          console.log(`Starting device ${deviceId} (attempt ${attempts}/${maxAttempts})`);
          
          // Use lightweight browser configuration
          const browser = await puppeteer.launch({
            headless: true,
            args: [
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
              "--disable-accelerated-2d-canvas",
              "--no-first-run",
              "--no-zygote",
              "--single-process",
              "--no-sandbox",
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
              "--disable-breakpad",
              "--memory-pressure-off",
              "--mute-audio",
              "--hide-scrollbars",
              "--remote-debugging-port=0",
              "--remote-debugging-address=0.0.0.0",
              "--user-agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'"
            ],
            ignoreHTTPSErrors: true,
            executablePath: process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome"
          });

          device.client = new Client({
            authStrategy: new LocalAuth({ clientId: deviceId }),
            puppeteer: { 
              browser: browser
            },
            webVersionCache: {
              type: 'remote',
              remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${config.webVersion || '2.2412.54'}.html`,
            }
          });

          // Event handlers
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
            db.run(
              "UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?",
              ["online", deviceId],
            );
            console.log(`Device ${deviceId} is ready!`);
            
            // Setup message listener after ready
            this.setupMessageListener(device.client, deviceId);
          });

          device.client.on("disconnected", async (reason) => {
            console.log(`Device ${deviceId} disconnected: ${reason}`);
            try {
              await this.handleDeviceDisconnection(deviceId, reason);
            } catch (error) {
              console.error(`Error handling disconnection: ${error}`);
            }
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
            console.error(`Client error: ${error}`);
          });

          await device.client.initialize();
          success = true;
          console.log(`Device ${deviceId} started successfully`);
        } catch (err) {
          console.error(`Attempt ${attempts} failed: ${err.message}`);
          if (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
          } else {
            throw err;
          }
        }
      }

      return { status: "initialized" };
    } catch (err) {
      console.error(`Start failed after 3 attempts: ${err}`);
      device.status = "error";
      db.run(
        "UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?",
        ["error", deviceId],
      );
      throw err;
    }
  }

  async handleDeviceDisconnection(deviceId, reason) {
    const device = this.devices.get(deviceId);
    if (!device) return;

    try {
      device.status = "offline";
      if (device.client) {
        try {
          await device.client.destroy();
        } catch (err) {
          console.error(`Error during client destroy: ${err}`);
        }
      }
      device.client = null;

      db.run(
        "UPDATE devices SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?",
        ["offline", deviceId],
      );

      this.activeSessions.delete(deviceId);
      console.log(`Device ${deviceId} disconnected and cleaned up`);
    } catch (error) {
      console.error(`Disconnection error: ${error}`);
    }
  }

  async logoutDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return;

    console.log(`Logging out device ${deviceId}`);
    try {
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

      console.log(`Sending to ${formattedPhone} via ${device.id}`);

      // STEP 1: Send "Hi" message
      const hiMessage = "Hi";
      const hiMsgResult = await device.client.sendMessage(whatsappId, hiMessage);
      
      // Store in pending messages table
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO pending_messages 
          (id, phone, message, device_id, hi_message_id) 
          VALUES (?, ?, ?, ?, ?)`,
          [msgId, formattedPhone, message, device.id, hiMsgResult.id.id],
          (err) => (err ? reject(err) : resolve())
        );
      });

      console.log(`✓ Sent 'Hi' to ${formattedPhone}`);
      return { 
        success: true, 
        deviceId: device.id, 
        messageId: msgId,
        status: 'pending_reply'
      };
    } catch (err) {
      console.error(`✗ Failed to send 'Hi': ${err.message}`);

      if (err.message.includes("Evaluation failed") || 
          err.message.includes("Target closed") ||
          err.message.includes("Protocol error")) {
        console.log(`Restarting device ${device.id} due to connection error`);
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
      // Ignore our own messages and group messages
      if (msg.fromMe || msg.isGroupMsg) return;
      
      // Extract phone number
      const sender = msg.from.replace(/\D/g, '');
      const formattedSender = sender.length === 10 ? "91" + sender : sender;
      
      console.log(`Received reply from ${formattedSender} on device ${deviceId}`);

      try {
        // Check for pending message
        const pending = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM pending_messages 
            WHERE phone = ? AND device_id = ? AND status = 'pending_reply'`,
            [formattedSender, deviceId],
            (err, row) => (err ? reject(err) : resolve(row))
          );
        });

        if (pending) {
          console.log(`Processing pending message for ${formattedSender}`);
          const whatsappId = formattedSender + "@c.us";
          
          // Send actual message
          await client.sendMessage(whatsappId, pending.message);
          
          // Move to sent messages
          await new Promise((resolve, reject) => {
            db.serialize(() => {
              db.run(
                `INSERT INTO sent_messages 
                (id, phone, message, device_id) 
                VALUES (?, ?, ?, ?)`,
                [pending.id, pending.phone, pending.message, pending.device_id],
                (err) => {
                  if (err) return reject(err);
                  
                  db.run(
                    "DELETE FROM pending_messages WHERE id = ?",
                    [pending.id],
                    (err) => (err ? reject(err) : resolve())
                  );
                }
              );
            });
          });

          console.log(`✓ Sent real message to ${formattedSender}`);
        }
      } catch (err) {
        console.error(`Error processing reply: ${err.message}`);
      }
    };

    // Add new listener and store reference
    client.on('message', messageHandler);
    this.messageListeners.set(deviceId, messageHandler);
    console.log(`Message listener set up for device ${deviceId}`);
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
