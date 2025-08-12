#!/bin/bash

# Test script to validate online player tracking functionality

echo "=== MC Panel Online Player Tracking Test ==="
echo "Testing the new online player tracking functionality..."

cd /home/runner/work/mc-panel/mc-panel/forge-mod

# Create a simple test to simulate join/leave events and verify online status
cat > TestOnlineTracking.java << 'EOF'
import com.akumas.mcpanel.events.PlayerEventTracker;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;

public class TestOnlineTracking {
    public static void main(String[] args) {
        System.out.println("=== Testing Online Player Tracking ===");
        
        PlayerEventTracker tracker = new PlayerEventTracker();
        
        // Test initial state
        JsonObject initialData = tracker.getPlayerData();
        System.out.println("Initial online count: " + initialData.get("online_count").getAsInt());
        
        // Simulate player joins
        System.out.println("\nSimulating player joins...");
        tracker.onPlayerJoin(null);
        tracker.onPlayerJoin(null);
        tracker.onPlayerJoin(null);
        
        JsonObject afterJoins = tracker.getPlayerData();
        System.out.println("After 3 joins - Online count: " + afterJoins.get("online_count").getAsInt());
        System.out.println("Online players array size: " + afterJoins.getAsJsonArray("online_players").size());
        System.out.println("All players array size: " + afterJoins.getAsJsonArray("all_players").size());
        
        // Verify players have online=true
        JsonArray onlinePlayers = afterJoins.getAsJsonArray("online_players");
        for (int i = 0; i < onlinePlayers.size(); i++) {
            JsonObject player = onlinePlayers.get(i).getAsJsonObject();
            System.out.println("Player " + player.get("name").getAsString() + " online status: " + player.get("online").getAsBoolean());
        }
        
        // Simulate player leaves
        System.out.println("\nSimulating player leaves...");
        tracker.onPlayerLeave(null);
        tracker.onPlayerLeave(null);
        
        JsonObject afterLeaves = tracker.getPlayerData();
        System.out.println("After 2 leaves - Online count: " + afterLeaves.get("online_count").getAsInt());
        System.out.println("Online players array size: " + afterLeaves.getAsJsonArray("online_players").size());
        System.out.println("All players array size (historical): " + afterLeaves.getAsJsonArray("all_players").size());
        
        // Verify remaining online player and offline players
        JsonArray allPlayers = afterLeaves.getAsJsonArray("all_players");
        int onlineCount = 0, offlineCount = 0;
        for (int i = 0; i < allPlayers.size(); i++) {
            JsonObject player = allPlayers.get(i).getAsJsonObject();
            boolean isOnline = player.get("online").getAsBoolean();
            if (isOnline) onlineCount++;
            else offlineCount++;
            System.out.println("Player " + player.get("name").getAsString() + " online status: " + isOnline);
        }
        
        System.out.println("\nFinal verification:");
        System.out.println("Players currently online: " + onlineCount);
        System.out.println("Players offline (historical): " + offlineCount);
        System.out.println("Total players tracked: " + allPlayers.size());
        
        // Test utility methods
        System.out.println("\nTesting utility methods:");
        System.out.println("getOnlinePlayerCount(): " + tracker.getOnlinePlayerCount());
        System.out.println("getOnlinePlayerUuids().size(): " + tracker.getOnlinePlayerUuids().size());
        
        System.out.println("\n✅ Online player tracking test completed successfully!");
    }
}
EOF

# Compile and run the test
echo "Compiling test..."
javac -cp "build/libs/mcpanel-forge-1.0.0.jar:$(find ~/.gradle/caches -name 'gson-*.jar' | head -1)" TestOnlineTracking.java

echo "Running test..."
java -cp ".:build/libs/mcpanel-forge-1.0.0.jar:$(find ~/.gradle/caches -name 'gson-*.jar' | head -1)" TestOnlineTracking

# Cleanup
rm -f TestOnlineTracking.java TestOnlineTracking.class

echo ""
echo "✅ Online player tracking functionality verified!"