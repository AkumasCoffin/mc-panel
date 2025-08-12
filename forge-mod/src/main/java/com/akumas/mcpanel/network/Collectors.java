package com.akumas.mcpanel.network;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.akumas.mcpanel.MCPanelMod;

import java.util.logging.Logger;
import java.util.logging.Level;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.ThreadMXBean;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.RuntimeMXBean;
import java.lang.management.OperatingSystemMXBean;
import java.io.File;

/**
 * Enhanced live data collection methods for Minecraft server data.
 * This class provides comprehensive real-time data collection from a Minecraft Forge server,
 * integrating with the event tracking system for accurate live data.
 */
public class Collectors {
    private static final Logger LOGGER = Logger.getLogger(Collectors.class.getName());
    
    // Cache for data consistency within update cycles
    private static volatile long lastUpdateTime = 0;
    private static volatile JsonObject cachedPlayerData = null;
    private static volatile JsonObject cachedWorldData = null;
    private static volatile JsonObject cachedPerformanceData = null;
    private static final long CACHE_DURATION_MS = 5000; // 5 second cache
    
    /**
     * Collects comprehensive live player data from the Minecraft server
     * Now includes real-time online/offline status tracking
     */
    public static JsonObject collectPlayerData() {
        long currentTime = System.currentTimeMillis();
        
        // Use cache if data is fresh
        if (cachedPlayerData != null && (currentTime - lastUpdateTime) < CACHE_DURATION_MS) {
            return cachedPlayerData;
        }
        
        JsonObject data = createBasicResponse();
        data.addProperty("endpoint", "players");
        
        try {
            // Get data from PlayerEventTracker if available
            if (MCPanelMod.getPlayerTracker() != null) {
                JsonObject playerTrackerData = MCPanelMod.getPlayerTracker().getAllPlayerData();
                
                // Extract key information with real-time online status
                if (playerTrackerData.has("online_count")) {
                    data.addProperty("online_count", playerTrackerData.get("online_count").getAsInt());
                }
                if (playerTrackerData.has("players")) {
                    data.add("all_players", playerTrackerData.get("players")); // All players with online status
                }
                
                // Get only online players
                JsonArray onlinePlayers = MCPanelMod.getPlayerTracker().getOnlinePlayers();
                data.add("players", onlinePlayers); // Only currently online players
                data.add("player_stats", playerTrackerData.get("player_stats"));
                data.add("player_inventories", playerTrackerData.get("player_inventories"));
                data.add("recent_events", playerTrackerData.get("recent_events"));
                
                data.addProperty("max_players", 20); // Default max players
                data.addProperty("server_uptime_ms", ManagementFactory.getRuntimeMXBean().getUptime());
                
            } else {
                // Fallback when tracker is not available
                data.addProperty("online_count", 0);
                data.addProperty("max_players", 20);
                data.add("players", new JsonArray());
                data.add("all_players", new JsonArray());
                data.add("player_stats", new JsonArray());
                data.add("player_inventories", new JsonArray());
                data.add("recent_events", new JsonArray());
            }
            
            // Add server whitelist/security info
            JsonObject playerStats = new JsonObject();
            playerStats.addProperty("online_count", data.get("online_count").getAsInt());
            playerStats.addProperty("max_players", data.get("max_players").getAsInt());
            playerStats.addProperty("whitelist_enabled", false); // Default
            data.add("player_summary", playerStats);
            
            data.addProperty("status", "success");
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to collect player data", e);
            data.addProperty("status", "error");
            data.addProperty("error", e.getMessage());
            
            // Provide fallback data
            data.addProperty("online_count", 0);
            data.addProperty("max_players", 20);
            data.add("players", new JsonArray());
            data.add("all_players", new JsonArray());
        }
        
        cachedPlayerData = data;
        lastUpdateTime = currentTime;
        return data;
    }
    
