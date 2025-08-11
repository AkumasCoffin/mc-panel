package com.akumas.mcpanel.collectors;

import net.minecraft.server.MinecraftServer;
import net.minecraft.world.scores.Scoreboard;
import net.minecraft.world.scores.Objective;
import net.minecraft.world.scores.PlayerTeam;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.ServerScoreboard;
import net.minecraft.advancements.Advancement;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.server.players.PlayerList;
import net.minecraft.server.ServerAdvancementManager;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Properties;
import java.util.Collection;
import java.util.Map;

public class MiscDataCollector {
    private final MinecraftServer server;
    
    public MiscDataCollector(MinecraftServer server) {
        this.server = server;
    }
    
    public JsonObject collectData() {
        JsonObject miscData = new JsonObject();
        
        // Server properties
        JsonObject serverProperties = collectServerProperties();
        miscData.add("server_properties", serverProperties);
        
        // Scoreboards and objectives
        JsonObject scoreboards = collectScoreboardData();
        miscData.add("scoreboards", scoreboards);
        
        // Advancement progress
        JsonObject advancements = collectAdvancementData();
        miscData.add("advancements", advancements);
        
        // World/dimension info
        JsonObject dimensions = collectDimensionInfo();
        miscData.add("dimensions", dimensions);
        
        // File system info
        JsonObject filesystem = collectFilesystemInfo();
        miscData.add("filesystem", filesystem);
        
        return miscData;
    }
    
    private JsonObject collectServerProperties() {
        JsonObject properties = new JsonObject();
        
        try {
            File serverPropsFile = new File("server.properties");
            if (serverPropsFile.exists()) {
                Properties props = new Properties();
                try (FileInputStream fis = new FileInputStream(serverPropsFile)) {
                    props.load(fis);
                    
                    // Convert important properties to JSON
                    properties.addProperty("server_port", props.getProperty("server-port", "25565"));
                    properties.addProperty("server_ip", props.getProperty("server-ip", ""));
                    properties.addProperty("level_name", props.getProperty("level-name", "world"));
                    properties.addProperty("level_seed", props.getProperty("level-seed", ""));
                    properties.addProperty("level_type", props.getProperty("level-type", "minecraft:normal"));
                    properties.addProperty("gamemode", props.getProperty("gamemode", "survival"));
                    properties.addProperty("difficulty", props.getProperty("difficulty", "easy"));
                    properties.addProperty("hardcore", props.getProperty("hardcore", "false"));
                    properties.addProperty("max_players", props.getProperty("max-players", "20"));
                    properties.addProperty("online_mode", props.getProperty("online-mode", "true"));
                    properties.addProperty("white_list", props.getProperty("white-list", "false"));
                    properties.addProperty("motd", props.getProperty("motd", "A Minecraft Server"));
                    properties.addProperty("enable_command_block", props.getProperty("enable-command-block", "false"));
                    properties.addProperty("spawn_protection", props.getProperty("spawn-protection", "16"));
                    properties.addProperty("max_world_size", props.getProperty("max-world-size", "29999984"));
                    properties.addProperty("view_distance", props.getProperty("view-distance", "10"));
                    properties.addProperty("simulation_distance", props.getProperty("simulation-distance", "10"));
                    properties.addProperty("spawn_monsters", props.getProperty("spawn-monsters", "true"));
                    properties.addProperty("spawn_animals", props.getProperty("spawn-animals", "true"));
                    properties.addProperty("spawn_npcs", props.getProperty("spawn-npcs", "true"));
                    properties.addProperty("pvp", props.getProperty("pvp", "true"));
                    properties.addProperty("generate_structures", props.getProperty("generate-structures", "true"));
                    properties.addProperty("enforce_whitelist", props.getProperty("enforce-whitelist", "false"));
                }
            }
        } catch (IOException e) {
            properties.addProperty("error", "Could not read server.properties: " + e.getMessage());
        }
        
        return properties;
    }
    
    private JsonObject collectScoreboardData() {
        JsonObject scoreboardData = new JsonObject();
        
        try {
            ServerScoreboard scoreboard = server.getScoreboard();
            
            // Objectives
            JsonArray objectives = new JsonArray();
            Collection<Objective> objectiveCollection = scoreboard.getObjectives();
            
            for (Objective objective : objectiveCollection) {
                JsonObject obj = new JsonObject();
                obj.addProperty("name", objective.getName());
                obj.addProperty("display_name", objective.getDisplayName().getString());
                obj.addProperty("criteria", objective.getCriteria().getName());
                obj.addProperty("render_type", objective.getRenderType().toString());
                objectives.add(obj);
            }
            scoreboardData.add("objectives", objectives);
            scoreboardData.addProperty("objective_count", objectives.size());
            
            // Teams
            JsonArray teams = new JsonArray();
            Collection<PlayerTeam> teamCollection = scoreboard.getPlayerTeams();
            
            for (PlayerTeam team : teamCollection) {
                JsonObject teamObj = new JsonObject();
                teamObj.addProperty("name", team.getName());
                teamObj.addProperty("display_name", team.getDisplayName().getString());
                teamObj.addProperty("color", team.getColor().toString());
                teamObj.addProperty("allow_friendly_fire", team.isAllowFriendlyFire());
                teamObj.addProperty("can_see_friendly_invisibles", team.canSeeFriendlyInvisibles());
                teamObj.addProperty("collision_rule", team.getCollisionRule().toString());
                teamObj.addProperty("death_message_visibility", team.getDeathMessageVisibility().toString());
                teamObj.addProperty("name_tag_visibility", team.getNameTagVisibility().toString());
                
                // Team members
                JsonArray members = new JsonArray();
                for (String member : team.getPlayers()) {
                    members.add(member);
                }
                teamObj.add("members", members);
                teamObj.addProperty("member_count", members.size());
                
                teams.add(teamObj);
            }
            scoreboardData.add("teams", teams);
            scoreboardData.addProperty("team_count", teams.size());
            
        } catch (Exception e) {
            scoreboardData.addProperty("error", "Could not collect scoreboard data: " + e.getMessage());
        }
        
        return scoreboardData;
    }
    
