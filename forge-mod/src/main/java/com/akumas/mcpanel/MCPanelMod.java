package com.akumas.mcpanel;

import com.akumas.mcpanel.network.DataServer;
import com.akumas.mcpanel.events.EventHandlers;
import com.akumas.mcpanel.events.ChatCommandRelay;
import com.akumas.mcpanel.events.ConsoleCapture;
import com.akumas.mcpanel.events.PlayerEventTracker;
import com.akumas.mcpanel.events.ServerEventTracker;

import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.event.server.ServerStoppingEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.event.lifecycle.FMLDedicatedServerSetupEvent;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.loading.FMLEnvironment;

import java.util.logging.Logger;
import java.util.logging.Level;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * MC Panel Data Collector Mod for Minecraft Forge
 * 
 * This mod provides comprehensive server monitoring and data collection functionality
 * for the MC Panel web interface, including real-time data updates, event tracking,
 * chat relay, console capture, and command execution.
 * 
 * Features:
 * - Real-time server status, TPS, memory, and performance monitoring
 * - Comprehensive player data including inventories, stats, locations, health
 * - World data with time, weather, chunks, entities, and properties
 * - Live console/log capture and command execution
 * - Chat message relay and web command interface
 * - Event tracking for deaths, achievements, and item/block interactions
 * 
 * This mod is SERVER-SIDE ONLY and does not need to be installed on clients.
 */
@Mod("mcpanel")
public class MCPanelMod {
    public static final String MOD_ID = "mcpanel";
    private static final Logger LOGGER = Logger.getLogger(MCPanelMod.class.getName());
    
    // Core components
    private static DataServer dataServer;
    private static MCPanelMod instance;
    private static ScheduledExecutorService scheduler;
    
    // Event handlers and data collectors
    private static EventHandlers eventHandlers;
    private static ChatCommandRelay chatRelay;
    private static ConsoleCapture consoleCapture;
    private static PlayerEventTracker playerTracker;
    private static ServerEventTracker serverTracker;
    
    // Configuration
    private static final int HTTP_PORT = 25580;
    private static final int DATA_UPDATE_INTERVAL_SECONDS = 5;
    
    public MCPanelMod() {
        // Only initialize on server side
        if (FMLEnvironment.dist != Dist.DEDICATED_SERVER) {
            LOGGER.info("MC Panel mod is server-side only. Not initializing on client.");
            return;
        }
        
        LOGGER.info("MC Panel Data Collector mod initializing on server...");
        instance = this;
        
        try {
            initializeComponents();
            
            // Register this mod instance to receive Forge events
            MinecraftForge.EVENT_BUS.register(this);
            
            LOGGER.info("MC Panel Data Collector mod initialized successfully");
        } catch (Exception e) {
            LOGGER.log(Level.SEVERE, "Failed to initialize MC Panel mod", e);
            throw new RuntimeException("MC Panel mod initialization failed", e);
        }
    }
    
