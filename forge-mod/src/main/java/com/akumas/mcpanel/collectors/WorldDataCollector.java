package com.akumas.mcpanel.collectors;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.GameRules;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;

import java.util.Map;
import java.util.HashMap;

public class WorldDataCollector {
    private final MinecraftServer server;
    
    public WorldDataCollector(MinecraftServer server) {
        this.server = server;
    }
    
    public JsonObject collectData() {
        JsonObject worldData = new JsonObject();
        JsonArray worldsArray = new JsonArray();
        
        // Iterate through all dimensions
        for (ServerLevel level : server.getAllLevels()) {
            JsonObject worldInfo = new JsonObject();
            
            // Basic world info
            String dimensionName = level.dimension().location().toString();
            worldInfo.addProperty("dimension", dimensionName);
            worldInfo.addProperty("seed", level.getSeed());
            
            // Time and weather
            worldInfo.addProperty("time", level.getDayTime());
            worldInfo.addProperty("game_time", level.getGameTime());
            worldInfo.addProperty("is_day", level.isDay());
            worldInfo.addProperty("is_raining", level.isRaining());
            worldInfo.addProperty("is_thundering", level.isThundering());
            worldInfo.addProperty("rain_level", level.getRainLevel(1.0f));
            worldInfo.addProperty("thunder_level", level.getThunderLevel(1.0f));
            
            // World border
            JsonObject border = new JsonObject();
            border.addProperty("center_x", level.getWorldBorder().getCenterX());
            border.addProperty("center_z", level.getWorldBorder().getCenterZ());
            border.addProperty("size", level.getWorldBorder().getSize());
            border.addProperty("damage_amount", level.getWorldBorder().getDamageAmount());
            border.addProperty("damage_buffer", level.getWorldBorder().getDamageSafeZone());
            worldInfo.add("world_border", border);
            
            // Spawn point
            JsonObject spawn = new JsonObject();
            BlockPos spawnPos = level.getSharedSpawnPos();
            spawn.addProperty("x", spawnPos.getX());
            spawn.addProperty("y", spawnPos.getY());
            spawn.addProperty("z", spawnPos.getZ());
            spawn.addProperty("angle", level.getSharedSpawnAngle());
            worldInfo.add("spawn", spawn);
            
            // Chunk statistics
            JsonObject chunks = new JsonObject();
            int loadedChunks = 0;
            int forcedChunks = 0;
            
            try {
                // Count loaded chunks
                loadedChunks = level.getChunkSource().getLoadedChunksCount();
                // Force loaded chunks would require more complex iteration
                forcedChunks = level.getForcedChunks().size();
            } catch (Exception e) {
                // Fallback if direct access fails
            }
            
            chunks.addProperty("loaded", loadedChunks);
            chunks.addProperty("forced", forcedChunks);
            worldInfo.add("chunks", chunks);
            
            // Entity statistics
            JsonObject entities = new JsonObject();
            Map<String, Integer> entityCounts = new HashMap<>();
            int totalEntities = 0;
            
            for (Entity entity : level.getAllEntities()) {
                totalEntities++;
                String entityType = entity.getType().toString();
                entityCounts.put(entityType, entityCounts.getOrDefault(entityType, 0) + 1);
            }
            
            entities.addProperty("total", totalEntities);
            JsonObject entityTypes = new JsonObject();
            for (Map.Entry<String, Integer> entry : entityCounts.entrySet()) {
                entityTypes.addProperty(entry.getKey(), entry.getValue());
            }
            entities.add("types", entityTypes);
            worldInfo.add("entities", entities);
            
            // Block entities (tile entities)
            JsonObject blockEntities = new JsonObject();
            Map<String, Integer> blockEntityCounts = new HashMap<>();
            int totalBlockEntities = 0;
            
            // This is a simplified count - in practice you'd iterate through loaded chunks
            // For now, we'll provide a basic count
            blockEntities.addProperty("total", totalBlockEntities);
            JsonObject blockEntityTypes = new JsonObject();
            for (Map.Entry<String, Integer> entry : blockEntityCounts.entrySet()) {
                blockEntityTypes.addProperty(entry.getKey(), entry.getValue());
            }
            blockEntities.add("types", blockEntityTypes);
            worldInfo.add("block_entities", blockEntities);
            
            // Difficulty
            worldInfo.addProperty("difficulty", level.getDifficulty().toString());
            worldInfo.addProperty("difficulty_locked", level.getLevelData().isDifficultyLocked());
            
            worldsArray.add(worldInfo);
        }
        
        worldData.add("worlds", worldsArray);
        
        // Game rules (global server settings)
        JsonObject gameRules = new JsonObject();
        GameRules rules = server.getGameRules();
        
        // Common game rules
        gameRules.addProperty("doFireTick", rules.getBoolean(GameRules.RULE_DOFIRETICK));
        gameRules.addProperty("mobGriefing", rules.getBoolean(GameRules.RULE_MOBGRIEFING));
        gameRules.addProperty("keepInventory", rules.getBoolean(GameRules.RULE_KEEPINVENTORY));
        gameRules.addProperty("doMobSpawning", rules.getBoolean(GameRules.RULE_DOMOBSPAWNING));
        gameRules.addProperty("doMobLoot", rules.getBoolean(GameRules.RULE_DOMOBLOOT));
        gameRules.addProperty("doTileDrops", rules.getBoolean(GameRules.RULE_DOBLOCKDROPS));
        gameRules.addProperty("commandBlockOutput", rules.getBoolean(GameRules.RULE_COMMANDBLOCKOUTPUT));
        gameRules.addProperty("naturalRegeneration", rules.getBoolean(GameRules.RULE_NATURAL_REGENERATION));
        gameRules.addProperty("doDaylightCycle", rules.getBoolean(GameRules.RULE_DAYLIGHT));
        gameRules.addProperty("logAdminCommands", rules.getBoolean(GameRules.RULE_LOGADMINCOMMANDS));
        gameRules.addProperty("showDeathMessages", rules.getBoolean(GameRules.RULE_SHOWDEATHMESSAGES));
        gameRules.addProperty("randomTickSpeed", rules.getInt(GameRules.RULE_RANDOMTICKING));
        gameRules.addProperty("sendCommandFeedback", rules.getBoolean(GameRules.RULE_SENDCOMMANDFEEDBACK));
        gameRules.addProperty("reducedDebugInfo", rules.getBoolean(GameRules.RULE_REDUCEDDEBUGINFO));
        gameRules.addProperty("spectatorGenerateChunks", rules.getBoolean(GameRules.RULE_SPECTATORSGENERATECHUNKS));
        gameRules.addProperty("spawnRadius", rules.getInt(GameRules.RULE_SPAWN_RADIUS));
        gameRules.addProperty("disableElytraMovementCheck", rules.getBoolean(GameRules.RULE_DISABLE_ELYTRA_MOVEMENT_CHECK));
        gameRules.addProperty("maxEntityCramming", rules.getInt(GameRules.RULE_MAX_ENTITY_CRAMMING));
        gameRules.addProperty("doWeatherCycle", rules.getBoolean(GameRules.RULE_WEATHER_CYCLE));
        gameRules.addProperty("doLimitedCrafting", rules.getBoolean(GameRules.RULE_LIMITED_CRAFTING));
        gameRules.addProperty("maxCommandChainLength", rules.getInt(GameRules.RULE_MAX_COMMAND_CHAIN_LENGTH));
        gameRules.addProperty("announceAdvancements", rules.getBoolean(GameRules.RULE_ANNOUNCE_ADVANCEMENTS));
        gameRules.addProperty("disableRaids", rules.getBoolean(GameRules.RULE_DISABLE_RAIDS));
        gameRules.addProperty("doInsomnia", rules.getBoolean(GameRules.RULE_DOINSOMNIA));
        gameRules.addProperty("drowningDamage", rules.getBoolean(GameRules.RULE_DROWNING_DAMAGE));
        gameRules.addProperty("fallDamage", rules.getBoolean(GameRules.RULE_FALL_DAMAGE));
        gameRules.addProperty("fireDamage", rules.getBoolean(GameRules.RULE_FIRE_DAMAGE));
        gameRules.addProperty("freezeDamage", rules.getBoolean(GameRules.RULE_FREEZE_DAMAGE));
        gameRules.addProperty("doPatrolSpawning", rules.getBoolean(GameRules.RULE_DO_PATROL_SPAWNING));
        gameRules.addProperty("doTraderSpawning", rules.getBoolean(GameRules.RULE_DO_TRADER_SPAWNING));
        gameRules.addProperty("doWardenSpawning", rules.getBoolean(GameRules.RULE_DO_WARDEN_SPAWNING));
        gameRules.addProperty("forgiveDeadPlayers", rules.getBoolean(GameRules.RULE_FORGIVE_DEAD_PLAYERS));
        gameRules.addProperty("universalAnger", rules.getBoolean(GameRules.RULE_UNIVERSAL_ANGER));
        
        worldData.add("game_rules", gameRules);
        
        return worldData;
    }
}