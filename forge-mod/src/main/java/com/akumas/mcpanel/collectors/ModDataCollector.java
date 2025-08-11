package com.akumas.mcpanel.collectors;

import net.minecraft.server.MinecraftServer;
import net.minecraftforge.fml.ModContainer;
import net.minecraftforge.fml.ModList;
import net.minecraftforge.forgespi.language.IModInfo;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;

import java.util.List;

public class ModDataCollector {
    private final MinecraftServer server;
    
    public ModDataCollector(MinecraftServer server) {
        this.server = server;
    }
    
    public JsonObject collectData() {
        JsonObject modData = new JsonObject();
        JsonArray modsArray = new JsonArray();
        
        // Get all loaded mods
        ModList modList = ModList.get();
        List<ModContainer> mods = modList.getAllMods();
        
        modData.addProperty("total_mods", mods.size());
        
        for (ModContainer mod : mods) {
            JsonObject modInfo = new JsonObject();
            IModInfo info = mod.getModInfo();
            
            modInfo.addProperty("mod_id", info.getModId());
            modInfo.addProperty("display_name", info.getDisplayName());
            modInfo.addProperty("version", info.getVersion().toString());
            modInfo.addProperty("description", info.getDescription());
            
            // Authors
            if (info.getOwningFile() != null && info.getOwningFile().getMods() != null) {
                JsonArray authors = new JsonArray();
                // Note: Getting authors might require different approach depending on mod info structure
                authors.add("Unknown"); // Placeholder
                modInfo.add("authors", authors);
            }
            
            // Dependencies
            JsonArray dependencies = new JsonArray();
            info.getDependencies().forEach(dep -> {
                JsonObject dependency = new JsonObject();
                dependency.addProperty("mod_id", dep.getModId());
                dependency.addProperty("type", dep.getType().toString());
                dependency.addProperty("version_range", dep.getVersionRange().toString());
                dependency.addProperty("ordering", dep.getOrdering().toString());
                dependency.addProperty("side", dep.getSide().toString());
                dependencies.add(dependency);
            });
            modInfo.add("dependencies", dependencies);
            
            // Mod file info
            if (info.getOwningFile() != null) {
                JsonObject fileInfo = new JsonObject();
                fileInfo.addProperty("file_name", info.getOwningFile().getFileName());
                modInfo.add("file_info", fileInfo);
            }
            
            // Logo and config URLs if available
            if (info.getLogoFile().isPresent()) {
                modInfo.addProperty("logo_file", info.getLogoFile().get());
            }
            
            if (info.getConfig().get("displayURL") != null) {
                modInfo.addProperty("display_url", info.getConfig().get("displayURL").toString());
            }
            
            if (info.getConfig().get("updateJSONURL") != null) {
                modInfo.addProperty("update_url", info.getConfig().get("updateJSONURL").toString());
            }
            
            modsArray.add(modInfo);
        }
        
        modData.add("mods", modsArray);
        
        // Forge version information
        JsonObject forgeInfo = new JsonObject();
        try {
            // Get Forge version
            ModContainer forgeMod = modList.getModContainerById("forge").orElse(null);
            if (forgeMod != null) {
                forgeInfo.addProperty("version", forgeMod.getModInfo().getVersion().toString());
            }
            
            // Minecraft version
            ModContainer minecraftMod = modList.getModContainerById("minecraft").orElse(null);
            if (minecraftMod != null) {
                forgeInfo.addProperty("minecraft_version", minecraftMod.getModInfo().getVersion().toString());
            }
            
        } catch (Exception e) {
            forgeInfo.addProperty("error", "Could not retrieve Forge info: " + e.getMessage());
        }
        
        modData.add("forge_info", forgeInfo);
        
        return modData;
    }
}