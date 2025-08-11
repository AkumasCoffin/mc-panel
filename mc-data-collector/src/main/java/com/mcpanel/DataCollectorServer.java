package com.mcpanel;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.lang.management.OperatingSystemMXBean;
import java.lang.management.ThreadMXBean;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Random;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Standalone data collector that simulates Minecraft server data
 * This provides the same API as the Forge mod would, but with simulated data
 * for demonstration and testing purposes.
 */
public class DataCollectorServer {
    private static final int PORT = 25580;
    private final Gson gson;
    private final Random random;
    private JsonObject cachedData;
    private final ScheduledExecutorService scheduler;
    
    public DataCollectorServer() {
        this.gson = new GsonBuilder().setPrettyPrinting().create();
        this.random = new Random();
        this.scheduler = Executors.newScheduledThreadPool(1);
        this.cachedData = new JsonObject();
        
        // Update data every 5 seconds
        scheduler.scheduleAtFixedRate(this::updateData, 0, 5, TimeUnit.SECONDS);
    }
    
    public static void main(String[] args) {
        try {
            DataCollectorServer server = new DataCollectorServer();
            server.start();
        } catch (Exception e) {
            System.err.println("Failed to start server: " + e.getMessage());
            e.printStackTrace();
        }
    }
    
    public void start() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);
        
        // Set up endpoints
        server.createContext("/api/all", this::handleAllData);
        server.createContext("/api/players", this::handlePlayerData);
        server.createContext("/api/world", this::handleWorldData);
        server.createContext("/api/performance", this::handlePerformanceData);
        server.createContext("/api/mods", this::handleModData);
        server.createContext("/api/security", this::handleSecurityData);
        server.createContext("/api/misc", this::handleMiscData);
        server.createContext("/api/status", this::handleStatus);
        
        server.setExecutor(null);
        server.start();
        
        System.out.println("MC Panel Data Collector started on port " + PORT);
        System.out.println("Available endpoints:");
        System.out.println("  http://localhost:" + PORT + "/api/all");
        System.out.println("  http://localhost:" + PORT + "/api/players");
        System.out.println("  http://localhost:" + PORT + "/api/world");
        System.out.println("  http://localhost:" + PORT + "/api/performance");
        System.out.println("  http://localhost:" + PORT + "/api/mods");
        System.out.println("  http://localhost:" + PORT + "/api/security");
        System.out.println("  http://localhost:" + PORT + "/api/misc");
        System.out.println("  http://localhost:" + PORT + "/api/status");
    }
    
    private void updateData() {
        JsonObject data = new JsonObject();
        
        data.addProperty("timestamp", System.currentTimeMillis());
        data.addProperty("server_name", "MC Panel Demo Server");
        data.addProperty("server_version", "1.20.1");
        
        data.add("players", generatePlayerData());
        data.add("world", generateWorldData());
        data.add("performance", generatePerformanceData());
        data.add("mods", generateModData());
        data.add("security", generateSecurityData());
        data.add("misc", generateMiscData());
        
        this.cachedData = data;
    }
    
    private JsonObject generatePlayerData() {
        JsonObject playerData = new JsonObject();
        JsonArray players = new JsonArray();
        
        // Simulate 2-5 online players
        int playerCount = 2 + random.nextInt(4);
        playerData.addProperty("online_count", playerCount);
        playerData.addProperty("max_players", 20);
        
        String[] playerNames = {"Steve", "Alex", "Herobrine", "Notch", "TestUser"};
        
        for (int i = 0; i < playerCount; i++) {
            JsonObject player = new JsonObject();
            player.addProperty("name", playerNames[i]);
            player.addProperty("uuid", java.util.UUID.randomUUID().toString());
            player.addProperty("display_name", playerNames[i]);
            
            // Location
            JsonObject location = new JsonObject();
            location.addProperty("x", random.nextInt(2000) - 1000);
            location.addProperty("y", 60 + random.nextInt(100));
            location.addProperty("z", random.nextInt(2000) - 1000);
            location.addProperty("dimension", "minecraft:overworld");
            location.addProperty("biome", "minecraft:plains");
            player.add("location", location);
            
            // Status
            JsonObject status = new JsonObject();
            status.addProperty("health", 15.0f + random.nextFloat() * 5.0f);
            status.addProperty("max_health", 20.0f);
            status.addProperty("food_level", 15 + random.nextInt(6));
            status.addProperty("saturation", random.nextFloat() * 5.0f);
            status.addProperty("experience_level", random.nextInt(50));
            status.addProperty("experience_points", random.nextInt(1000));
            status.addProperty("game_mode", "survival");
            status.addProperty("afk", random.nextBoolean());
            status.addProperty("ping", 50 + random.nextInt(100));
            status.addProperty("ip_address", "127.0.0.1");
            player.add("status", status);
            
            // Effects
            JsonArray effects = new JsonArray();
            if (random.nextBoolean()) {
                JsonObject effect = new JsonObject();
                effect.addProperty("name", "minecraft:regeneration");
                effect.addProperty("amplifier", 1);
                effect.addProperty("duration", 300 + random.nextInt(600));
                effect.addProperty("ambient", false);
                effect.addProperty("visible", true);
                effects.add(effect);
            }
            player.add("effects", effects);
            
            // Statistics
            JsonObject stats = new JsonObject();
            stats.addProperty("deaths", random.nextInt(10));
            stats.addProperty("player_kills", random.nextInt(5));
            stats.addProperty("mob_kills", random.nextInt(100));
            stats.addProperty("damage_dealt", random.nextInt(1000));
            stats.addProperty("damage_taken", random.nextInt(500));
            stats.addProperty("time_played", random.nextInt(100000));
            stats.addProperty("distance_walked", random.nextInt(50000));
            stats.addProperty("jumps", random.nextInt(500));
            player.add("statistics", stats);
            
            player.addProperty("advancement_count", 20 + random.nextInt(30));
            
            players.add(player);
        }
        
        playerData.add("players", players);
        return playerData;
    }
    
    private JsonObject generateWorldData() {
        JsonObject worldData = new JsonObject();
        JsonArray worlds = new JsonArray();
        
        // Simulate overworld
        JsonObject world = new JsonObject();
        world.addProperty("dimension", "minecraft:overworld");
        world.addProperty("seed", 123456789L);
        world.addProperty("time", 6000 + random.nextInt(18000));
        world.addProperty("game_time", System.currentTimeMillis() / 50);
        world.addProperty("is_day", random.nextBoolean());
        world.addProperty("is_raining", random.nextBoolean());
        world.addProperty("is_thundering", random.nextBoolean());
        world.addProperty("difficulty", "normal");
        
        // Chunks
        JsonObject chunks = new JsonObject();
        chunks.addProperty("loaded", 100 + random.nextInt(200));
        chunks.addProperty("forced", random.nextInt(10));
        world.add("chunks", chunks);
        
        // Entities
        JsonObject entities = new JsonObject();
        entities.addProperty("total", 50 + random.nextInt(200));
        JsonObject entityTypes = new JsonObject();
        entityTypes.addProperty("minecraft:cow", 5 + random.nextInt(10));
        entityTypes.addProperty("minecraft:pig", 3 + random.nextInt(8));
        entityTypes.addProperty("minecraft:zombie", 2 + random.nextInt(5));
        entityTypes.addProperty("minecraft:skeleton", 1 + random.nextInt(4));
        entities.add("types", entityTypes);
        world.add("entities", entities);
        
        worlds.add(world);
        worldData.add("worlds", worlds);
        
        // Game rules
        JsonObject gameRules = new JsonObject();
        gameRules.addProperty("doFireTick", true);
        gameRules.addProperty("mobGriefing", true);
        gameRules.addProperty("keepInventory", false);
        gameRules.addProperty("doMobSpawning", true);
        gameRules.addProperty("doDaylightCycle", true);
        gameRules.addProperty("randomTickSpeed", 3);
        worldData.add("game_rules", gameRules);
        
        return worldData;
    }
    
    private JsonObject generatePerformanceData() {
        JsonObject perfData = new JsonObject();
        
        // Memory
        JsonObject memory = new JsonObject();
        MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
        MemoryUsage heapUsage = memoryBean.getHeapMemoryUsage();
        
        memory.addProperty("heap_used", heapUsage.getUsed());
        memory.addProperty("heap_max", heapUsage.getMax());
        memory.addProperty("heap_committed", heapUsage.getCommitted());
        memory.addProperty("heap_usage_percent", 
            (double) heapUsage.getUsed() / heapUsage.getMax() * 100.0);
        perfData.add("memory", memory);
        
        // CPU
        JsonObject cpu = new JsonObject();
        OperatingSystemMXBean osBean = ManagementFactory.getOperatingSystemMXBean();
        cpu.addProperty("available_processors", osBean.getAvailableProcessors());
        cpu.addProperty("load_average", osBean.getSystemLoadAverage());
        perfData.add("cpu", cpu);
        
        // Threads
        JsonObject threads = new JsonObject();
        ThreadMXBean threadBean = ManagementFactory.getThreadMXBean();
        threads.addProperty("thread_count", threadBean.getThreadCount());
        threads.addProperty("daemon_thread_count", threadBean.getDaemonThreadCount());
        perfData.add("threads", threads);
        
        // Simulated tick data
        JsonObject ticks = new JsonObject();
        double avgTickTime = 45.0 + random.nextGaussian() * 5.0; // Around 45ms
        ticks.addProperty("average_tick_time_ms", avgTickTime);
        ticks.addProperty("tps", Math.min(20.0, 1000.0 / avgTickTime));
        ticks.addProperty("current_tick", random.nextInt(1000000));
        perfData.add("ticks", ticks);
        
        return perfData;
    }
    
    private JsonObject generateModData() {
        JsonObject modData = new JsonObject();
        JsonArray mods = new JsonArray();
        
        // Simulate some mods
        String[][] modList = {
            {"mcpanel", "MC Panel Data Collector", "1.0.0"},
            {"forge", "Minecraft Forge", "47.2.0"},
            {"jei", "Just Enough Items", "15.2.0.27"},
            {"waystones", "Waystones", "14.1.3"}
        };
        
        for (String[] modInfo : modList) {
            JsonObject mod = new JsonObject();
            mod.addProperty("mod_id", modInfo[0]);
            mod.addProperty("display_name", modInfo[1]);
            mod.addProperty("version", modInfo[2]);
            mod.addProperty("description", "Mod description for " + modInfo[1]);
            mods.add(mod);
        }
        
        modData.addProperty("total_mods", mods.size());
        modData.add("mods", mods);
        
        JsonObject forgeInfo = new JsonObject();
        forgeInfo.addProperty("version", "47.2.0");
        forgeInfo.addProperty("minecraft_version", "1.20.1");
        modData.add("forge_info", forgeInfo);
        
        return modData;
    }
    
    private JsonObject generateSecurityData() {
        JsonObject secData = new JsonObject();
        
        // Operators
        JsonObject operators = new JsonObject();
        JsonArray opList = new JsonArray();
        JsonObject op = new JsonObject();
        op.addProperty("name", "admin");
        op.addProperty("level", 4);
        op.addProperty("bypass_player_limit", true);
        opList.add(op);
        operators.addProperty("count", 1);
        operators.add("operators", opList);
        secData.add("operators", operators);
        
        // Whitelist
        JsonObject whitelist = new JsonObject();
        whitelist.addProperty("enabled", false);
        whitelist.addProperty("count", 0);
        whitelist.add("players", new JsonArray());
        secData.add("whitelist", whitelist);
        
        // Banned players
        JsonObject bannedPlayers = new JsonObject();
        bannedPlayers.addProperty("count", 0);
        bannedPlayers.add("players", new JsonArray());
        secData.add("banned_players", bannedPlayers);
        
        // Banned IPs
        JsonObject bannedIps = new JsonObject();
        bannedIps.addProperty("count", 0);
        bannedIps.add("ips", new JsonArray());
        secData.add("banned_ips", bannedIps);
        
        return secData;
    }
    
    private JsonObject generateMiscData() {
        JsonObject miscData = new JsonObject();
        
        // Server properties
        JsonObject props = new JsonObject();
        props.addProperty("server_port", "25565");
        props.addProperty("level_name", "world");
        props.addProperty("gamemode", "survival");
        props.addProperty("difficulty", "normal");
        props.addProperty("max_players", "20");
        props.addProperty("online_mode", "true");
        props.addProperty("motd", "A Minecraft Server with MC Panel");
        miscData.add("server_properties", props);
        
        // Scoreboards
        JsonObject scoreboards = new JsonObject();
        scoreboards.addProperty("objective_count", 0);
        scoreboards.addProperty("team_count", 0);
        scoreboards.add("objectives", new JsonArray());
        scoreboards.add("teams", new JsonArray());
        miscData.add("scoreboards", scoreboards);
        
        return miscData;
    }
    
    private void handleAllData(HttpExchange exchange) throws IOException {
        sendJsonResponse(exchange, cachedData);
    }
    
    private void handlePlayerData(HttpExchange exchange) throws IOException {
        JsonObject playerData = cachedData.has("players") ? 
            cachedData.getAsJsonObject("players") : new JsonObject();
        sendJsonResponse(exchange, playerData);
    }
    
    private void handleWorldData(HttpExchange exchange) throws IOException {
        JsonObject worldData = cachedData.has("world") ? 
            cachedData.getAsJsonObject("world") : new JsonObject();
        sendJsonResponse(exchange, worldData);
    }
    
    private void handlePerformanceData(HttpExchange exchange) throws IOException {
        JsonObject perfData = cachedData.has("performance") ? 
            cachedData.getAsJsonObject("performance") : new JsonObject();
        sendJsonResponse(exchange, perfData);
    }
    
    private void handleModData(HttpExchange exchange) throws IOException {
        JsonObject modData = cachedData.has("mods") ? 
            cachedData.getAsJsonObject("mods") : new JsonObject();
        sendJsonResponse(exchange, modData);
    }
    
    private void handleSecurityData(HttpExchange exchange) throws IOException {
        JsonObject secData = cachedData.has("security") ? 
            cachedData.getAsJsonObject("security") : new JsonObject();
        sendJsonResponse(exchange, secData);
    }
    
    private void handleMiscData(HttpExchange exchange) throws IOException {
        JsonObject miscData = cachedData.has("misc") ? 
            cachedData.getAsJsonObject("misc") : new JsonObject();
        sendJsonResponse(exchange, miscData);
    }
    
    private void handleStatus(HttpExchange exchange) throws IOException {
        JsonObject status = new JsonObject();
        status.addProperty("status", "ok");
        status.addProperty("last_update", System.currentTimeMillis());
        status.addProperty("server_running", true);
        status.addProperty("mod_version", "1.0.0");
        sendJsonResponse(exchange, status);
    }
    
    private void sendJsonResponse(HttpExchange exchange, JsonObject data) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        exchange.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
        
        String response = gson.toJson(data);
        byte[] responseBytes = response.getBytes(StandardCharsets.UTF_8);
        
        exchange.sendResponseHeaders(200, responseBytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(responseBytes);
        }
    }
}