    /**
     * Collects real-time world and dimension data from the Minecraft server
     */
    public static JsonObject collectWorldData() {
        long currentTime = System.currentTimeMillis();
        
        // Use cache if data is fresh
        if (cachedWorldData != null && (currentTime - lastUpdateTime) < CACHE_DURATION_MS) {
            return cachedWorldData;
        }
        
        JsonObject data = createBasicResponse();
        data.addProperty("endpoint", "world");
        
        try {
            // Get data from ServerEventTracker if available
            if (MCPanelMod.getServerTracker() != null) {
                JsonObject serverData = MCPanelMod.getServerTracker().getServerData();
                
                if (serverData.has("world")) {
                    JsonObject worldData = serverData.getAsJsonObject("world");
                    data.add("worlds", worldData.get("worlds"));
                    data.addProperty("total_worlds", worldData.get("total_worlds").getAsInt());
                    data.addProperty("loaded_worlds", worldData.get("loaded_worlds").getAsInt());
                }
                
                // Add world-related events
                if (serverData.has("recent_events")) {
                    data.add("recent_events", serverData.get("recent_events"));
                }
                
            } else {
                // Fallback world data
                JsonArray worlds = new JsonArray();
                JsonObject overworld = new JsonObject();
                overworld.addProperty("dimension", "minecraft:overworld");
                overworld.addProperty("name", "Overworld");
                overworld.addProperty("loaded", true);
                overworld.addProperty("time", 0);
                overworld.addProperty("weather", "clear");
                overworld.addProperty("is_day", true);
                overworld.addProperty("loaded_chunks", 0);
                overworld.addProperty("entities", 0);
                overworld.addProperty("players", 0);
                worlds.add(overworld);
                
                data.add("worlds", worlds);
                data.addProperty("total_worlds", 1);
                data.addProperty("loaded_worlds", 1);
            }
            
            data.addProperty("status", "success");
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to collect world data", e);
            data.addProperty("status", "error");
            data.addProperty("error", e.getMessage());
        }
        
        cachedWorldData = data;
        lastUpdateTime = currentTime;
        return data;
    }
    
    /**
     * Collects real-time performance metrics from the Minecraft server
     */
    public static JsonObject collectPerformanceData() {
        long currentTime = System.currentTimeMillis();
        
        // Use cache if data is fresh
        if (cachedPerformanceData != null && (currentTime - lastUpdateTime) < CACHE_DURATION_MS) {
            return cachedPerformanceData;
        }
        
        JsonObject data = createBasicResponse();
        data.addProperty("endpoint", "performance");
        
        try {
            // Get enhanced performance data from ServerEventTracker
            if (MCPanelMod.getServerTracker() != null) {
                JsonObject serverData = MCPanelMod.getServerTracker().getServerData();
                
                if (serverData.has("performance")) {
                    JsonObject perfData = serverData.getAsJsonObject("performance");
                    data.add("memory", perfData.get("memory"));
                    data.add("threads", perfData.get("threads"));
                    data.add("server", perfData.get("server"));
                    data.add("runtime", perfData.get("runtime"));
                }
                
                if (serverData.has("status")) {
                    JsonObject statusData = serverData.getAsJsonObject("status");
                    JsonObject ticks = new JsonObject();
                    ticks.addProperty("tps", statusData.get("tps").getAsDouble());
                    ticks.addProperty("average_tick_time_ms", statusData.get("tps").getAsDouble() > 0 ? 
                        (1000.0 / statusData.get("tps").getAsDouble()) : 0);
                    data.add("ticks", ticks);
                }
                
            } else {
                // Fallback to basic JVM data
                collectBasicPerformanceData(data);
            }
            
            // Add garbage collection data
            JsonArray gcData = new JsonArray();
            for (GarbageCollectorMXBean gcBean : ManagementFactory.getGarbageCollectorMXBeans()) {
                JsonObject gc = new JsonObject();
                gc.addProperty("name", gcBean.getName());
                gc.addProperty("collections", gcBean.getCollectionCount());
                gc.addProperty("time_ms", gcBean.getCollectionTime());
                gcData.add(gc);
            }
            data.add("garbage_collection", gcData);
            
            // Add CPU information
            OperatingSystemMXBean osBean = ManagementFactory.getOperatingSystemMXBean();
            JsonObject cpu = new JsonObject();
            cpu.addProperty("load_average", osBean.getSystemLoadAverage());
            cpu.addProperty("available_processors", osBean.getAvailableProcessors());
            data.add("cpu", cpu);
            
            data.addProperty("status", "success");
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to collect performance data", e);
            data.addProperty("status", "error");
            data.addProperty("error", e.getMessage());
        }
        
        cachedPerformanceData = data;
        lastUpdateTime = currentTime;
        return data;
    }
    
