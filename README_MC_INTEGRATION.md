# MC Panel - Forge Mod Integration

This repository includes a completely rewritten Minecraft Forge mod data collector for Minecraft 1.20.1 that integrates with the MC Panel web interface.

## Components

### 1. Forge Mod (`/forge-mod/`) - **NEWLY REWRITTEN**
A fresh Minecraft Forge mod for 1.20.1 (Java 17, Forge 47.4.0) that provides server data collection:

**Current Status: Basic Implementation**
- ✅ **New mod structure**: Completely rewritten from scratch  
- ✅ **Modern build system**: Updated Gradle configuration
- ✅ **HTTP server framework**: REST API on port 25580
- ✅ **Basic endpoints**: /api/status, /api/all, /api/players, etc.
- ✅ **JSON responses**: GSON-based data serialization
- ✅ **Builds successfully**: Creates working JAR file

**Pending Full Implementation** (requires MinecraftForge repository access):
- 🔄 **Minecraft integration**: Forge annotations and event handling
- 🔄 **Live data collection**: Player, world, performance, mod, security data
- 🔄 **Real-time updates**: Scheduled data collection every 5 seconds

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

### Option 2: Test New Forge Mod (Basic HTTP Server)

1. **Build the new Forge mod**:
   ```bash
   cd forge-mod
   ./gradlew build
   ```

2. **Test the HTTP server**:
   ```bash
   # Start test server
   java -cp build/libs/mcpanel-forge-1.0.0.jar:~/.gradle/caches/modules-2/files-2.1/com.google.code.gson/gson/2.10.1/b3add478d4382b78ea20b1671390a858002feb6c/gson-2.10.1.jar com.akumas.mcpanel.TestApp
   ```

3. **Test endpoints**:
   ```bash
   # In another terminal
   java -cp build/libs/mcpanel-forge-1.0.0.jar:~/.gradle/caches/modules-2/files-2.1/com.google.code.gson/gson/2.10.1/b3add478d4382b78ea20b1671390a858002feb6c/gson-2.10.1.jar com.akumas.mcpanel.TestClient
   ```

### Option 3: Production with Full Forge Mod (When Complete)

**Note: This option requires completing the full Minecraft integration**

1. **Build the Forge mod** (when dependencies available)
2. **Install the mod**: Copy JAR to Minecraft server's `mods/` folder  
3. **Configure the web panel**: Set MC_DATA_HOST and MC_DATA_PORT
4. **Start the web panel** and access the MC Data tab

## API Endpoints

The new Forge mod exposes a REST API on port 25580:

- `GET /api/status` - Health check and server status
- `GET /api/all` - Complete data dump  
- `GET /api/players` - Player information
- `GET /api/world` - World and dimension data
- `GET /api/performance` - Server performance metrics
- `GET /api/mods` - Mod information
- `GET /api/security` - Security and admin data
- `GET /api/misc` - Additional server information

## Implementation Status

### Current Implementation ✅
- [x] New mod structure for Minecraft 1.20.1, Forge 47.4.0, Java 17
- [x] HTTP server framework with all required endpoints
- [x] JSON response handling with proper CORS support
- [x] Basic error handling and logging
- [x] Gradle build system that creates working JAR
- [x] Test applications for verification

### Pending Implementation 🔄
- [ ] Full MinecraftForge integration (waiting for repository access)
- [ ] Live data collectors for players, world, performance, mods, security
- [ ] Forge event handling (ServerStartedEvent, ServerStoppingEvent)
- [ ] Real-time data updates every 5 seconds
- [ ] Integration testing with actual Minecraft server

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

## Architecture

**Current (Basic Implementation):**
```
Java Application → HTTP Server (port 25580) → Static Test Data → Web Panel
```

**Target (Full Implementation):**
```
Minecraft Server (Forge Mod) → Data Collectors → HTTP API (port 25580) → Web Panel → User Interface
```

The new Forge mod provides the foundation for real-time server data collection. Once MinecraftForge repository access is restored, the mod will be enhanced with full Minecraft integration to collect live server data.

## Configuration

### Environment Variables

- `MC_DATA_HOST` - Hostname/IP of MC Data Collector (default: localhost)
- `MC_DATA_PORT` - Port of MC Data Collector (default: 25580)
- `MC_DATA_ENABLED` - Enable/disable MC data integration (default: true)

### Forge Mod Configuration

The mod automatically starts on server startup and listens on port 25580. No additional configuration is required.

## Development

### Building the New Forge Mod

The new Forge mod structure requires:
- Java 17+
- Gradle 8.1+
- Basic dependencies (GSON for JSON handling)

Full implementation will require:
- Minecraft Forge 1.20.1-47.4.0+
- Access to MinecraftForge Maven repository

### Building the Data Collector

The data collector requires:
- Java 11+
- Gradle 8.1+

### Testing

1. **Test basic HTTP server**: 
   ```bash
   cd forge-mod
   ./gradlew build
   java -cp build/libs/mcpanel-forge-1.0.0.jar:~/.gradle/caches/modules-2/files-2.1/com.google.code.gson/gson/2.10.1/b3add478d4382b78ea20b1671390a858002feb6c/gson-2.10.1.jar com.akumas.mcpanel.TestApp
   ```

2. **Test API endpoints**:
   ```bash
   java -cp build/libs/mcpanel-forge-1.0.0.jar:~/.gradle/caches/modules-2/files-2.1/com.google.code.gson/gson/2.10.1/b3add478d4382b78ea20b1671390a858002feb6c/gson-2.10.1.jar com.akumas.mcpanel.TestClient
   ```

3. **Start web panel**: `cd app && npm start`
4. **Open http://localhost:8080** and check the "MC Data" tab

## Troubleshooting

**MC Data Collector shows "Disconnected":**
- Ensure the data collector or test server is running  
- Check that port 25580 is accessible
- Verify MC_DATA_HOST and MC_DATA_PORT settings

**Forge mod build fails:**
- Verify Java 17 is installed
- Check internet connectivity to Maven repositories
- Try using the basic Java build first

**Web panel authentication issues:**
- Use admin/changeme for default login
- Check session configuration in .env file

## License

MIT License - see existing license in the repository.