    private JsonObject collectAdvancementData() {
        JsonObject advancementData = new JsonObject();
        
        try {
            ServerAdvancementManager advancementManager = server.getAdvancements();
            Collection<Advancement> advancements = advancementManager.getAllAdvancements();
            
            advancementData.addProperty("total_advancements", advancements.size());
            
            // Per-player advancement progress
            JsonArray playerProgress = new JsonArray();
            PlayerList playerList = server.getPlayerList();
            
            for (ServerPlayer player : playerList.getPlayers()) {
                JsonObject playerAdv = new JsonObject();
                playerAdv.addProperty("player", player.getName().getString());
                
                int completedAdvancements = 0;
                int totalCriteria = 0;
                int completedCriteria = 0;
                
                for (Advancement advancement : advancements) {
                    AdvancementProgress progress = player.getAdvancements().getOrStartProgress(advancement);
                    if (progress.isDone()) {
                        completedAdvancements++;
                    }
                    
                    for (String criterion : advancement.getCriteria().keySet()) {
                        totalCriteria++;
                        if (progress.isDone(criterion)) {
                            completedCriteria++;
                        }
                    }
                }
                
                playerAdv.addProperty("completed_advancements", completedAdvancements);
                playerAdv.addProperty("total_criteria", totalCriteria);
                playerAdv.addProperty("completed_criteria", completedCriteria);
                playerAdv.addProperty("completion_percentage", 
                    totalCriteria > 0 ? (double) completedCriteria / totalCriteria * 100.0 : 0.0);
                
                playerProgress.add(playerAdv);
            }
            
            advancementData.add("player_progress", playerProgress);
            
        } catch (Exception e) {
            advancementData.addProperty("error", "Could not collect advancement data: " + e.getMessage());
        }
        
        return advancementData;
    }
    
    private JsonObject collectDimensionInfo() {
        JsonObject dimensionData = new JsonObject();
        
        try {
            JsonArray dimensions = new JsonArray();
            
            server.getAllLevels().forEach(level -> {
                JsonObject dim = new JsonObject();
                dim.addProperty("name", level.dimension().location().toString());
                dim.addProperty("seed", level.getSeed());
                
                // World border info
                JsonObject border = new JsonObject();
                border.addProperty("size", level.getWorldBorder().getSize());
                border.addProperty("center_x", level.getWorldBorder().getCenterX());
                border.addProperty("center_z", level.getWorldBorder().getCenterZ());
                dim.add("world_border", border);
                
                dimensions.add(dim);
            });
            
            dimensionData.add("dimensions", dimensions);
            dimensionData.addProperty("dimension_count", dimensions.size());
            
        } catch (Exception e) {
            dimensionData.addProperty("error", "Could not collect dimension data: " + e.getMessage());
        }
        
        return dimensionData;
    }
    
    private JsonObject collectFilesystemInfo() {
        JsonObject fsData = new JsonObject();
        
        try {
            // World size information
            JsonObject worldSizes = new JsonObject();
            
            // Calculate world directory sizes
            calculateDirectorySize("world", worldSizes);
            calculateDirectorySize("world_nether", worldSizes);
            calculateDirectorySize("world_the_end", worldSizes);
            
            fsData.add("world_sizes", worldSizes);
            
            // Log files info
            JsonObject logs = new JsonObject();
            Path logsDir = Paths.get("logs");
            if (Files.exists(logsDir) && Files.isDirectory(logsDir)) {
                long totalLogSize = Files.walk(logsDir)
                    .filter(Files::isRegularFile)
                    .mapToLong(path -> {
                        try {
                            return Files.size(path);
                        } catch (IOException e) {
                            return 0;
                        }
                    })
                    .sum();
                
                logs.addProperty("total_size_bytes", totalLogSize);
                logs.addProperty("total_size_mb", totalLogSize / (1024.0 * 1024.0));
            }
            fsData.add("logs", logs);
            
        } catch (Exception e) {
            fsData.addProperty("error", "Could not collect filesystem data: " + e.getMessage());
        }
        
        return fsData;
    }
    
    private void calculateDirectorySize(String dirName, JsonObject worldSizes) {
        try {
            Path dirPath = Paths.get(dirName);
            if (Files.exists(dirPath) && Files.isDirectory(dirPath)) {
                long size = Files.walk(dirPath)
                    .filter(Files::isRegularFile)
                    .mapToLong(path -> {
                        try {
                            return Files.size(path);
                        } catch (IOException e) {
                            return 0;
                        }
                    })
                    .sum();
                
                JsonObject dirInfo = new JsonObject();
                dirInfo.addProperty("size_bytes", size);
                dirInfo.addProperty("size_mb", size / (1024.0 * 1024.0));
                dirInfo.addProperty("size_gb", size / (1024.0 * 1024.0 * 1024.0));
                worldSizes.add(dirName, dirInfo);
            }
        } catch (Exception e) {
            JsonObject error = new JsonObject();
            error.addProperty("error", "Could not calculate size: " + e.getMessage());
            worldSizes.add(dirName, error);
        }
    }
}