    /**
     * Collect basic performance data as fallback
     */
    private static void collectBasicPerformanceData(JsonObject data) {
        // Real JVM memory data
        MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
        JsonObject memory = new JsonObject();
        long heapUsed = memoryBean.getHeapMemoryUsage().getUsed();
        long heapMax = memoryBean.getHeapMemoryUsage().getMax();
        memory.addProperty("heap_used_mb", heapUsed / 1024 / 1024);
        memory.addProperty("heap_max_mb", heapMax / 1024 / 1024);
        memory.addProperty("heap_usage_percent", (double) heapUsed / heapMax * 100);
        data.add("memory", memory);
        
        // Real thread data
        ThreadMXBean threadBean = ManagementFactory.getThreadMXBean();
        JsonObject threads = new JsonObject();
        threads.addProperty("thread_count", threadBean.getThreadCount());
        threads.addProperty("daemon_thread_count", threadBean.getDaemonThreadCount());
        threads.addProperty("peak_thread_count", threadBean.getPeakThreadCount());
        data.add("threads", threads);
        
        // Basic TPS (fallback)
        JsonObject ticks = new JsonObject();
        ticks.addProperty("tps", 20.0);
        ticks.addProperty("average_tick_time_ms", 50.0);
        data.add("ticks", ticks);
        
        // Server status
        JsonObject server = new JsonObject();
        server.addProperty("running", true);
        server.addProperty("uptime_ms", ManagementFactory.getRuntimeMXBean().getUptime());
        data.add("server", server);
    }
    
    /**
     * Collects mod information from the Minecraft server
     */
    public static JsonObject collectModData() {
        JsonObject data = createBasicResponse();
        data.addProperty("endpoint", "mods");
        
        try {
            JsonArray mods = new JsonArray();
            
            // Add MC Panel mod info
            JsonObject mcPanel = new JsonObject();
            mcPanel.addProperty("mod_id", "mcpanel");
            mcPanel.addProperty("name", "MC Panel Data Collector");
            mcPanel.addProperty("version", "1.0.0");
            mcPanel.addProperty("description", "Full-featured real-time server data collection mod");
            mcPanel.addProperty("author", "Akumas");
            mcPanel.addProperty("enabled", true);
            mcPanel.addProperty("server_side", true);
            mcPanel.addProperty("client_side", false);
            mods.add(mcPanel);
            
            // TODO: Add real mod detection when Forge APIs are available:
            // ModContainer mcPanelContainer = ModLoadingContext.get().getActiveContainer();
            // for (ModInfo modInfo : FMLLoader.getLoadingModList().getMods()) {
            //     JsonObject mod = new JsonObject();
            //     mod.addProperty("mod_id", modInfo.getModId());
            //     mod.addProperty("name", modInfo.getDisplayName());
            //     mod.addProperty("version", modInfo.getVersion().toString());
            //     // ... add more mod info
            //     mods.add(mod);
            // }
            
            data.add("mods", mods);
            data.addProperty("total_mods", mods.size());
            data.addProperty("forge_version", "47.4.0"); // Current target
            data.addProperty("minecraft_version", "1.20.1");
            data.addProperty("status", "success");
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to collect mod data", e);
            data.addProperty("status", "error");
            data.addProperty("error", e.getMessage());
        }
        
        return data;
    }
    
