package com.akumas.mcpanel.events;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceLocation;
import net.minecraftforge.event.entity.player.PlayerEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.event.entity.living.LivingDeathEvent;
import net.minecraftforge.event.entity.player.AdvancementEvent;

import java.util.logging.Logger;
import java.util.logging.Level;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.Map;
import java.util.Set;

/**
 * Tracks player-specific events and maintains detailed player data.
 * Provides comprehensive player monitoring including inventories, stats, locations, health, etc.
 * Tracks real-time online/offline status of players for accurate dashboard display.
 */
public class PlayerEventTracker {
    private static final Logger LOGGER = Logger.getLogger(PlayerEventTracker.class.getName());
    
    // Player data storage
    private final Map<String, JsonObject> playerData = new ConcurrentHashMap<>();
    private final Map<String, JsonObject> playerStats = new ConcurrentHashMap<>();
    private final Map<String, JsonObject> playerInventories = new ConcurrentHashMap<>();
    private final Map<String, JsonObject> playerLocations = new ConcurrentHashMap<>();
    private final ConcurrentLinkedQueue<JsonObject> playerEvents = new ConcurrentLinkedQueue<>();
    
    // Track currently online players for real-time status
    private final Set<String> onlinePlayers = ConcurrentHashMap.newKeySet();
    
    private static final int MAX_PLAYER_EVENTS = 500;
    
    // Cache for performance
    private volatile JsonObject cachedPlayerData = null;
    private volatile long lastDataUpdate = 0;
    private static final long CACHE_DURATION_MS = 5000; // 5 seconds
    
    public PlayerEventTracker() {
        LOGGER.info("PlayerEventTracker initialized");
    }
    
    /**
     * Handles player join event
     * Adds player to online tracking set and creates player data
     */
    @SubscribeEvent
    public void onPlayerJoin(PlayerEvent.PlayerLoggedInEvent event) {
        try {
            Player player = event.getEntity();
            String playerName = player.getName().getString();
            String playerUUID = player.getUUID().toString();
            
            LOGGER.info("Player joined: " + playerName + " (" + playerUUID + ")");
            
            // Add to online players set
            onlinePlayers.add(playerUUID);
            
            // Create player data object
            JsonObject playerInfo = new JsonObject();
            playerInfo.addProperty("uuid", playerUUID);
            playerInfo.addProperty("name", playerName);
            playerInfo.addProperty("online", true);
            playerInfo.addProperty("join_time", System.currentTimeMillis());
            
            // Get player location
            if (player instanceof ServerPlayer serverPlayer) {
                BlockPos pos = serverPlayer.blockPosition();
                JsonObject location = new JsonObject();
                location.addProperty("world", serverPlayer.level().dimension().location().toString());
                location.addProperty("x", pos.getX());
                location.addProperty("y", pos.getY());
                location.addProperty("z", pos.getZ());
                playerInfo.add("location", location);
                
                // Get health status
                JsonObject healthStatus = new JsonObject();
                healthStatus.addProperty("health", serverPlayer.getHealth());
                healthStatus.addProperty("max_health", serverPlayer.getMaxHealth());
                healthStatus.addProperty("food_level", serverPlayer.getFoodData().getFoodLevel());
                healthStatus.addProperty("experience_level", serverPlayer.experienceLevel);
                healthStatus.addProperty("experience_points", serverPlayer.totalExperience);
                playerInfo.add("health_status", healthStatus);
                
                // Update inventories
                updatePlayerInventory(serverPlayer);
            }
            
            playerData.put(playerUUID, playerInfo);
            
            // Add join event
            JsonObject joinEvent = new JsonObject();
            joinEvent.addProperty("type", "player_join");
            joinEvent.addProperty("timestamp", System.currentTimeMillis());
            joinEvent.addProperty("player_name", playerName);
            joinEvent.addProperty("player_uuid", playerUUID);
            joinEvent.addProperty("message", "Player joined the server");
            
            addPlayerEvent(joinEvent);
            invalidateCache();
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error handling player join event", e);
        }
    }
    
