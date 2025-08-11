package com.akumas.mcpanel;

import com.akumas.mcpanel.network.DataServer;
import java.util.logging.Logger;
import java.util.logging.Level;

/**
 * MC Panel Data Collector Mod for Minecraft Forge
 * 
 * This mod provides server monitoring and data collection functionality
 * for the MC Panel web interface.
 * 
 * Note: The @Mod annotation is applied during compilation but the Forge classes
 * are excluded from the final JAR to prevent conflicts.
 */
// Forge annotation that gets added during compile time
@net.minecraftforge.fml.common.Mod("mcpanel")
public class MCPanelMod {
    public static final String MOD_ID = "mcpanel";
    private static final Logger LOGGER = Logger.getLogger(MCPanelMod.class.getName());
    private static DataServer dataServer;
    private static MCPanelMod instance;
    
    public MCPanelMod() {
        LOGGER.info("MC Panel Data Collector mod initializing...");
        instance = this;
        
        // Forge initialization would normally go here
        setup();
        
        LOGGER.info("MC Panel Data Collector mod initialized successfully");
    }
    
    private void setup() {
        // This method is called during mod setup
        LOGGER.info("MC Panel mod setup starting...");
        
        // Start the data server in a separate thread to avoid blocking mod loading
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
        
        LOGGER.info("MC Panel mod setup completed");
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
}