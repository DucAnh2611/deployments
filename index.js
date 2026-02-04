// webhook-deploy-server.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const { exec } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const yaml = require("js-yaml");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: "Too many deployment requests",
});

// Config
const LOGS_DIR = path.join(__dirname, "logs");
const CONFIG_FILE = path.join(__dirname, "config.yml");

let APPS = {};
let config = {};

const running = new Set();

// Helper: Get log file path for today
const getLogFilePath = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return path.join(LOGS_DIR, `${year}${month}${day}.txt`);
};

// Helper: Ensure logs directory exists
const ensureLogsDir = async () => {
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
  } catch (err) {
    console.error("Failed to create logs directory:", err);
  }
};

// Helper: Parse log file content
const parseLogFile = (content) => {
  const logs = [];
  const lines = content.split("\n").filter((line) => line.trim());

  for (const line of lines) {
    try {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;

      const deployId = line.substring(0, colonIndex).trim();
      const stepsJson = line.substring(colonIndex + 1).trim();
      const steps = JSON.parse(stepsJson);

      logs.push({ deployId, steps });
    } catch (err) {
      console.error("Failed to parse log line:", err.message);
    }
  }

  return logs;
};

// Load config from YAML
const loadConfig = async () => {
  try {
    const fileContents = await fs.readFile(CONFIG_FILE, "utf8");
    config = yaml.load(fileContents);
    APPS = config.apps || {};

    if (!config.shellPath) {
      throw new Error("shellPath is not set");
    }

    // Validate config
    for (const [appName, envs] of Object.entries(APPS)) {
      for (const [envName, envConfig] of Object.entries(envs)) {
        if (!envConfig.path) {
          throw new Error(`Missing 'path' for ${appName}.${envName}`);
        }
        if (!envConfig.steps || !Array.isArray(envConfig.steps)) {
          throw new Error(
            `Missing or invalid 'steps' for ${appName}.${envName}`
          );
        }
        if (envConfig.steps.length === 0) {
          throw new Error(`No steps defined for ${appName}.${envName}`);
        }
      }
    }

    console.log("✅ Config loaded successfully");
    console.log(`📦 Loaded ${Object.keys(APPS).length} apps`);
  } catch (err) {
    console.error("❌ Failed to load config:", err.message);
    throw err;
  }
};

// POST /reload-config
app.post(
  "/reload-config",
  limiter,
  authMiddleware,
  async (req, res) => {
    try {
      await loadConfig();
      res.json({
        message: "Config reloaded successfully",
        apps: Object.keys(APPS),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to reload config",
        details: err.message,
      });
    }
  }
);

// Middleware: Auth check
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (token !== config.authToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Helper: Execute command
const execCommand = (command, cwd) => {
  return new Promise((resolve, reject) => {
    const options = {
      cwd,
      timeout: 300000, // 5 minutes timeout
    };

    // Use custom shell if provided, otherwise use system default
    if (config.shellPath) {
      // Normalize path for Windows - convert backslashes to forward slashes
      options.shell = config.shellPath.replace(/\\/g, '/');
    }

    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message, stderr, stdout });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

// Helper: Save log
const saveLog = async (logEntry) => {
  try {
    await ensureLogsDir();

    const logFilePath = getLogFilePath();

    // Format: deployId: [{step: index, result: ...}, ...]
    const formattedSteps = logEntry.steps.map((step, index) => ({
      step: index,
      name: step.name,
      command: step.command,
      status: step.status,
      duration: step.duration,
      output: step.output || step.stdout || "",
      stderr: step.stderr || "",
      error: step.error || "",
    }));

    const logLine = `${logEntry.deployId}: ${JSON.stringify(formattedSteps)}\n`;

    // Append to log file
    await fs.appendFile(logFilePath, logLine, "utf8");
  } catch (err) {
    console.error("Failed to save log:", err);
  }
};

// POST /webhook/deploy
app.post("/webhook/deploy", limiter, authMiddleware, async (req, res) => {
  const { app: appName, env } = req.body;

  // Validation
  if (!appName || !env) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["app", "env"],
    });
  }

  if (!APPS[appName]) {
    return res.status(400).json({
      error: "App not found",
      available_apps: Object.keys(APPS),
    });
  }

  if (!APPS[appName][env]) {
    return res.status(400).json({
      error: "Environment not found",
      available_envs: Object.keys(APPS[appName]),
    });
  }

  if (running.has(`${appName}-${env}`)) {
    return res.status(400).json({
      error: "Deployment already running",
    });
  }

  const config = APPS[appName][env];
  const deployId = `${appName}-${env}-${Date.now()}`;

  // Start deployment (async)
  res.json({
    message: "Deployment started",
    deployId,
    app: appName,
    env,
    steps: config.steps.length,
    timestamp: new Date().toISOString(),
  });

  // Run deployment in background
  deployApp(deployId, appName, env, config);
});

