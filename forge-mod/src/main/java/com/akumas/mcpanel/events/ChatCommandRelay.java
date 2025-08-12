package com.akumas.mcpanel.events;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.logging.Logger;
import java.util.logging.Level;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Handles chat message relay and command execution between the web interface and Minecraft server.
 * Provides real-time chat monitoring and web-based command execution capabilities.
 */
public class ChatCommandRelay {
    private static final Logger LOGGER = Logger.getLogger(ChatCommandRelay.class.getName());
    
    // Chat message storage
    private final ConcurrentLinkedQueue<JsonObject> chatHistory = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<JsonObject> pendingCommands = new ConcurrentLinkedQueue<>();
    private final Map<String, JsonObject> commandResults = new ConcurrentHashMap<>();
    
    private static final int MAX_CHAT_HISTORY = 500;
    private static final int MAX_COMMAND_RESULTS = 100;
    
    // Configuration
    private volatile boolean chatRelayEnabled = true;
    private volatile boolean commandExecutionEnabled = true;
    
    public ChatCommandRelay() {
        LOGGER.info("ChatCommandRelay initialized");
    }
    
    /**
     * Handles incoming chat messages from players
     * TODO: Add @SubscribeEvent annotation when Forge APIs are available
     */
    // @SubscribeEvent
    public void onChatMessage(Object event) {
        try {
            if (!chatRelayEnabled) {
                return;
            }
            
            // TODO: Extract chat data when ServerChatEvent is available
            // ServerChatEvent chatEvent = (ServerChatEvent) event;
            // ServerPlayer player = chatEvent.getPlayer();
            // String message = chatEvent.getMessage().getString();
            
            JsonObject chatData = new JsonObject();
            chatData.addProperty("type", "chat");
            chatData.addProperty("timestamp", System.currentTimeMillis());
            // chatData.addProperty("player_name", player.getName().getString());
            // chatData.addProperty("player_uuid", player.getUUID().toString());
            // chatData.addProperty("message", message);
            // chatData.addProperty("display_name", player.getDisplayName().getString());
            
            // For now, create a placeholder entry
            chatData.addProperty("player_name", "TestPlayer");
            chatData.addProperty("player_uuid", UUID.randomUUID().toString());
            chatData.addProperty("message", "Test chat message");
            chatData.addProperty("display_name", "TestPlayer");
            
            addChatMessage(chatData);
            
            LOGGER.info("Chat message captured and relayed");
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error handling chat message", e);
        }
    }
    
    /**
     * Handles system messages (server announcements, etc.)
     */
    public void onSystemMessage(String message, String source) {
        try {
            if (!chatRelayEnabled) {
                return;
            }
            
            JsonObject chatData = new JsonObject();
            chatData.addProperty("type", "system");
            chatData.addProperty("timestamp", System.currentTimeMillis());
            chatData.addProperty("message", message);
            chatData.addProperty("source", source);
            chatData.addProperty("player_name", "[Server]");
            chatData.addProperty("display_name", "[Server]");
            
            addChatMessage(chatData);
            
            LOGGER.info("System message captured: " + message);
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error handling system message", e);
        }
    }
    
    /**
     * Executes a command from the web interface
     */
    public JsonObject executeCommand(String command, String executor, String executorType) {
        JsonObject result = new JsonObject();
        result.addProperty("timestamp", System.currentTimeMillis());
        result.addProperty("command", command);
        result.addProperty("executor", executor);
        result.addProperty("executor_type", executorType);
        
        try {
            if (!commandExecutionEnabled) {
                result.addProperty("status", "disabled");
                result.addProperty("message", "Command execution is disabled");
                return result;
            }
            
            // Generate command ID for tracking
            String commandId = UUID.randomUUID().toString();
            result.addProperty("command_id", commandId);
            
            // TODO: Execute command when Minecraft server APIs are available
            // MinecraftServer server = ServerLifecycleHooks.getCurrentServer();
            // if (server != null) {
            //     Commands commands = server.getCommands();
            //     CommandSourceStack source = server.createCommandSourceStack();
            //     
            //     // Execute the command
            //     int resultCode = commands.performPrefixedCommand(source, command);
            //     
            //     result.addProperty("status", "success");
            //     result.addProperty("result_code", resultCode);
            //     result.addProperty("message", "Command executed successfully");
            // }
            
            // For now, simulate command execution
            result.addProperty("status", "simulated");
            result.addProperty("result_code", 1);
            result.addProperty("message", "Command would be executed: " + command);
            result.addProperty("output", "Simulated command output");
            
            // Store result for retrieval
            commandResults.put(commandId, result);
            
            // Clean up old results
            if (commandResults.size() > MAX_COMMAND_RESULTS) {
                String oldestKey = commandResults.keySet().iterator().next();
                commandResults.remove(oldestKey);
            }
            
            // Add to chat as a system message
            onSystemMessage("Command executed: " + command, "WebInterface");
            
            LOGGER.info("Command executed from web interface: " + command);
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error executing command: " + command, e);
            result.addProperty("status", "error");
            result.addProperty("message", "Command execution failed: " + e.getMessage());
        }
        
        return result;
    }
    