    private void initializeComponents() {
        LOGGER.info("Initializing MC Panel components...");
        
        // Initialize scheduler for data updates
        scheduler = Executors.newScheduledThreadPool(2);
        
        // Initialize event handlers
        eventHandlers = new EventHandlers();
        chatRelay = new ChatCommandRelay();
        consoleCapture = new ConsoleCapture();
        playerTracker = new PlayerEventTracker();
        serverTracker = new ServerEventTracker();
        
        // Register shutdown hook
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOGGER.info("Shutting down MC Panel data collector...");
            shutdown();
        }));
        
        LOGGER.info("MC Panel components initialized");
    }
    
    @SubscribeEvent
    public void onServerSetup(FMLDedicatedServerSetupEvent event) {
        LOGGER.info("MC Panel mod setup starting...");
        
        // Register event handlers with Forge
        registerEventHandlers();
        
        // Start console capture
        startConsoleCapture();
        
        LOGGER.info("MC Panel mod setup completed");
    }
    
    @SubscribeEvent
    public void onServerStarted(ServerStartedEvent event) {
        LOGGER.info("Server started, initializing MC Panel data server...");
        
        // Start the data server after the server is fully started
        startDataServer();
        startDataUpdateScheduler();
    }
    
    @SubscribeEvent
    public void onServerStopping(ServerStoppingEvent event) {
        LOGGER.info("Server stopping, shutting down MC Panel...");
        shutdown();
    }
    
    private void registerEventHandlers() {
        try {
            LOGGER.info("Registering event handlers...");
            
            // Register Forge event handlers
            MinecraftForge.EVENT_BUS.register(eventHandlers);
            MinecraftForge.EVENT_BUS.register(chatRelay);
            MinecraftForge.EVENT_BUS.register(playerTracker);
            MinecraftForge.EVENT_BUS.register(serverTracker);
            
            LOGGER.info("Event handlers registered successfully");
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Could not register all event handlers", e);
        }
    }
    
    private void startConsoleCapture() {
        try {
            LOGGER.info("Starting console capture...");
            consoleCapture.start();
            LOGGER.info("Console capture started");
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to start console capture", e);
        }
    }
    
    private void startDataUpdateScheduler() {
        try {
            LOGGER.info("Starting data update scheduler...");
            
            // Schedule regular data updates every 5 seconds
            scheduler.scheduleAtFixedRate(() -> {
                try {
                    // Trigger data collection updates
                    updateCachedData();
                } catch (Exception e) {
                    LOGGER.log(Level.WARNING, "Error during scheduled data update", e);
                }
            }, DATA_UPDATE_INTERVAL_SECONDS, DATA_UPDATE_INTERVAL_SECONDS, TimeUnit.SECONDS);
            
            LOGGER.info("Data update scheduler started (interval: " + DATA_UPDATE_INTERVAL_SECONDS + "s)");
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to start data update scheduler", e);
        }
    }
    
    private void updateCachedData() {
        // Force cache refresh for all data collectors
        // This will be called every 5 seconds to ensure fresh data
        try {
            eventHandlers.refreshData();
            playerTracker.refreshData();
            serverTracker.refreshData();
        } catch (Exception e) {
            LOGGER.log(Level.FINE, "Minor error refreshing cached data", e);
        }
    }
    
    public static void startDataServer() {
        try {
            if (dataServer == null) {
                dataServer = new DataServer(HTTP_PORT);
                dataServer.start();
                LOGGER.info("MC Panel data server started on port " + HTTP_PORT);
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
    
    public static void shutdown() {
        try {
            // Stop data server
            stopDataServer();
            
            // Stop console capture
            if (consoleCapture != null) {
                consoleCapture.stop();
            }
            
            // Shutdown scheduler
            if (scheduler != null && !scheduler.isShutdown()) {
                scheduler.shutdown();
                try {
                    if (!scheduler.awaitTermination(5, TimeUnit.SECONDS)) {
                        scheduler.shutdownNow();
                    }
                } catch (InterruptedException e) {
                    scheduler.shutdownNow();
                    Thread.currentThread().interrupt();
                }
            }
            
            LOGGER.info("MC Panel mod shutdown completed");
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error during shutdown", e);
        }
    }
    
    // Getters for components
    public static MCPanelMod getInstance() {
        return instance;
    }
    
    public static DataServer getDataServer() {
        return dataServer;
    }
    
    public static EventHandlers getEventHandlers() {
        return eventHandlers;
    }
    
    public static ChatCommandRelay getChatRelay() {
        return chatRelay;
    }
    
    public static ConsoleCapture getConsoleCapture() {
        return consoleCapture;
    }
    
    public static PlayerEventTracker getPlayerTracker() {
        return playerTracker;
    }
    
    public static ServerEventTracker getServerTracker() {
        return serverTracker;
    }
}