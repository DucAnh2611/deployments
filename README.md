# Webhook Deployment Server

A simple Node.js webhook server that reads YAML configuration to deploy projects.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create your configuration file:
```bash
cp config.example.yml config.yml
```

3. Configure your apps in `config.yml`:
```yaml
apps:
  app_config:
    stg:
      path: /home/user/app_config
      branch: staging
      steps:
        - name: "Pull the latest code"
          command: "git pull"
        - name: "Install dependencies"
          command: "npm install"

authToken: your-secure-token-here
port: 3001

# Optional: Specify shell path (use forward slashes)
# For Windows Git Bash: D:/Git/bin/bash.exe
# For Windows CMD: cmd.exe
# For PowerShell: powershell.exe
# For Linux/Mac: /bin/bash
# Leave empty or omit to use system default
shellPath: D:/Git/bin/bash.exe
```

4. Start the server:
```bash
# Production mode
npm start

# Development mode (with auto-reload)
npm run dev
```

The server will run on port 3001 by default (or set PORT environment variable).

## Usage

Trigger a deployment by sending a POST request:
```bash
curl -X POST http://localhost:3001/webhook/deploy \
  -H "Authorization: Bearer your-secure-token-here" \
  -H "Content-Type: application/json" \
  -d '{"app": "app_config", "env": "stg"}'
```

## Endpoints

- `POST /webhook/deploy` - Trigger deployment (requires: app, env)
- `POST /webhook/reload-config` - Reload config.yml without restart
- `GET /webhook/apps` - List all configured apps
- `GET /webhook/apps/:appName/:env` - Get specific app config
- `GET /webhook/deploy/log` - Get deployment logs (params: limit, app, env, date)
- `GET /webhook/deploy/log/:deployId` - Get specific deployment log
- `GET /health` - Health check endpoint

## Logging

Logs are saved in the `logs/` directory with date-based filenames:
- Format: `logs/YYYYMMDD.txt`
- Each line: `deployId: [{step: 0, name: "...", status: "...", ...}, ...]`
- Logs are automatically created for each day
- The `logs/` folder is excluded from git

Example log query:
```bash
# Get today's logs
curl http://localhost:3001/webhook/deploy/log \
  -H "Authorization: Bearer your-token"

# Get specific date logs (YYYYMMDD format)
curl "http://localhost:3001/webhook/deploy/log?date=20260204" \
  -H "Authorization: Bearer your-token"
```

## Security

- Rate limiting: 10 requests per 15 minutes per IP
- Bearer token authentication (DEPLOY_TOKEN)
- All endpoints require authentication except /health