// GET /webhook/deploy/log
app.get("/webhook/deploy/log", limiter, authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const app = req.query.app;
    const env = req.query.env;
    const date = req.query.date; // YYYYMMDD format

    let logs = [];

    if (date) {
      // Read specific date file
      const logFilePath = path.join(LOGS_DIR, `${date}.txt`);
      try {
        const data = await fs.readFile(logFilePath, "utf8");
        logs = parseLogFile(data);
      } catch (err) {
        // File doesn't exist
      }
    } else {
      // Read today's log file
      const logFilePath = getLogFilePath();
      try {
        const data = await fs.readFile(logFilePath, "utf8");
        logs = parseLogFile(data);
      } catch (err) {
        // File doesn't exist
      }
    }

    // Filter by app/env if provided
    if (app) {
      logs = logs.filter((l) => l.deployId.includes(app));
    }
    if (env) {
      logs = logs.filter((l) => l.deployId.includes(env));
    }

    res.json({
      logs: logs.slice(0, limit),
      total: logs.length,
      filters: { app, env, date },
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to read logs", details: err.message });
  }
});

// GET /webhook/deploy/log/:deployId
app.get(
  "/webhook/deploy/log/:deployId",
  limiter,
  authMiddleware,
  async (req, res) => {
    try {
      const targetDeployId = req.params.deployId;

      // Try today's log file first
      const logFilePath = getLogFilePath();
      try {
        const data = await fs.readFile(logFilePath, "utf8");
        const logs = parseLogFile(data);
        const log = logs.find((l) => l.deployId === targetDeployId);

        if (log) {
          return res.json(log);
        }
      } catch (err) {
        // File doesn't exist or not found in today's log
      }

      // Search in recent log files (last 7 days)
      for (let i = 1; i <= 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const oldLogFilePath = getLogFilePath(date);

        try {
          const data = await fs.readFile(oldLogFilePath, "utf8");
          const logs = parseLogFile(data);
          const log = logs.find((l) => l.deployId === targetDeployId);

          if (log) {
            return res.json(log);
          }
        } catch (err) {
          // File doesn't exist, continue to next date
          continue;
        }
      }

      res.status(404).json({ error: "Log not found" });
    } catch (err) {
      res
        .status(500)
        .json({ error: "Failed to read logs", details: err.message });
    }
  }
);

// Deployment function
async function deployApp(deployId, appName, env, config) {
  const startTime = Date.now();
  const log = {
    deployId,
    app: appName,
    env,
    startTime: new Date().toISOString(),
    status: "in-progress",
    path: config.path,
    steps: [],
  };

  running.add(`${appName}-${env}`);

  try {
    // Execute each step sequentially
    for (let i = 0; i < config.steps.length; i++) {
      const step = config.steps[i];
      const stepName = step.name || `Step ${i + 1}`;
      const stepCommand = step.command;

      console.log(`📌 ${deployId} - Executing: ${stepName}`);

      try {
        const stepStartTime = Date.now();
        const result = await execCommand(stepCommand, config.path);
        const stepDuration = Date.now() - stepStartTime;

        log.steps.push({
          order: i + 1,
          name: stepName,
          command: stepCommand,
          status: "success",
          duration: stepDuration,
          output: result.stdout ? result.stdout.slice(-1000) : "", // Last 1000 chars
          stderr: result.stderr ? result.stderr.slice(-500) : "",
        });

        console.log(
          `✅ ${deployId} - [${stepName}] completed (${stepDuration}ms)`
        );
      } catch (err) {
        const stepDuration = Date.now() - startTime;

        log.steps.push({
          order: i + 1,
          name: stepName,
          command: stepCommand,
          status: "error",
          duration: stepDuration,
          error: err.error,
          stderr: err.stderr,
          stdout: err.stdout,
        });

        console.error(`❌ ${deployId} - [${stepName}] failed:`, err.error);

        throw err; // Stop execution on first error
      }
    }

    // All steps succeeded
    log.status = "success";
    log.duration = Date.now() - startTime;
    console.log(
      `✅ ${deployId} - Deployment completed successfully (${log.duration}ms)`
    );
  } catch (err) {
    log.status = "failed";
    log.duration = Date.now() - startTime;
    log.error = err.error || err.message;
    console.error(`❌ ${deployId} - Deployment failed (${log.duration}ms)`);
  } finally {
    running.delete(`${appName}-${env}`);
  }

  log.endTime = new Date().toISOString();
  await saveLog(log);
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    apps_loaded: Object.keys(APPS).length,
    timestamp: new Date().toISOString(),
  });
});

loadConfig()
  .then(() => {
    const PORT = config.port || 3001;
    app.listen(PORT, () => {
      console.log(`🚀 Webhook deploy server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
