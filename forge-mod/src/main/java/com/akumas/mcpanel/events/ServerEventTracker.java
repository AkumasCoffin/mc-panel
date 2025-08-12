package com.akumas.mcpanel.events;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.logging.Logger;
import java.util.logging.Level;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.ThreadMXBean;
import java.lang.management.RuntimeMXBean;

/**
 * Tracks server-wide events and maintains comprehensive server data.
 * Provides detailed server monitoring including world data, performance metrics, and system events.
 */
public class ServerEventTracker {
    private static final Logger LOGGER = Logger.getLogger(ServerEventTracker.class.getName());
    
    // Server event storage
    private final ConcurrentLinkedQueue<JsonObject> serverEvents = new ConcurrentLinkedQueue<>();
    private final AtomicLong serverStartTime = new AtomicLong(System.currentTimeMillis());
    private final AtomicLong lastTpsUpdate = new AtomicLong(System.currentTimeMillis());
    
    private static final int MAX_SERVER_EVENTS = 200;
    
    // Server state tracking
    private volatile boolean serverRunning = true;
    private volatile double currentTps = 20.0;
    private volatile JsonObject worldData = null;
    private volatile JsonObject performanceData = null;
    
    // Cache for performance
    private volatile JsonObject cachedServerData = null;
    private volatile long lastDataUpdate = 0;
    private static final long CACHE_DURATION_MS = 5000; // 5 seconds
    
    // TPS calculation
    private final long[] tickTimes = new long[100]; // Store last 100 tick times
    private int tickIndex = 0;
    
    public ServerEventTracker() {
        LOGGER.info("ServerEventTracker initialized");
        initializeWorldData();
    }
    
    /**
     * Handles server tick event for TPS calculation
     * TODO: Add @SubscribeEvent annotation when Forge APIs are available
     */
    // @SubscribeEvent
    public void onServerTick(Object event) {
        try {
            // Update TPS calculation
            updateTpsCalculation();
            
            // Periodically update world and performance data
            long currentTime = System.currentTimeMillis();
            if (currentTime - lastTpsUpdate.get() >= 5000) { // Every 5 seconds
                updateWorldData();
                updatePerformanceData();
                lastTpsUpdate.set(currentTime);
            }
        } catch (Exception e) {
            LOGGER.log(Level.FINE, "Error handling server tick", e);
        }
    }
    
    /**
     * Handles server starting event
     * TODO: Add @SubscribeEvent annotation when Forge APIs are available
     */
    // @SubscribeEvent
    public void onServerStarting(Object event) {
        try {
            LOGGER.info("Server starting event received");
            
            serverStartTime.set(System.currentTimeMillis());
            serverRunning = true;
            
            JsonObject startEvent = new JsonObject();
            startEvent.addProperty("type", "server_starting");
            startEvent.addProperty("timestamp", System.currentTimeMillis());
            startEvent.addProperty("message", "Server is starting up");
            
            addServerEvent(startEvent);
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error handling server starting event", e);
        }
    }
    
    /**
     * Handles server started event
     * TODO: Add @SubscribeEvent annotation when Forge APIs are available
     */
    // @SubscribeEvent
    public void onServerStarted(Object event) {
        try {
            LOGGER.info("Server started event received");
            
            JsonObject startedEvent = new JsonObject();
            startedEvent.addProperty("type", "server_started");
            startedEvent.addProperty("timestamp", System.currentTimeMillis());
            startedEvent.addProperty("message", "Server has fully started");
            startedEvent.addProperty("startup_time_ms", System.currentTimeMillis() - serverStartTime.get());
            
            addServerEvent(startedEvent);
            
            // Initialize full server data
            initializeServerData();
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error handling server started event", e);
        }
    }
    
    /**
     * Handles server stopping event
     * TODO: Add @SubscribeEvent annotation when Forge APIs are available
     */
    // @SubscribeEvent
    public void onServerStopping(Object event) {
        try {
            LOGGER.info("Server stopping event received");
            
            serverRunning = false;
            
            JsonObject stopEvent = new JsonObject();
            stopEvent.addProperty("type", "server_stopping");
            stopEvent.addProperty("timestamp", System.currentTimeMillis());
            stopEvent.addProperty("message", "Server is shutting down");
            stopEvent.addProperty("uptime_ms", System.currentTimeMillis() - serverStartTime.get());
            
            addServerEvent(stopEvent);
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error handling server stopping event", e);
        }
    }
    
