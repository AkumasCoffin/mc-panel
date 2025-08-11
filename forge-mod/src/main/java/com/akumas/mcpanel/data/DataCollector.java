package com.akumas.mcpanel.data;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import net.minecraft.resources.ResourceLocation;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import com.akumas.mcpanel.collectors.*;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class DataCollector {
    private static final Logger LOGGER = LogManager.getLogger();
    private final MinecraftServer server;
    private final Gson gson;
    
    // Collectors for different data types
    private final PlayerDataCollector playerDataCollector;
    private final WorldDataCollector worldDataCollector;
    private final PerformanceDataCollector performanceDataCollector;
    private final ModDataCollector modDataCollector;
    private final SecurityDataCollector securityDataCollector;
    private final MiscDataCollector miscDataCollector;
    
    // Cached data
    private JsonObject cachedData;
    private long lastUpdate;
    private final ScheduledExecutorService scheduler;
    
    public DataCollector(MinecraftServer server) {
        this.server = server;
        this.gson = new GsonBuilder().setPrettyPrinting().create();
        
        // Initialize collectors
        this.playerDataCollector = new PlayerDataCollector(server);
        this.worldDataCollector = new WorldDataCollector(server);
        this.performanceDataCollector = new PerformanceDataCollector(server);
        this.modDataCollector = new ModDataCollector(server);
        this.securityDataCollector = new SecurityDataCollector(server);
        this.miscDataCollector = new MiscDataCollector(server);
        
        // Create scheduler for periodic data updates
        this.scheduler = Executors.newScheduledThreadPool(1);
        this.cachedData = new JsonObject();
        this.lastUpdate = 0;
        
        // Schedule data collection every 5 seconds
        scheduler.scheduleAtFixedRate(this::updateCachedData, 0, 5, TimeUnit.SECONDS);
        
        LOGGER.info("DataCollector initialized");
    }
    
    private void updateCachedData() {
        try {
            JsonObject data = new JsonObject();
            
            // Add timestamp
            data.addProperty("timestamp", System.currentTimeMillis());
            data.addProperty("server_name", server.getServerModName());
            data.addProperty("server_version", server.getServerVersion());
            
            // Collect all data types
            data.add("players", playerDataCollector.collectData());
            data.add("world", worldDataCollector.collectData());
            data.add("performance", performanceDataCollector.collectData());
            data.add("mods", modDataCollector.collectData());
            data.add("security", securityDataCollector.collectData());
            data.add("misc", miscDataCollector.collectData());
            
            this.cachedData = data;
            this.lastUpdate = System.currentTimeMillis();
            
        } catch (Exception e) {
            LOGGER.error("Error updating cached data", e);
        }
    }
    
    public JsonObject getAllData() {
        return cachedData;
    }
    
    public JsonObject getPlayerData() {
        return cachedData.has("players") ? cachedData.getAsJsonObject("players") : new JsonObject();
    }
    
    public JsonObject getWorldData() {
        return cachedData.has("world") ? cachedData.getAsJsonObject("world") : new JsonObject();
    }
    
    public JsonObject getPerformanceData() {
        return cachedData.has("performance") ? cachedData.getAsJsonObject("performance") : new JsonObject();
    }
    
    public JsonObject getModData() {
        return cachedData.has("mods") ? cachedData.getAsJsonObject("mods") : new JsonObject();
    }
    
    public JsonObject getSecurityData() {
        return cachedData.has("security") ? cachedData.getAsJsonObject("security") : new JsonObject();
    }
    
    public JsonObject getMiscData() {
        return cachedData.has("misc") ? cachedData.getAsJsonObject("misc") : new JsonObject();
    }
    
    public long getLastUpdateTime() {
        return lastUpdate;
    }
    
    public void shutdown() {
        if (scheduler != null) {
            scheduler.shutdown();
        }
    }
    
    public MinecraftServer getServer() {
        return server;
    }
}