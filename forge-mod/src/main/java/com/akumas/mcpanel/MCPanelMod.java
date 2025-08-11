package com.akumas.mcpanel;

import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.event.lifecycle.FMLCommonSetupEvent;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.event.server.ServerStoppingEvent;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import com.akumas.mcpanel.data.DataCollector;
import com.akumas.mcpanel.network.DataServer;

@Mod(MCPanelMod.MOD_ID)
public class MCPanelMod {
    public static final String MOD_ID = "mcpanel";
    private static final Logger LOGGER = LogManager.getLogger();
    
    private static DataCollector dataCollector;
    private static DataServer dataServer;
    
    public MCPanelMod() {
        IEventBus modEventBus = FMLJavaModLoadingContext.get().getModEventBus();
        modEventBus.addListener(this::commonSetup);
        
        MinecraftForge.EVENT_BUS.register(this);
        
        LOGGER.info("MC Panel Data Collector mod initialized");
    }
    
    private void commonSetup(final FMLCommonSetupEvent event) {
        LOGGER.info("MC Panel Data Collector common setup");
    }
    
    @SubscribeEvent
    public void onServerStarted(ServerStartedEvent event) {
        LOGGER.info("MC Panel Data Collector starting data collection...");
        
        try {
            dataCollector = new DataCollector(event.getServer());
            dataServer = new DataServer(dataCollector, 25580); // Default port
            dataServer.start();
            
            LOGGER.info("MC Panel Data Collector started successfully on port 25580");
        } catch (Exception e) {
            LOGGER.error("Failed to start MC Panel Data Collector", e);
        }
    }
    
    @SubscribeEvent
    public void onServerStopping(ServerStoppingEvent event) {
        LOGGER.info("MC Panel Data Collector stopping...");
        
        if (dataServer != null) {
            dataServer.stop();
        }
        
        LOGGER.info("MC Panel Data Collector stopped");
    }
    
    public static DataCollector getDataCollector() {
        return dataCollector;
    }
}