    /**
     * Collects security-related data from the Minecraft server
     */
    public static JsonObject collectSecurityData() {
        JsonObject data = createBasicResponse();
        data.addProperty("endpoint", "security");
        
        try {
            JsonObject security = new JsonObject();
            security.addProperty("whitelist_enabled", false); // Default
            security.addProperty("online_mode", true); // Most servers use online mode
            security.addProperty("enforce_whitelist", false);
            security.addProperty("difficulty", "normal");
            security.addProperty("hardcore", false);
            security.addProperty("pvp_enabled", true);
            security.addProperty("command_blocks_enabled", true);
            
            // Ban/whitelist data (placeholders)
            JsonArray bans = new JsonArray();
            JsonArray whitelist = new JsonArray();
            JsonArray ops = new JsonArray();
            
            // TODO: Populate with real data when Minecraft APIs are available:
            // MinecraftServer server = ServerLifecycleHooks.getCurrentServer();
            // if (server != null) {
            //     PlayerList playerList = server.getPlayerList();
            //     UserWhiteList whitelistObj = playerList.getWhiteList();
            //     UserBanList banList = playerList.getBans();
            //     ServerOpList opList = playerList.getOps();
            //     
            //     for (UserWhiteListEntry entry : whitelistObj.getEntries()) {
            //         // Add whitelist entry
            //     }
            //     // ... similar for bans and ops
            // }
            
            security.add("banned_players", bans);
            security.add("whitelisted_players", whitelist);
            security.add("operators", ops);
            security.addProperty("total_bans", bans.size());
            security.addProperty("total_whitelist", whitelist.size());
            security.addProperty("total_ops", ops.size());
            
            data.add("security", security);
            data.addProperty("status", "success");
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to collect security data", e);
            data.addProperty("status", "error");
            data.addProperty("error", e.getMessage());
        }
        
        return data;
    }
    
    /**
     * Collects miscellaneous server data including console logs and chat
     */
    public static JsonObject collectMiscData() {
        JsonObject data = createBasicResponse();
        data.addProperty("endpoint", "misc");
        
        try {
            RuntimeMXBean runtimeBean = ManagementFactory.getRuntimeMXBean();
            
            // Enhanced server information
            JsonObject serverInfo = new JsonObject();
            serverInfo.addProperty("server_name", "MC Panel Enhanced Live Server");
            serverInfo.addProperty("server_version", "1.20.1");
            serverInfo.addProperty("forge_version", "47.4.0");
            serverInfo.addProperty("java_version", System.getProperty("java.version"));
            serverInfo.addProperty("java_vendor", System.getProperty("java.vendor"));
            serverInfo.addProperty("os_name", System.getProperty("os.name"));
            serverInfo.addProperty("os_arch", System.getProperty("os.arch"));
            serverInfo.addProperty("uptime_ms", runtimeBean.getUptime());
            serverInfo.addProperty("max_memory_mb", Runtime.getRuntime().maxMemory() / 1024 / 1024);
            
            data.add("server_info", serverInfo);
            
            // Add console data if available
            if (MCPanelMod.getConsoleCapture() != null) {
                JsonObject consoleData = MCPanelMod.getConsoleCapture().getConsoleData();
                data.add("console", consoleData);
            }
            
            // Add chat data if available
            if (MCPanelMod.getChatRelay() != null) {
                JsonObject chatData = MCPanelMod.getChatRelay().getChatData();
                data.add("chat", chatData);
            }
            
            // Add event data if available
            if (MCPanelMod.getEventHandlers() != null) {
                JsonObject eventData = MCPanelMod.getEventHandlers().getEventData();
                data.add("events", eventData);
            }
            
            data.addProperty("status", "success");
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to collect misc data", e);
            data.addProperty("status", "error");
            data.addProperty("error", e.getMessage());
        }
        
        return data;
    }
    
    /**
     * Collects all data endpoints in a single response
     */
    public static JsonObject collectAllData() {
        JsonObject data = createBasicResponse();
        data.addProperty("endpoint", "all");
        
        try {
            data.add("players", collectPlayerData());
            data.add("world", collectWorldData());
            data.add("performance", collectPerformanceData());
            data.add("mods", collectModData());
            data.add("security", collectSecurityData());
            data.add("misc", collectMiscData());
            data.addProperty("status", "success");
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to collect all data", e);
            data.addProperty("status", "error");
            data.addProperty("error", e.getMessage());
        }
        
        return data;
    }
    
    /**
     * Create a basic response object with common fields
     */
    private static JsonObject createBasicResponse() {
        JsonObject response = new JsonObject();
        response.addProperty("timestamp", System.currentTimeMillis());
        response.addProperty("server_time", System.currentTimeMillis());
        response.addProperty("collector_version", "1.0.0");
        response.addProperty("implementation", "MC Panel Enhanced Live Data Collector");
        return response;
    }
}