package com.akumas.mcpanel.collectors;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.players.ServerOpList;
import net.minecraft.server.players.UserWhiteList;
import net.minecraft.server.players.UserBanList;
import net.minecraft.server.players.IpBanList;
import net.minecraft.server.players.ServerOpListEntry;
import net.minecraft.server.players.UserWhiteListEntry;
import net.minecraft.server.players.UserBanListEntry;
import net.minecraft.server.players.IpBanListEntry;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.ArrayList;

public class SecurityDataCollector {
    private final MinecraftServer server;
    
    public SecurityDataCollector(MinecraftServer server) {
        this.server = server;
    }
    
    public JsonObject collectData() {
        JsonObject securityData = new JsonObject();
        
        // Operator list
        JsonObject operators = new JsonObject();
        JsonArray opList = new JsonArray();
        
        ServerOpList serverOpList = server.getPlayerList().getOps();
        String[] opNames = serverOpList.getUserList();
        operators.addProperty("count", opNames.length);
        
        for (String opName : opNames) {
            JsonObject op = new JsonObject();
            ServerOpListEntry entry = serverOpList.get(server.getProfileCache().get(opName).orElse(null));
            if (entry != null) {
                op.addProperty("name", opName);
                op.addProperty("level", entry.getLevel());
                op.addProperty("bypass_player_limit", entry.getBypassesPlayerLimit());
            } else {
                op.addProperty("name", opName);
                op.addProperty("level", 4); // Default
                op.addProperty("bypass_player_limit", false);
            }
            opList.add(op);
        }
        operators.add("operators", opList);
        securityData.add("operators", operators);
        
        // Whitelist
        JsonObject whitelist = new JsonObject();
        JsonArray whitelistArray = new JsonArray();
        
        UserWhiteList serverWhitelist = server.getPlayerList().getWhiteList();
        whitelist.addProperty("enabled", server.isEnforceWhitelist());
        
        String[] whitelistedPlayers = serverWhitelist.getUserList();
        whitelist.addProperty("count", whitelistedPlayers.length);
        
        for (String playerName : whitelistedPlayers) {
            JsonObject player = new JsonObject();
            player.addProperty("name", playerName);
            whitelistArray.add(player);
        }
        whitelist.add("players", whitelistArray);
        securityData.add("whitelist", whitelist);
        
        // Banned players
        JsonObject bannedPlayers = new JsonObject();
        JsonArray bannedPlayersArray = new JsonArray();
        
        UserBanList playerBanList = server.getPlayerList().getBans();
        String[] bannedPlayerNames = playerBanList.getUserList();
        bannedPlayers.addProperty("count", bannedPlayerNames.length);
        
        for (String playerName : bannedPlayerNames) {
            JsonObject player = new JsonObject();
            UserBanListEntry banEntry = playerBanList.get(server.getProfileCache().get(playerName).orElse(null));
            if (banEntry != null) {
                player.addProperty("name", playerName);
                player.addProperty("reason", banEntry.getReason());
                player.addProperty("source", banEntry.getSource());
                if (banEntry.getExpires() != null) {
                    player.addProperty("expires", banEntry.getExpires().toString());
                }
                player.addProperty("created", banEntry.getCreated().toString());
            } else {
                player.addProperty("name", playerName);
            }
            bannedPlayersArray.add(player);
        }
        bannedPlayers.add("players", bannedPlayersArray);
        securityData.add("banned_players", bannedPlayers);
        
        // Banned IPs
        JsonObject bannedIps = new JsonObject();
        JsonArray bannedIpsArray = new JsonArray();
        
        IpBanList ipBanList = server.getPlayerList().getIpBans();
        String[] bannedIpAddresses = ipBanList.getUserList();
        bannedIps.addProperty("count", bannedIpAddresses.length);
        
        for (String ipAddress : bannedIpAddresses) {
            JsonObject ip = new JsonObject();
            IpBanListEntry banEntry = ipBanList.get(ipAddress);
            if (banEntry != null) {
                ip.addProperty("ip", ipAddress);
                ip.addProperty("reason", banEntry.getReason());
                ip.addProperty("source", banEntry.getSource());
                if (banEntry.getExpires() != null) {
                    ip.addProperty("expires", banEntry.getExpires().toString());
                }
                ip.addProperty("created", banEntry.getCreated().toString());
            } else {
                ip.addProperty("ip", ipAddress);
            }
            bannedIpsArray.add(ip);
        }
        bannedIps.add("ips", bannedIpsArray);
        securityData.add("banned_ips", bannedIps);
        
        // Server properties security settings
        JsonObject serverSecurity = new JsonObject();
        serverSecurity.addProperty("enforce_whitelist", server.isEnforceWhitelist());
        serverSecurity.addProperty("online_mode", server.usesAuthentication());
        serverSecurity.addProperty("prevent_proxy_connections", server.isPreventProxyConnections());
        serverSecurity.addProperty("max_players", server.getMaxPlayers());
        
        securityData.add("server_security", serverSecurity);
        
        // Recent crashes (check for crash reports)
        JsonObject crashes = new JsonObject();
        JsonArray crashList = new JsonArray();
        
        try {
            Path crashReportsDir = Paths.get("crash-reports");
            if (Files.exists(crashReportsDir) && Files.isDirectory(crashReportsDir)) {
                List<Path> crashFiles = new ArrayList<>();
                Files.list(crashReportsDir)
                    .filter(Files::isRegularFile)
                    .filter(path -> path.toString().endsWith(".txt"))
                    .sorted((a, b) -> {
                        try {
                            return Files.getLastModifiedTime(b).compareTo(Files.getLastModifiedTime(a));
                        } catch (Exception e) {
                            return 0;
                        }
                    })
                    .limit(10) // Last 10 crashes
                    .forEach(crashFiles::add);
                
                for (Path crashFile : crashFiles) {
                    JsonObject crash = new JsonObject();
                    crash.addProperty("file", crashFile.getFileName().toString());
                    crash.addProperty("size", Files.size(crashFile));
                    crash.addProperty("last_modified", Files.getLastModifiedTime(crashFile).toString());
                    crashList.add(crash);
                }
            }
        } catch (Exception e) {
            JsonObject error = new JsonObject();
            error.addProperty("error", "Could not read crash reports: " + e.getMessage());
            crashList.add(error);
        }
        
        crashes.addProperty("count", crashList.size());
        crashes.add("recent_crashes", crashList);
        securityData.add("crashes", crashes);
        
        return securityData;
    }
}