    /**
     * Handles player leave event
     * Removes player from online tracking set but keeps historical data
     */
    @SubscribeEvent
    public void onPlayerLeave(PlayerEvent.PlayerLoggedOutEvent event) {
        try {
            Player player = event.getEntity();
            String playerName = player.getName().getString();
            String playerUUID = player.getUUID().toString();
            
            LOGGER.info("Player left: " + playerName + " (" + playerUUID + ")");
            
            // Remove player from online set (but keep their data for history)
            onlinePlayers.remove(playerUUID);
            
            // Update player's online status in their data
            JsonObject playerInfo = playerData.get(playerUUID);
            if (playerInfo != null) {
                playerInfo.addProperty("online", false);
                playerInfo.addProperty("last_seen", System.currentTimeMillis());
                
                // Calculate session duration
                long joinTime = playerInfo.has("join_time") ? playerInfo.get("join_time").getAsLong() : System.currentTimeMillis();
                playerInfo.addProperty("session_duration", System.currentTimeMillis() - joinTime);
            }
            
            // Track leave event
            JsonObject leaveEvent = new JsonObject();
            leaveEvent.addProperty("type", "player_leave");
            leaveEvent.addProperty("timestamp", System.currentTimeMillis());
            leaveEvent.addProperty("player_uuid", playerUUID);
            leaveEvent.addProperty("player_name", playerName);
            if (playerInfo != null && playerInfo.has("join_time")) {
                leaveEvent.addProperty("session_duration", System.currentTimeMillis() - playerInfo.get("join_time").getAsLong());
            }
            
            addPlayerEvent(leaveEvent);
            invalidateCache();
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error tracking player leave", e);
        }
    }
    
    /**
     * Handles player death event
     */
    @SubscribeEvent
    public void onPlayerDeath(LivingDeathEvent event) {
        try {
            if (event.getEntity() instanceof Player player) {
                String playerName = player.getName().getString();
                String playerUUID = player.getUUID().toString();
                
                LOGGER.info("Player death: " + playerName);
                
                // Update player stats
                JsonObject stats = playerStats.computeIfAbsent(playerUUID, k -> new JsonObject());
                int deaths = stats.has("deaths") ? stats.get("deaths").getAsInt() : 0;
                stats.addProperty("deaths", deaths + 1);
                stats.addProperty("last_death", System.currentTimeMillis());
                
                // Track death event
                JsonObject deathEvent = new JsonObject();
                deathEvent.addProperty("type", "player_death");
                deathEvent.addProperty("timestamp", System.currentTimeMillis());
                deathEvent.addProperty("player_uuid", playerUUID);
                deathEvent.addProperty("player_name", playerName);
                deathEvent.addProperty("death_message", event.getSource().getLocalizedDeathMessage(event.getEntity()).getString());
                
                if (player instanceof ServerPlayer serverPlayer) {
                    BlockPos pos = serverPlayer.blockPosition();
                    JsonObject location = new JsonObject();
                    location.addProperty("world", serverPlayer.level().dimension().location().toString());
                    location.addProperty("x", pos.getX());
                    location.addProperty("y", pos.getY());
                    location.addProperty("z", pos.getZ());
                    deathEvent.add("death_location", location);
                }
                
                addPlayerEvent(deathEvent);
                invalidateCache();
            }
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error tracking player death", e);
        }
    }
    
    /**
     * Handles advancement/achievement events
     */
    @SubscribeEvent
    public void onAdvancement(AdvancementEvent event) {
        try {
            Player player = event.getEntity();
            String playerName = player.getName().getString();
            String playerUUID = player.getUUID().toString();
            
            ResourceLocation advancementId = event.getAdvancement().getId();
            
            LOGGER.info("Player advancement: " + playerName + " - " + advancementId);
            
            // Track advancement event
            JsonObject advancementEvent = new JsonObject();
            advancementEvent.addProperty("type", "player_advancement");
            advancementEvent.addProperty("timestamp", System.currentTimeMillis());
            advancementEvent.addProperty("player_uuid", playerUUID);
            advancementEvent.addProperty("player_name", playerName);
            advancementEvent.addProperty("advancement_id", advancementId.toString());
            
            addPlayerEvent(advancementEvent);
            invalidateCache();
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error tracking player advancement", e);
        }
    }
    
