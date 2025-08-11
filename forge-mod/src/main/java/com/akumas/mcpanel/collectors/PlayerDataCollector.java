package com.akumas.mcpanel.collectors;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.stats.Stats;
import net.minecraft.stats.Stat;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.core.Holder;
import net.minecraft.advancements.Advancement;
import net.minecraft.advancements.AdvancementProgress;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;

import java.util.List;
import java.util.Collection;

public class PlayerDataCollector {
    private final MinecraftServer server;
    
    public PlayerDataCollector(MinecraftServer server) {
        this.server = server;
    }
    
    public JsonObject collectData() {
        JsonObject playerData = new JsonObject();
        JsonArray playersArray = new JsonArray();
        
        List<ServerPlayer> players = server.getPlayerList().getPlayers();
        playerData.addProperty("online_count", players.size());
        playerData.addProperty("max_players", server.getMaxPlayers());
        
        for (ServerPlayer player : players) {
            JsonObject playerInfo = new JsonObject();
            
            // Basic player info
            playerInfo.addProperty("name", player.getName().getString());
            playerInfo.addProperty("uuid", player.getUUID().toString());
            playerInfo.addProperty("display_name", player.getDisplayName().getString());
            
            // Location data
            JsonObject location = new JsonObject();
            BlockPos pos = player.blockPosition();
            location.addProperty("x", pos.getX());
            location.addProperty("y", pos.getY());
            location.addProperty("z", pos.getZ());
            location.addProperty("dimension", player.level().dimension().location().toString());
            
            // Get biome information
            try {
                Holder<Biome> biomeHolder = player.level().getBiome(pos);
                String biomeName = biomeHolder.unwrapKey()
                    .map(key -> key.location().toString())
                    .orElse("unknown");
                location.addProperty("biome", biomeName);
            } catch (Exception e) {
                location.addProperty("biome", "unknown");
            }
            
            playerInfo.add("location", location);
            
            // Health and status
            JsonObject status = new JsonObject();
            status.addProperty("health", player.getHealth());
            status.addProperty("max_health", player.getMaxHealth());
            status.addProperty("food_level", player.getFoodData().getFoodLevel());
            status.addProperty("saturation", player.getFoodData().getSaturationLevel());
            status.addProperty("experience_level", player.experienceLevel);
            status.addProperty("experience_points", player.totalExperience);
            status.addProperty("game_mode", player.gameMode.getGameModeForPlayer().getName());
            
            // Check if player is afk (no movement in last 5 minutes as approximation)
            long lastActionTime = player.getLastActionTime();
            long currentTime = System.currentTimeMillis();
            boolean isAfk = (currentTime - lastActionTime) > 300000; // 5 minutes
            status.addProperty("afk", isAfk);
            status.addProperty("last_action_time", lastActionTime);
            
            // Connection info
            status.addProperty("ping", player.connection.latency);
            status.addProperty("ip_address", player.connection.getRemoteAddress().toString());
            
            playerInfo.add("status", status);
            
            // Potion effects
            JsonArray effects = new JsonArray();
            Collection<MobEffectInstance> activeEffects = player.getActiveEffects();
            for (MobEffectInstance effect : activeEffects) {
                JsonObject effectInfo = new JsonObject();
                effectInfo.addProperty("name", effect.getEffect().getDescriptionId());
                effectInfo.addProperty("amplifier", effect.getAmplifier());
                effectInfo.addProperty("duration", effect.getDuration());
                effectInfo.addProperty("ambient", effect.isAmbient());
                effectInfo.addProperty("visible", effect.isVisible());
                effects.add(effectInfo);
            }
            playerInfo.add("effects", effects);
            
            // Inventory data
            JsonObject inventory = new JsonObject();
            JsonArray items = new JsonArray();
            
            // Main inventory
            for (int i = 0; i < player.getInventory().getContainerSize(); i++) {
                ItemStack stack = player.getInventory().getItem(i);
                if (!stack.isEmpty()) {
                    JsonObject item = new JsonObject();
                    item.addProperty("slot", i);
                    item.addProperty("item", stack.getItem().toString());
                    item.addProperty("count", stack.getCount());
                    item.addProperty("display_name", stack.getDisplayName().getString());
                    if (stack.hasTag()) {
                        item.addProperty("nbt", stack.getTag().toString());
                    }
                    items.add(item);
                }
            }
            inventory.add("items", items);
            
            // Armor
            JsonArray armor = new JsonArray();
            for (int i = 0; i < player.getInventory().armor.size(); i++) {
                ItemStack stack = player.getInventory().armor.get(i);
                if (!stack.isEmpty()) {
                    JsonObject armorPiece = new JsonObject();
                    armorPiece.addProperty("slot", i);
                    armorPiece.addProperty("item", stack.getItem().toString());
                    armorPiece.addProperty("count", stack.getCount());
                    armorPiece.addProperty("display_name", stack.getDisplayName().getString());
                    if (stack.hasTag()) {
                        armorPiece.addProperty("nbt", stack.getTag().toString());
                    }
                    armor.add(armorPiece);
                }
            }
            inventory.add("armor", armor);
            
            // Offhand
            ItemStack offhand = player.getOffhandItem();
            if (!offhand.isEmpty()) {
                JsonObject offhandItem = new JsonObject();
                offhandItem.addProperty("item", offhand.getItem().toString());
                offhandItem.addProperty("count", offhand.getCount());
                offhandItem.addProperty("display_name", offhand.getDisplayName().getString());
                if (offhand.hasTag()) {
                    offhandItem.addProperty("nbt", offhand.getTag().toString());
                }
                inventory.add("offhand", offhandItem);
            }
            
            playerInfo.add("inventory", inventory);
            
            // Statistics (sample of important ones)
            JsonObject statistics = new JsonObject();
            try {
                statistics.addProperty("deaths", player.getStats().getValue(Stats.CUSTOM.get(Stats.DEATHS)));
                statistics.addProperty("player_kills", player.getStats().getValue(Stats.CUSTOM.get(Stats.PLAYER_KILLS)));
                statistics.addProperty("mob_kills", player.getStats().getValue(Stats.CUSTOM.get(Stats.MOB_KILLS)));
                statistics.addProperty("damage_dealt", player.getStats().getValue(Stats.CUSTOM.get(Stats.DAMAGE_DEALT)));
                statistics.addProperty("damage_taken", player.getStats().getValue(Stats.CUSTOM.get(Stats.DAMAGE_TAKEN)));
                statistics.addProperty("time_played", player.getStats().getValue(Stats.CUSTOM.get(Stats.PLAY_TIME)));
                statistics.addProperty("distance_walked", player.getStats().getValue(Stats.CUSTOM.get(Stats.WALK_ONE_CM)));
                statistics.addProperty("distance_sprinted", player.getStats().getValue(Stats.CUSTOM.get(Stats.SPRINT_ONE_CM)));
                statistics.addProperty("distance_flown", player.getStats().getValue(Stats.CUSTOM.get(Stats.FLY_ONE_CM)));
                statistics.addProperty("jumps", player.getStats().getValue(Stats.CUSTOM.get(Stats.JUMP)));
            } catch (Exception e) {
                // Some stats might not be available
            }
            playerInfo.add("statistics", statistics);
            
            // Advancements count - count completed advancements
            int advancementCount = 0;
            try {
                // Get all advancements and count completed ones
                for (Advancement advancement : player.getServer().getAdvancements().getAllAdvancements()) {
                    AdvancementProgress progress = player.getAdvancements().getOrStartProgress(advancement);
                    if (progress.isDone()) {
                        advancementCount++;
                    }
                }
            } catch (Exception e) {
                // Fallback: just set to 0 if we can't get advancement count
                advancementCount = 0;
            }
            playerInfo.addProperty("advancement_count", advancementCount);
            
            playersArray.add(playerInfo);
        }
        
        playerData.add("players", playersArray);
        return playerData;
    }
}