    /**
     * Sends a chat message from the web interface
     */
    public JsonObject sendChatMessage(String message, String sender) {
        JsonObject result = new JsonObject();
        result.addProperty("timestamp", System.currentTimeMillis());
        result.addProperty("message", message);
        result.addProperty("sender", sender);
        
        try {
            // TODO: Send chat message when Minecraft server APIs are available
            // MinecraftServer server = ServerLifecycleHooks.getCurrentServer();
            // if (server != null) {
            //     Component chatComponent = Component.literal("<" + sender + "> " + message);
            //     server.getPlayerList().broadcastSystemMessage(chatComponent, false);
            //     
            //     result.addProperty("status", "success");
            //     result.addProperty("message_sent", "Chat message broadcasted");
            // }
            
            // For now, simulate sending
            result.addProperty("status", "simulated");
            result.addProperty("message_sent", "Chat message would be sent: " + message);
            
            // Add to chat history
            JsonObject chatData = new JsonObject();
            chatData.addProperty("type", "web_message");
            chatData.addProperty("timestamp", System.currentTimeMillis());
            chatData.addProperty("player_name", "[Web] " + sender);
            chatData.addProperty("display_name", "[Web] " + sender);
            chatData.addProperty("message", message);
            
            addChatMessage(chatData);
            
            LOGGER.info("Chat message sent from web interface: " + message);
            
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Error sending chat message", e);
            result.addProperty("status", "error");
            result.addProperty("message_sent", "Failed to send message: " + e.getMessage());
        }
        
        return result;
    }
    
    /**
     * Get chat history for API responses
     */
    public JsonArray getChatHistory(int limit) {
        JsonArray history = new JsonArray();
        int count = 0;
        
        // Get the most recent messages
        Object[] messages = chatHistory.toArray();
        for (int i = messages.length - 1; i >= 0 && count < limit; i--) {
            history.add((JsonObject) messages[i]);
            count++;
        }
        
        return history;
    }
    
    /**
     * Get all chat history
     */
    public JsonArray getChatHistory() {
        return getChatHistory(MAX_CHAT_HISTORY);
    }
    
    /**
     * Get command execution result by ID
     */
    public JsonObject getCommandResult(String commandId) {
        return commandResults.get(commandId);
    }
    
    /**
     * Get all recent command results
     */
    public JsonArray getCommandResults() {
        JsonArray results = new JsonArray();
        for (JsonObject result : commandResults.values()) {
            results.add(result);
        }
        return results;
    }
    
    /**
     * Add a chat message to the history
     */
    private void addChatMessage(JsonObject chatMessage) {
        chatHistory.offer(chatMessage);
        
        // Keep only the most recent messages
        while (chatHistory.size() > MAX_CHAT_HISTORY) {
            chatHistory.poll();
        }
    }
    
    /**
     * Enable or disable chat relay
     */
    public void setChatRelayEnabled(boolean enabled) {
        this.chatRelayEnabled = enabled;
        LOGGER.info("Chat relay " + (enabled ? "enabled" : "disabled"));
    }
    
    /**
     * Enable or disable command execution
     */
    public void setCommandExecutionEnabled(boolean enabled) {
        this.commandExecutionEnabled = enabled;
        LOGGER.info("Command execution " + (enabled ? "enabled" : "disabled"));
    }
    
    /**
     * Get comprehensive chat and command data for API responses
     */
    public JsonObject getChatData() {
        JsonObject data = new JsonObject();
        data.addProperty("timestamp", System.currentTimeMillis());
        data.addProperty("chat_relay_enabled", chatRelayEnabled);
        data.addProperty("command_execution_enabled", commandExecutionEnabled);
        data.addProperty("total_messages", chatHistory.size());
        data.addProperty("total_commands", commandResults.size());
        data.add("recent_chat", getChatHistory(50)); // Last 50 messages
        data.add("recent_commands", getCommandResults());
        return data;
    }
    
    /**
     * Clear chat history (admin function)
     */
    public void clearChatHistory() {
        chatHistory.clear();
        LOGGER.info("Chat history cleared");
    }
    
    /**
     * Clear command results (admin function)
     */
    public void clearCommandResults() {
        commandResults.clear();
        LOGGER.info("Command results cleared");
    }
}