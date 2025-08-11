package com.akumas.mcpanel;

import com.akumas.mcpanel.network.DataServer;
import java.util.logging.Logger;
import java.util.logging.Level;

/**
 * MC Panel Data Collector Mod - Crash-Safe Implementation
 * 
 * This mod is designed to work with or without full Forge integration.
 * It provides a safe fallback mechanism that prevents server crashes
 * while still offering basic functionality.
 */
public class MCPanelMod {
    public static final String MOD_ID = "mcpanel";
    private static final Logger LOGGER = Logger.getLogger(MCPanelMod.class.getName());
    private static DataServer dataServer;
    private static boolean forgeAvailable = false;
    private static MCPanelMod instance;
    
    // Static initializer for crash-safe initialization
    static {
        try {
            // Check if Forge classes are available
            Class.forName("net.minecraftforge.fml.common.Mod");
            forgeAvailable = true;
            LOGGER.info("Forge classes detected - enabling full integration");
        } catch (ClassNotFoundException e) {
            forgeAvailable = false;
            LOGGER.info("Forge classes not available - using standalone mode");
        }
    }
    
    public MCPanelMod() {
        LOGGER.info("MC Panel Data Collector mod initializing...");
        instance = this;
        
        try {
            if (forgeAvailable) {
                initializeForgeIntegration();
            } else {
                initializeStandaloneMode();
            }
            
            LOGGER.info("MC Panel Data Collector mod initialized successfully");
        } catch (Exception e) {
            LOGGER.log(Level.SEVERE, "Failed to initialize MC Panel mod", e);
            // Don't throw the exception - just log it to prevent server crash
        }
    }
    
    private void initializeForgeIntegration() {
        try {
            // Only attempt Forge integration if classes are available
            // This would contain the Forge-specific code
            LOGGER.info("Attempting Forge integration...");
            
            // For now, just start in standalone mode even with Forge available
            // This ensures compatibility until full Forge dependencies are resolved
            initializeStandaloneMode();
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Forge integration failed, falling back to standalone mode", e);
            initializeStandaloneMode();
        }
    }
    
    private void initializeStandaloneMode() {
        LOGGER.info("Initializing MC Panel in standalone mode");
        
        // Start the data server in a separate thread to avoid blocking
        Thread serverThread = new Thread(() -> {
            try {
                Thread.sleep(5000); // Wait 5 seconds for server to fully start
                startDataServer();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                LOGGER.log(Level.WARNING, "Server startup thread interrupted", e);
            }
        });
        serverThread.setDaemon(true);
        serverThread.setName("MCPanel-Startup");
        serverThread.start();
        
        // Register shutdown hook
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOGGER.info("Shutting down MC Panel data collector...");
            stopDataServer();
        }));
    }
    
    public static void startDataServer() {
        try {
            if (dataServer == null) {
                dataServer = new DataServer();
                dataServer.start();
                LOGGER.info("MC Panel data server started on port 25580");
            }
        } catch (Exception e) {
            LOGGER.log(Level.SEVERE, "Failed to start MC Panel data server", e);
        }
    }
    
    public static void stopDataServer() {
        if (dataServer != null) {
            try {
                dataServer.stop();
                LOGGER.info("MC Panel data server stopped");
            } catch (Exception e) {
                LOGGER.log(Level.WARNING, "Error stopping MC Panel data server", e);
            }
            dataServer = null;
        }
    }
    
    public static MCPanelMod getInstance() {
        return instance;
    }
    
    public static boolean isForgeAvailable() {
        return forgeAvailable;
    }
    
    // Test method for standalone execution
    public static void main(String[] args) {
        LOGGER.info("Testing MC Panel mod initialization...");
        MCPanelMod mod = new MCPanelMod();
        
        // Keep the test running for a few seconds to verify the server starts
        try {
            Thread.sleep(10000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        
        LOGGER.info("Test completed - shutting down");
        stopDataServer();
    }
}