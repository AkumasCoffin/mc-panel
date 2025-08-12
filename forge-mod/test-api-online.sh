#!/bin/bash

# Test script to verify the API returns correct online player data

echo "=== MC Panel API Online Player Test ==="
echo "Testing that the /api/players endpoint shows correct online status..."

cd /home/runner/work/mc-panel/mc-panel/forge-mod

# Start server in background and test the endpoint with simulated players
java -cp "build/libs/mcpanel-forge-1.0.0.jar:$(find ~/.gradle/caches -name 'gson-*.jar' | head -1):$(find ~/.gradle/caches -name 'log4j-*.jar' | head -1):$(find ~/.gradle/caches -name 'commons-lang3-*.jar' | head -1)" com.akumas.mcpanel.TestApp &
SERVER_PID=$!

# Wait for server to start
echo "Starting server..."
sleep 3

echo -e "\n1. Testing initial state (should show 0 online players)"
curl -s http://localhost:25580/api/players | jq '.online_count, .players | length, .all_players | length'

echo -e "\n2. Manually adding simulated players via TestClient..."
# The TestClient should trigger some joins
java -cp "build/libs/mcpanel-forge-1.0.0.jar:$(find ~/.gradle/caches -name 'gson-*.jar' | head -1)" com.akumas.mcpanel.TestClient &
CLIENT_PID=$!

sleep 2

echo -e "\n3. Testing after simulated activity"
RESPONSE=$(curl -s http://localhost:25580/api/players)
echo "Response:"
echo "$RESPONSE" | jq '.'

echo -e "\n4. Extracting key data:"
echo "Online count: $(echo "$RESPONSE" | jq '.online_count')"
echo "Players array length: $(echo "$RESPONSE" | jq '.players | length')"
echo "All players array length: $(echo "$RESPONSE" | jq '.all_players | length // 0')"

if echo "$RESPONSE" | jq '.players[]?' > /dev/null 2>&1; then
    echo -e "\n5. Player online status:"
    echo "$RESPONSE" | jq '.players[] | "\(.name): online=\(.online)"'
fi

# Cleanup
echo -e "\nStopping servers..."
kill $SERVER_PID 2>/dev/null
kill $CLIENT_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
wait $CLIENT_PID 2>/dev/null

echo "✅ API online player test completed!"