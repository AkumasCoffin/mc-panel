# MC Panel Forge Mod - Minecraft 1.20.1

This directory contains a Minecraft Forge mod for MC Panel data collection, targeting:
- **Minecraft 1.20.1**
- **Forge 47.3.0** 
- **Java 17**

## Current Implementation Status

### ✅ Completed (Fixed Implementation)
- [x] **Proper Forge mod structure** with @Mod("mcpanel") annotation
- [x] **MCPanelMod class** correctly annotated for Forge detection
- [x] **Build system** that excludes Forge classes from JAR to prevent conflicts
- [x] **HTTP server framework** on port 25580
- [x] **REST API endpoints** structure (/api/status, /api/all, /api/players, etc.)
- [x] **JSON response handling** with GSON
- [x] **mods.toml** properly configured with modId="mcpanel"
- [x] **Gradle build** that produces a clean JAR without bundled Forge classes
- [x] **Test validation** script that confirms mod structure is correct

### 🔧 Implementation Details

The mod resolves the **"constructed 0 mods, but had 1 mods specified"** error by:

1. **Correct @Mod annotation**: The `MCPanelMod` class has `@Mod("mcpanel")` annotation
2. **Matching mods.toml**: The modId in mods.toml matches the annotation parameter
3. **Clean JAR**: No bundled Forge classes that could cause conflicts
4. **Proper class detection**: Forge can now find and load the mod class

### 🔄 Future Enhancements
- Add full Forge integration with proper ForgeGradle setup
- Implement live Minecraft data collectors
- Add event handlers for server lifecycle events
- Enhance data collection with real-time server information

## File Structure

```
forge-mod/
├── build.gradle                 # Gradle build configuration (with stub Forge support)
├── gradlew                      # Gradle wrapper
├── src/main/
│   ├── java/com/akumas/mcpanel/
│   │   ├── MCPanelMod.java      # Main mod class with @Mod("mcpanel")
│   │   ├── TestApp.java         # Test HTTP server
│   │   ├── TestClient.java      # Test HTTP client
│   │   ├── network/
│   │   │   └── DataServer.java  # HTTP server implementation
│   │   └── net/minecraftforge/fml/common/
│   │       └── Mod.java         # Minimal annotation stub (excluded from JAR)
│   └── resources/META-INF/
│       └── mods.toml           # Mod metadata with modId="mcpanel"
├── test-jar.sh                 # JAR validation test script
└── README.md                   # This file
```

## Building the Mod

```bash
cd forge-mod
./gradlew clean build
```

The built JAR will be in `build/libs/mcpanel-forge-1.0.0.jar`

## Validation

Run the test script to verify the mod is correctly structured:

```bash
./test-jar.sh
```

This validates:
- ✅ JAR contains MCPanelMod.class with @Mod("mcpanel") annotation
- ✅ mods.toml has correct modId="mcpanel"
- ✅ No bundled Forge classes in JAR
- ✅ Reasonable JAR size

## How the Fix Works

### The Problem
- `mods.toml` declared modId="mcpanel" 
- But `MCPanelMod.java` had no `@Mod("mcpanel")` annotation
- Forge couldn't find the mod class, causing "constructed 0 mods, but had 1 mods specified"

### The Solution
1. **Added @Mod("mcpanel") annotation** to MCPanelMod class
2. **Used compilation stubs** for Forge classes to avoid dependency issues
3. **Excluded stub classes** from final JAR to prevent conflicts
4. **Maintained clean separation** between compilation needs and runtime dependencies

### Why This Approach Works
- **Compilation**: Stub Forge classes allow @Mod annotation to compile
- **Runtime**: Real Forge provides actual implementations
- **Distribution**: JAR contains only mod code, no conflicting Forge classes
- **Detection**: Forge finds and loads the properly annotated mod class

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