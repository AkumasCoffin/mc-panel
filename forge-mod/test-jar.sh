#!/bin/bash

# Test script to validate the mcpanel-forge JAR
# This script checks that the JAR doesn't contain any conflicting classes

JAR_FILE="build/libs/mcpanel-forge-1.0.0.jar"

echo "=== MC Panel Forge JAR Validation Test ==="
echo "Testing JAR: $JAR_FILE"
echo

# Check if JAR exists
if [ ! -f "$JAR_FILE" ]; then
    echo "❌ FAIL: JAR file not found: $JAR_FILE"
    exit 1
fi

echo "✅ JAR file exists"

# Check JAR contents - should NOT contain any net.minecraftforge classes
echo "Checking for problematic Forge classes..."
if jar tf "$JAR_FILE" | grep -q "net/minecraftforge/"; then
    echo "❌ FAIL: JAR contains Forge classes that should not be packaged:"
    jar tf "$JAR_FILE" | grep "net/minecraftforge/"
    exit 1
fi

echo "✅ No conflicting Forge classes found"

# Check that our mod classes are present
echo "Checking for required mod classes..."
REQUIRED_CLASSES=(
    "com/akumas/mcpanel/MCPanelMod.class"
    "com/akumas/mcpanel/MCPanelForgeIntegration.class"
    "META-INF/mods.toml"
)

for class_file in "${REQUIRED_CLASSES[@]}"; do
    if ! jar tf "$JAR_FILE" | grep -q "$class_file"; then
        echo "❌ FAIL: Required class/file missing: $class_file"
        exit 1
    fi
    echo "✅ Found: $class_file"
done

# Validate mods.toml content
echo "Validating mods.toml..."
jar xf "$JAR_FILE" META-INF/mods.toml
if grep -q 'modId="mcpanel"' META-INF/mods.toml; then
    echo "✅ mods.toml contains correct modId"
else
    echo "❌ FAIL: mods.toml missing or incorrect modId"
    exit 1
fi

# Check JAR size is reasonable (should be around 20KB)
JAR_SIZE=$(stat -f%z "$JAR_FILE" 2>/dev/null || stat -c%s "$JAR_FILE" 2>/dev/null)
if [ "$JAR_SIZE" -gt 50000 ]; then
    echo "⚠️  WARNING: JAR size is unusually large: $JAR_SIZE bytes (may contain unwanted dependencies)"
elif [ "$JAR_SIZE" -lt 10000 ]; then
    echo "⚠️  WARNING: JAR size is unusually small: $JAR_SIZE bytes (may be missing required classes)"
else
    echo "✅ JAR size is reasonable: $JAR_SIZE bytes"
fi

echo
echo "=== JAR Validation Test Results ==="
echo "✅ ALL TESTS PASSED"
echo "The JAR should now load without module export conflicts!"
echo "JAR Location: $JAR_FILE"
echo "JAR Size: $JAR_SIZE bytes"