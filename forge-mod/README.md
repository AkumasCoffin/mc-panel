# MC Panel Forge Mod - Minecraft 1.20.1

This directory contains a completely rewritten Minecraft Forge mod for MC Panel data collection, targeting:
- **Minecraft 1.20.1**
- **Forge 47.4.0** 
- **Java 17**

## Current Implementation Status

### ✅ Completed (Basic Structure)
- [x] New mod structure created from scratch
- [x] Basic Java application that compiles successfully
- [x] HTTP server framework on port 25580
- [x] REST API endpoints structure (/api/status, /api/all, /api/players, etc.)
- [x] JSON response handling with GSON
- [x] Basic error handling and CORS support
- [x] Gradle build configuration (simplified)

### ⚠️ Current Limitations  
- **No Minecraft/Forge Integration**: Due to network connectivity issues with MinecraftForge repositories, the current implementation is a basic Java application
- **Static Test Data**: Endpoints return placeholder data instead of live Minecraft server data
- **No Mod Loading**: Cannot load as an actual Minecraft Forge mod yet

### 🔄 Next Steps (When Repository Access Available)
1. **Restore Forge Dependencies**: Update `build.gradle` to include full ForgeGradle and Minecraft dependencies
2. **Add Forge Annotations**: Restore `@Mod` annotation and Forge event handling
3. **Implement Data Collectors**: 
   - `PlayerDataCollector` - Player inventories, stats, location, health
   - `WorldDataCollector` - World state, chunks, entities, weather
   - `PerformanceDataCollector` - Server TPS, memory, CPU usage
   - `ModDataCollector` - Loaded mods and versions
   - `SecurityDataCollector` - Operators, whitelist, bans
   - `MiscDataCollector` - Server properties, scoreboards
4. **Integration Testing**: Test with actual Minecraft server

## File Structure

```
forge-mod/
├── build.gradle                 # Gradle build configuration
├── gradlew                      # Gradle wrapper
├── src/main/
│   ├── java/com/akumas/mcpanel/
│   │   ├── MCPanelMod.java      # Main mod class (basic)
│   │   ├── TestApp.java         # Test HTTP server
│   │   ├── TestClient.java      # Test HTTP client
│   │   └── network/
│   │       └── DataServer.java  # HTTP server implementation
│   └── resources/META-INF/
│       └── mods.toml           # Mod metadata
└── README.md                   # This file
```

## Building the Mod

```bash
cd forge-mod
./gradlew clean build
```

The built JAR will be in `build/libs/mcpanel-forge-1.0.0.jar`

## Testing the HTTP Server

```bash
# Start test server
java -cp build/libs/mcpanel-forge-1.0.0.jar:~/.gradle/caches/modules-2/files-2.1/com.google.code.gson/gson/2.10.1/b3add478d4382b78ea20b1671390a858002feb6c/gson-2.10.1.jar com.akumas.mcpanel.TestApp

# Test endpoints (in another terminal)
java -cp build/libs/mcpanel-forge-1.0.0.jar:~/.gradle/caches/modules-2/files-2.1/com.google.code.gson/gson/2.10.1/b3add478d4382b78ea20b1671390a858002feb6c/gson-2.10.1.jar com.akumas.mcpanel.TestClient
```

## API Endpoints

All endpoints return JSON data:

- `GET /api/status` - Server status and health check
- `GET /api/all` - Complete data dump
- `GET /api/players` - Player information  
- `GET /api/world` - World and dimension data
- `GET /api/performance` - Server performance metrics
- `GET /api/mods` - Mod information
- `GET /api/security` - Security and admin data
- `GET /api/misc` - Additional server information

## Full Implementation Requirements

When MinecraftForge repository access is restored, the following needs to be implemented:

### 1. Update build.gradle
```gradle
buildscript {
    repositories {
        maven { url = 'https://maven.minecraftforge.net' }
        mavenCentral()
    }
    dependencies {
        classpath group: 'net.minecraftforge.gradle', name: 'ForgeGradle', version: '6.0.24'
    }
}

apply plugin: 'net.minecraftforge.gradle'

minecraft {
    mappings channel: 'official', version: '1.20.1'
    // ... run configurations
}

dependencies {
    minecraft 'net.minecraftforge:forge:1.20.1-47.4.0'
}
```

### 2. Enhance MCPanelMod.java
```java
@Mod(MCPanelMod.MOD_ID)
public class MCPanelMod {
    @SubscribeEvent
    public void onServerStarted(ServerStartedEvent event) {
        // Initialize data collectors with actual server instance
        // Start HTTP server
    }
}
```

### 3. Implement Data Collectors
Each collector should extend a base interface and collect specific Minecraft data:
- Player data (inventories, effects, stats, location)
- World data (chunks, entities, weather, time)  
- Performance data (TPS, memory, threads)
- Mod data (loaded mods, versions, dependencies)
- Security data (ops, whitelist, bans)
- Misc data (server properties, scoreboards)

## Integration with Web Panel

The web panel expects this mod to:
1. Run on Minecraft server startup
2. Listen on port 25580 for HTTP requests
3. Provide real-time server data via REST API
4. Handle CORS for web browser access

## Current vs Target Architecture

**Current (Basic):**
```
Java Application → HTTP Server (port 25580) → Static Test Data
```

**Target (Full Implementation):**
```  
Minecraft Server (Forge Mod) → Data Collectors → HTTP Server (port 25580) → Live Server Data
```

The current implementation provides the HTTP server framework and API structure. When Forge dependencies are available, the data collectors will be integrated to provide live Minecraft server data instead of placeholder responses.