    /**
     * Handles world save event
     * TODO: Add @SubscribeEvent annotation when Forge APIs are available
     */
    // @SubscribeEvent
    public void onWorldSave(Object event) {
        try {
            JsonObject saveEvent = new JsonObject();
            saveEvent.addProperty("type", "world_save");
            saveEvent.addProperty("timestamp", System.currentTimeMillis());
            saveEvent.addProperty("message", "World data saved");
            
            addServerEvent(saveEvent);
            LOGGER.info("World save event tracked");
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error handling world save event", e);
        }
    }
    
    /**
     * Initialize server data collection
     */
    private void initializeServerData() {
        try {
            updateWorldData();
            updatePerformanceData();
            LOGGER.info("Server data initialized");
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error initializing server data", e);
        }
    }
    
    /**
     * Initialize world data
     */
    private void initializeWorldData() {
        worldData = new JsonObject();
        worldData.addProperty("timestamp", System.currentTimeMillis());
        
        // Basic world information
        JsonArray worlds = new JsonArray();
        
        // Overworld
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
        
        // Nether
        JsonObject nether = new JsonObject();
        nether.addProperty("dimension", "minecraft:the_nether");
        nether.addProperty("name", "The Nether");
        nether.addProperty("loaded", false);
        nether.addProperty("time", 18000);
        nether.addProperty("weather", "none");
        nether.addProperty("is_day", false);
        nether.addProperty("loaded_chunks", 0);
        nether.addProperty("entities", 0);
        nether.addProperty("players", 0);
        worlds.add(nether);
        
        // End
        JsonObject end = new JsonObject();
        end.addProperty("dimension", "minecraft:the_end");
        end.addProperty("name", "The End");
        end.addProperty("loaded", false);
        end.addProperty("time", 0);
        end.addProperty("weather", "none");
        end.addProperty("is_day", true);
        end.addProperty("loaded_chunks", 0);
        end.addProperty("entities", 0);
        end.addProperty("players", 0);
        worlds.add(end);
        
        worldData.add("worlds", worlds);
        worldData.addProperty("total_worlds", worlds.size());
        worldData.addProperty("loaded_worlds", 1);
    }
    
    /**
     * Update world data with current information
     */
    private void updateWorldData() {
        try {
            // TODO: Get real world data when Minecraft APIs are available
            // MinecraftServer server = ServerLifecycleHooks.getCurrentServer();
            // if (server != null) {
            //     for (ServerLevel level : server.getAllLevels()) {
            //         // Update world information
            //     }
            // }
            
            // For now, simulate some dynamic updates
            JsonArray worlds = worldData.getAsJsonArray("worlds");
            for (int i = 0; i < worlds.size(); i++) {
                JsonObject world = worlds.get(i).getAsJsonObject();
                
                // Update time for overworld
                if ("minecraft:overworld".equals(world.get("dimension").getAsString())) {
                    long currentTime = (System.currentTimeMillis() / 1000) % 24000; // Simulate day/night cycle
                    world.addProperty("time", currentTime);
                    world.addProperty("is_day", currentTime >= 0 && currentTime < 12000);
                    
                    // Simulate some loaded chunks and entities
                    world.addProperty("loaded_chunks", 25 + (int)(Math.random() * 10));
                    world.addProperty("entities", 100 + (int)(Math.random() * 50));
                }
            }
            
            worldData.addProperty("timestamp", System.currentTimeMillis());
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error updating world data", e);
        }
    }
    
    /**
     * Update performance data
     */
    private void updatePerformanceData() {
        try {
            performanceData = new JsonObject();
            performanceData.addProperty("timestamp", System.currentTimeMillis());
            
            // JVM Memory data
            MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
            JsonObject memory = new JsonObject();
            long heapUsed = memoryBean.getHeapMemoryUsage().getUsed();
            long heapMax = memoryBean.getHeapMemoryUsage().getMax();
            long nonHeapUsed = memoryBean.getNonHeapMemoryUsage().getUsed();
            
            memory.addProperty("heap_used_mb", heapUsed / 1024 / 1024);
            memory.addProperty("heap_max_mb", heapMax / 1024 / 1024);
            memory.addProperty("heap_usage_percent", (double) heapUsed / heapMax * 100);
            memory.addProperty("non_heap_used_mb", nonHeapUsed / 1024 / 1024);
            performanceData.add("memory", memory);
            
            // Thread data
            ThreadMXBean threadBean = ManagementFactory.getThreadMXBean();
            JsonObject threads = new JsonObject();
            threads.addProperty("thread_count", threadBean.getThreadCount());
            threads.addProperty("daemon_thread_count", threadBean.getDaemonThreadCount());
            threads.addProperty("peak_thread_count", threadBean.getPeakThreadCount());
            threads.addProperty("total_started_thread_count", threadBean.getTotalStartedThreadCount());
            performanceData.add("threads", threads);
            
            // Server performance
            JsonObject server = new JsonObject();
            server.addProperty("tps", currentTps);
            server.addProperty("average_tick_time_ms", currentTps > 0 ? (1000.0 / currentTps) : 0);
            server.addProperty("uptime_ms", System.currentTimeMillis() - serverStartTime.get());
            server.addProperty("running", serverRunning);
            performanceData.add("server", server);
            
            // Runtime information
            RuntimeMXBean runtimeBean = ManagementFactory.getRuntimeMXBean();
            JsonObject runtime = new JsonObject();
            runtime.addProperty("vm_name", runtimeBean.getVmName());
            runtime.addProperty("vm_version", runtimeBean.getVmVersion());
            runtime.addProperty("vm_vendor", runtimeBean.getVmVendor());
            runtime.addProperty("spec_name", runtimeBean.getSpecName());
            runtime.addProperty("spec_version", runtimeBean.getSpecVersion());
            runtime.addProperty("management_spec_version", runtimeBean.getManagementSpecVersion());
            performanceData.add("runtime", runtime);
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error updating performance data", e);
        }
    }
    
