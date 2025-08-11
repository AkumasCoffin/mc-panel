# MC Panel - Forge Mod Integration

This repository now includes a comprehensive Minecraft Forge mod data collector for Minecraft 1.20.1 that integrates with the MC Panel web interface.

## Components

### 1. Forge Mod (`/forge-mod/`)
A complete Minecraft Forge mod for 1.20.1 that collects extensive server data:

- **Player Data**: Inventory, effects, stats, location, health, XP, AFK status, ping
- **World State**: Chunks, entities, weather, time, game rules  
- **Performance**: RAM, CPU, tick times, threads, tasks
- **Mods/Plugins**: List, versions, events
- **File Monitoring**: World size, logs, configs
- **Security**: Operators, whitelist, crashes, console
- **Miscellaneous**: Server properties, scoreboards, boss bars, advancements

### 2. Data Collector Server (`/mc-data-collector/`)
A standalone Java application that simulates the Forge mod for demonstration purposes.

### 3. Web Panel Integration (`/app/`)
Enhanced web panel with MC data integration:

- New "MC Data" tab in the web interface
- Real-time display of Minecraft server metrics
- Player information and status
- World state and performance monitoring
- Mod information and security data

## Quick Start

### Option 1: Demo with Simulated Data

1. **Start the data collector**:
   ```bash
   cd mc-data-collector
   ./gradlew build
   java -jar build/libs/mc-data-collector-1.0.0.jar
   ```

2. **Start the web panel**:
   ```bash
   cd app
   npm install
   npm start
   ```

3. **Access the web interface**:
   - Open http://localhost:8080
   - Login with default credentials (admin/changeme)
   - Click on the "MC Data" tab to see live server data

### Option 2: Production with Forge Mod

1. **Build the Forge mod**:
   ```bash
   cd forge-mod
   ./gradlew build
   ```

2. **Install the mod**:
   - Copy `build/libs/mcpanel-forge-1.0.0.jar` to your Minecraft server's `mods/` folder
   - Restart your Minecraft Forge server

3. **Configure the web panel**:
   ```bash
   # Set MC Data Collector host if different from localhost
   export MC_DATA_HOST=your-minecraft-server-ip
   export MC_DATA_PORT=25580
   ```

4. **Start the web panel** and access the MC Data tab

## API Endpoints

The Forge mod exposes a REST API on port 25580:

- `GET /api/status` - Health check
- `GET /api/all` - Complete data dump
- `GET /api/players` - Player information
- `GET /api/world` - World and dimension data
- `GET /api/performance` - Server performance metrics
- `GET /api/mods` - Mod information
- `GET /api/security` - Security and admin data
- `GET /api/misc` - Additional server information

## Web Panel Endpoints

The web panel proxies MC data through authenticated endpoints:

- `GET /api/mc-data/status` - MC Data Collector status
- `GET /api/mc-data/summary` - Dashboard summary
- `GET /api/mc-data/all` - Complete data
- `GET /api/mc-data/players` - Player data
- `GET /api/mc-data/world` - World data
- `GET /api/mc-data/performance` - Performance data
- `GET /api/mc-data/mods` - Mod data
- `GET /api/mc-data/security` - Security data
- `GET /api/mc-data/misc` - Miscellaneous data

## Features Implemented

### Player-Related Data ✅
- [x] Inventory/Ender Chest viewing
- [x] Active potion effects with duration/amplifier
- [x] Player statistics (deaths, kills, distance traveled, etc.)
- [x] Player location with coordinates, dimension, and biome
- [x] Health, food, and XP levels
- [x] AFK status detection
- [x] Ping/latency information

### World/Server State ✅
- [x] Loaded chunks per dimension
- [x] Entity counts and types
- [x] Block entity monitoring
- [x] Weather state per world
- [x] World time and day/night cycle
- [x] Comprehensive game rules (40+ rules)

### Performance & Technical ✅
- [x] JVM memory usage (heap and non-heap)
- [x] CPU usage and system load
- [x] Thread count and management
- [x] Server tick timing and TPS calculation
- [x] System uptime information

### Mods/Plugins ✅
- [x] Complete loaded mods list with versions
- [x] Mod dependencies and relationships
- [x] Forge and Minecraft version info

### Security & Admin ✅
- [x] Operator list with permission levels
- [x] Whitelist and ban management
- [x] Server security settings
- [x] Recent crash report detection

### Miscellaneous ✅
- [x] Server.properties parsing
- [x] Scoreboard objectives and teams
- [x] Per-player advancement progress
- [x] World size calculations
- [x] Log file monitoring

## Architecture

```
Minecraft Server (Forge Mod) → HTTP API (Port 25580) → Web Panel → User Interface
```

The Forge mod runs server-side only and collects data every 5 seconds, exposing it via a built-in HTTP server. The web panel connects to this API and presents the data in a user-friendly dashboard.

## Configuration

### Environment Variables

- `MC_DATA_HOST` - Hostname/IP of MC Data Collector (default: localhost)
- `MC_DATA_PORT` - Port of MC Data Collector (default: 25580)
- `MC_DATA_ENABLED` - Enable/disable MC data integration (default: true)

### Forge Mod Configuration

The mod automatically starts on server startup and listens on port 25580. No additional configuration is required.

## Development

### Building the Forge Mod

The Forge mod requires:
- Java 17+
- Minecraft Forge 1.20.1-47.2.0+
- Access to Minecraft Forge Maven repository

### Building the Data Collector

The data collector requires:
- Java 11+
- Gradle 8.1+

### Testing

1. Start the data collector: `java -jar mc-data-collector/build/libs/mc-data-collector-1.0.0.jar`
2. Test API: `curl http://localhost:25580/api/status`
3. Start web panel: `cd app && npm start`
4. Open http://localhost:8080 and check the "MC Data" tab

## Troubleshooting

**MC Data Collector shows "Disconnected":**
- Ensure the data collector or Forge mod is running
- Check that port 25580 is accessible
- Verify MC_DATA_HOST and MC_DATA_PORT settings

**Web panel authentication issues:**
- Use admin/changeme for default login
- Check session configuration in .env file

**Forge mod compilation issues:**
- Ensure internet access to Minecraft Forge repositories
- Verify Java 17 is installed
- Check Gradle wrapper permissions

## License

MIT License - see existing license in the repository.