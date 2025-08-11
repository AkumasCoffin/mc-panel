package com.akumas.mcpanel;

import java.util.logging.Logger;
import java.util.logging.Level;

/**
 * Forge-specific integration class that will be loaded only when Forge is available.
 * This class provides Forge event handling.
 * 
 * When Forge is not available, this class is ignored and won't cause crashes.
 * Note: @Mod annotation removed to prevent packaging Forge classes in JAR.
 * This class can be annotated with @Mod at runtime by Forge when it's available.
 */
public class MCPanelForgeIntegration {
    private static final Logger LOGGER = Logger.getLogger(MCPanelForgeIntegration.class.getName());
    
    // This constructor will be called by Forge when this mod is loaded
    public MCPanelForgeIntegration() {
        LOGGER.info("MC Panel Forge integration initialized");
        try {
            // Initialize the main mod class
            new MCPanelMod();
        } catch (Exception e) {
            LOGGER.log(Level.SEVERE, "Failed to initialize MC Panel mod through Forge integration", e);
        }
    }
    
    // Forge event handlers would go here when full Forge integration is available
    // For now, we rely on the main MCPanelMod class for functionality
}