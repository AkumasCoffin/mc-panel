package com.akumas.mcpanel;

import java.util.logging.Logger;

// Simplified mod class for now - will be enhanced when Forge dependencies are available
public class MCPanelMod {
    public static final String MOD_ID = "mcpanel";
    private static final Logger LOGGER = Logger.getLogger(MCPanelMod.class.getName());
    
    // Will be enhanced with actual Forge integration when dependencies are available
    public MCPanelMod() {
        LOGGER.info("MC Panel Data Collector mod initialized (basic version)");
    }
}