    /**
     * Update TPS calculation
     */
    private void updateTpsCalculation() {
        try {
            long currentTime = System.currentTimeMillis();
            
            // Store current tick time
            tickTimes[tickIndex] = currentTime;
            tickIndex = (tickIndex + 1) % tickTimes.length;
            
            // Calculate TPS from recent tick times
            if (tickIndex == 0) { // We have a full cycle
                long timeDiff = currentTime - tickTimes[0];
                if (timeDiff > 0) {
                    double avgTickTime = (double) timeDiff / tickTimes.length;
                    currentTps = Math.min(20.0, 1000.0 / avgTickTime);
                }
            }
        } catch (Exception e) {
            LOGGER.log(Level.FINE, "Error updating TPS calculation", e);
        }
    }
    
    /**
     * Add a server event to the storage
     */
    private void addServerEvent(JsonObject event) {
        serverEvents.offer(event);
        
        // Keep only the most recent events
        while (serverEvents.size() > MAX_SERVER_EVENTS) {
            serverEvents.poll();
        }
    }
    
    /**
     * Get comprehensive server data for API responses
     */
    public JsonObject getServerData() {
        long currentTime = System.currentTimeMillis();
        
        // Use cache if data is fresh
        if (cachedServerData != null && (currentTime - lastDataUpdate) < CACHE_DURATION_MS) {
            return cachedServerData;
        }
        
        JsonObject data = new JsonObject();
        data.addProperty("timestamp", currentTime);
        
        // Server status
        JsonObject status = new JsonObject();
        status.addProperty("running", serverRunning);
        status.addProperty("uptime_ms", currentTime - serverStartTime.get());
        status.addProperty("start_time", serverStartTime.get());
        status.addProperty("tps", currentTps);
        data.add("status", status);
        
        // Add world data
        if (worldData != null) {
            data.add("world", worldData);
        }
        
        // Add performance data
        if (performanceData != null) {
            data.add("performance", performanceData);
        }
        
        // Recent events
        JsonArray recentEvents = new JsonArray();
        Object[] events = serverEvents.toArray();
        for (int i = Math.max(0, events.length - 20); i < events.length; i++) {
            recentEvents.add((JsonObject) events[i]);
        }
        data.add("recent_events", recentEvents);
        
        cachedServerData = data;
        lastDataUpdate = currentTime;
        return data;
    }
    
    /**
     * Force refresh of cached data
     */
    public void refreshData() {
        lastDataUpdate = 0;
        cachedServerData = null;
        updateWorldData();
        updatePerformanceData();
    }
    
    /**
     * Get current TPS
     */
    public double getCurrentTps() {
        return currentTps;
    }
    
    /**
     * Get server uptime in milliseconds
     */
    public long getUptimeMs() {
        return System.currentTimeMillis() - serverStartTime.get();
    }
    
    /**
     * Check if server is running
     */
    public boolean isServerRunning() {
        return serverRunning;
    }
    
    /**
     * Get world data
     */
    public JsonObject getWorldData() {
        return worldData;
    }
    
    /**
     * Get performance data
     */
    public JsonObject getPerformanceData() {
        return performanceData;
    }
    
    /**
     * Get recent server events
     */
    public JsonArray getRecentEvents(int limit) {
        JsonArray events = new JsonArray();
        Object[] eventArray = serverEvents.toArray();
        int start = Math.max(0, eventArray.length - limit);
        
        for (int i = start; i < eventArray.length; i++) {
            events.add((JsonObject) eventArray[i]);
        }
        
        return events;
    }
}