    /**
     * Updates player inventory data
     */
    private void updatePlayerInventory(ServerPlayer player) {
        try {
            String playerUUID = player.getUUID().toString();
            
            JsonObject inventory = new JsonObject();
            JsonArray mainInventory = new JsonArray();
            JsonArray armor = new JsonArray();
            JsonObject offhand = new JsonObject();
            
            // Main inventory (36 slots)
            for (int i = 0; i < 36; i++) {
                ItemStack item = player.getInventory().getItem(i);
                JsonObject slot = new JsonObject();
                slot.addProperty("slot", i);
                if (!item.isEmpty()) {
                    slot.addProperty("item", item.getItem().toString());
                    slot.addProperty("count", item.getCount());
                    slot.addProperty("display_name", item.getDisplayName().getString());
                } else {
                    slot.addProperty("item", "minecraft:air");
                    slot.addProperty("count", 0);
                }
                mainInventory.add(slot);
            }
            
            // Armor slots (4 slots)
            for (int i = 0; i < 4; i++) {
                ItemStack item = player.getInventory().getArmor(i);
                JsonObject slot = new JsonObject();
                slot.addProperty("slot", i);
                if (!item.isEmpty()) {
                    slot.addProperty("item", item.getItem().toString());
                    slot.addProperty("count", item.getCount());
                    slot.addProperty("display_name", item.getDisplayName().getString());
                } else {
                    slot.addProperty("item", "minecraft:air");
                    slot.addProperty("count", 0);
                }
                armor.add(slot);
            }
            
            // Offhand slot
            ItemStack offhandItem = player.getOffhandItem();
            if (!offhandItem.isEmpty()) {
                offhand.addProperty("item", offhandItem.getItem().toString());
                offhand.addProperty("count", offhandItem.getCount());
                offhand.addProperty("display_name", offhandItem.getDisplayName().getString());
            } else {
                offhand.addProperty("item", "minecraft:air");
                offhand.addProperty("count", 0);
            }
            
            inventory.add("main_inventory", mainInventory);
            inventory.add("armor", armor);
            inventory.add("offhand", offhand);
            inventory.addProperty("last_updated", System.currentTimeMillis());
            
            playerInventories.put(playerUUID, inventory);
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error updating player inventory", e);
        }
    }
    
    /**
     * Add a player event to the queue with size limit
     */
    private void addPlayerEvent(JsonObject event) {
        playerEvents.add(event);
        
        // Maintain size limit
        while (playerEvents.size() > MAX_PLAYER_EVENTS) {
            playerEvents.poll();
        }
    }
    
    /**
     * Invalidate cached data to force refresh
     */
    private void invalidateCache() {
        cachedPlayerData = null;
        lastDataUpdate = 0;
    }
    
    /**
     * Get all player data with caching
     */
    public JsonObject getAllPlayerData() {
        long currentTime = System.currentTimeMillis();
        if (cachedPlayerData != null && (currentTime - lastDataUpdate) < CACHE_DURATION_MS) {
            return cachedPlayerData;
        }
        
        JsonObject data = new JsonObject();
        
        // Online players count
        data.addProperty("online_count", onlinePlayers.size());
        
        // All players
        JsonArray players = new JsonArray();
        for (JsonObject player : playerData.values()) {
            players.add(player);
        }
        data.add("players", players);
        
        // Recent events
        JsonArray events = new JsonArray();
        for (JsonObject event : playerEvents) {
            events.add(event);
        }
        data.add("recent_events", events);
        
        // Player inventories
        JsonObject inventories = new JsonObject();
        for (Map.Entry<String, JsonObject> entry : playerInventories.entrySet()) {
            inventories.add(entry.getKey(), entry.getValue());
        }
        data.add("inventories", inventories);
        
        // Player stats
        JsonObject stats = new JsonObject();
        for (Map.Entry<String, JsonObject> entry : playerStats.entrySet()) {
            stats.add(entry.getKey(), entry.getValue());
        }
        data.add("stats", stats);
        
        data.addProperty("last_updated", currentTime);
        
        cachedPlayerData = data;
        lastDataUpdate = currentTime;
        
        return data;
    }
    
    /**
     * Get detailed player data for a specific player
     */
    public JsonObject getPlayerData(String playerUUID) {
        JsonObject data = new JsonObject();
        
        if (playerData.containsKey(playerUUID)) {
            data.add("player", playerData.get(playerUUID));
        }
        
        if (playerInventories.containsKey(playerUUID)) {
            data.add("inventory", playerInventories.get(playerUUID));
        }
        
        if (playerStats.containsKey(playerUUID)) {
            data.add("stats", playerStats.get(playerUUID));
        }
        
        return data;
    }
    
    /**
     * Get online players list
     */
    public JsonArray getOnlinePlayers() {
        JsonArray online = new JsonArray();
        for (String uuid : onlinePlayers) {
            if (playerData.containsKey(uuid)) {
                online.add(playerData.get(uuid));
            }
        }
        return online;
    }
    
    /**
     * Refresh cached data
     */
    public void refreshData() {
        invalidateCache();
        getAllPlayerData(); // This will rebuild the cache
    }
    
    /**
     * Get current online player count
     */
    public int getOnlinePlayerCount() {
        return onlinePlayers.size();
    }
    
    /**
     * Check if a player is currently online
     */
    public boolean isPlayerOnline(String uuid) {
        return onlinePlayers.contains(uuid);
    }
    
    /**
     * Get list of currently online player UUIDs
     */
    public Set<String> getOnlinePlayerUuids() {
        return new java.util.HashSet<>(onlinePlayers);
    }
}