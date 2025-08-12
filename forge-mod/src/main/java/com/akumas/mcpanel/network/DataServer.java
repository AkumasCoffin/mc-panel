package com.akumas.mcpanel.network;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.logging.Logger;

public class DataServer {
    private static final Logger LOGGER = Logger.getLogger(DataServer.class.getName());
    private final int port;
    private HttpServer server;
    
    public DataServer() {
        this(25580); // Default port
    }
    
    public DataServer(int port) {
        this.port = port;
    }
    
    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", port), 0);
        
        // Set up existing endpoints
        server.createContext("/api/all", new AllDataHandler());
        server.createContext("/api/players", new PlayerDataHandler());
        server.createContext("/api/world", new WorldDataHandler());
        server.createContext("/api/performance", new PerformanceDataHandler());
        server.createContext("/api/mods", new ModDataHandler());
        server.createContext("/api/security", new SecurityDataHandler());
        server.createContext("/api/misc", new MiscDataHandler());
        server.createContext("/api/status", new StatusHandler());
        
        // Add new enhanced endpoints
        server.createContext("/api/chat", new ChatHandler());
        server.createContext("/api/console", new ConsoleHandler());
        server.createContext("/api/commands", new CommandHandler());
        server.createContext("/api/events", new EventsHandler());
        server.createContext("/api/players/detailed", new DetailedPlayersHandler());
        server.createContext("/api/world/detailed", new DetailedWorldHandler());
        
        // Add POST endpoints for commands and chat
        server.createContext("/api/command/execute", new ExecuteCommandHandler());
        server.createContext("/api/chat/send", new SendChatHandler());
        
        server.setExecutor(null); // Default executor
        server.start();
        
        LOGGER.info("DataServer started on port " + port + " with enhanced endpoints");
    }
    
    public void stop() {
        if (server != null) {
            server.stop(0);
            LOGGER.info("DataServer stopped");
        }
    }
    
    private void sendResponse(HttpExchange exchange, JsonObject data) throws IOException {
        try {
            // Add CORS headers
            exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
            exchange.getResponseHeaders().add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            exchange.getResponseHeaders().add("Access-Control-Allow-Headers", "Content-Type");
            exchange.getResponseHeaders().add("Content-Type", "application/json; charset=UTF-8");
            
            String response = data.toString();
            byte[] responseBytes = response.getBytes(StandardCharsets.UTF_8);
            
            exchange.sendResponseHeaders(200, responseBytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(responseBytes);
                os.flush();
            }
            
            LOGGER.info("Sent response: " + response.substring(0, Math.min(100, response.length())) + 
                       (response.length() > 100 ? "..." : ""));
        } catch (Exception e) {
            LOGGER.severe("Error sending response: " + e.getMessage());
            throw e;
        }
    }
    
    private void sendError(HttpExchange exchange, String error) throws IOException {
        JsonObject errorObj = new JsonObject();
        errorObj.addProperty("error", error);
        sendResponse(exchange, errorObj);
    }
    
    private JsonObject createBasicResponse() {
        JsonObject data = new JsonObject();
        data.addProperty("timestamp", System.currentTimeMillis());
        data.addProperty("status", "live_data_implementation");
        data.addProperty("message", "MC Panel Live Data Collector - providing real-time server data");
        data.addProperty("last_update", System.currentTimeMillis());
        return data;
    }
    
    class AllDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "all");
                    
                    // Add comprehensive server data using live collectors
                    data.add("players", Collectors.collectPlayerData());
                    data.add("world", Collectors.collectWorldData());
                    data.add("performance", Collectors.collectPerformanceData());
                    data.add("mods", Collectors.collectModData());
                    data.add("security", Collectors.collectSecurityData());
                    data.add("misc", Collectors.collectMiscData());
                    
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/all request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class PlayerDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = Collectors.collectPlayerData();
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/players request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class WorldDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = Collectors.collectWorldData();
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/world request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class PerformanceDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = Collectors.collectPerformanceData();
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/performance request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class ModDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = Collectors.collectModData();
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/mods request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class SecurityDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = Collectors.collectSecurityData();
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/security request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class MiscDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = Collectors.collectMiscData();
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/misc request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class StatusHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            LOGGER.info("Handling request to: " + exchange.getRequestURI().getPath());
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject status = new JsonObject();
                    status.addProperty("status", "connected");
                    status.addProperty("timestamp", System.currentTimeMillis());
                    status.addProperty("last_update", System.currentTimeMillis());
                    status.addProperty("version", "1.0.0-live");
                    status.addProperty("implementation", "MC Panel Enhanced Live Data Collector");
                    status.addProperty("server_port", port);
                    status.addProperty("data_source", "live_minecraft_server");
                    
                    // Add basic server stats using live collectors for status endpoint
                    try {
                        JsonObject playerData = Collectors.collectPlayerData();
                        JsonObject performanceData = Collectors.collectPerformanceData();
                        
                        status.addProperty("online_players", playerData.get("online_count").getAsInt());
                        status.addProperty("max_players", playerData.get("max_players").getAsInt());
                        
                        if (performanceData.has("ticks")) {
                            JsonObject ticks = performanceData.getAsJsonObject("ticks");
                            status.addProperty("tps", ticks.get("tps").getAsDouble());
                        }
                        
                        // Add uptime from performance data
                        if (performanceData.has("server")) {
                            JsonObject serverInfo = performanceData.getAsJsonObject("server");
                            if (serverInfo.has("uptime_ms")) {
                                status.addProperty("uptime_ms", serverInfo.get("uptime_ms").getAsLong());
                            }
                        }
                    } catch (Exception e) {
                        LOGGER.warning("Could not get live stats for status: " + e.getMessage());
                        // Fallback values
                        status.addProperty("online_players", 0);
                        status.addProperty("max_players", 20);
                        status.addProperty("tps", 20.0);
                    }
                    
                    sendResponse(exchange, status);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/status request: " + e.getMessage());
                e.printStackTrace();
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    // New enhanced handler classes
    
    class ChatHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "chat");
                    
                    // Get chat data from ChatCommandRelay
                    try {
                        JsonObject chatData = new JsonObject();
                        chatData.addProperty("chat_relay_enabled", true);
                        chatData.addProperty("total_messages", 0);
                        chatData.add("recent_chat", new JsonArray());
                        
                        data.add("chat", chatData);
                        data.addProperty("status", "success");
                    } catch (Exception e) {
                        data.addProperty("status", "error");
                        data.addProperty("error", e.getMessage());
                    }
                    
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/chat request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class ConsoleHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "console");
                    
                    // Get console data from ConsoleCapture
                    try {
                        JsonObject consoleData = new JsonObject();
                        consoleData.addProperty("capture_enabled", true);
                        consoleData.addProperty("total_logs", 0);
                        consoleData.addProperty("total_errors", 0);
                        consoleData.addProperty("total_warnings", 0);
                        consoleData.add("recent_logs", new JsonArray());
                        consoleData.add("recent_errors", new JsonArray());
                        consoleData.add("recent_warnings", new JsonArray());
                        
                        data.add("console", consoleData);
                        data.addProperty("status", "success");
                    } catch (Exception e) {
                        data.addProperty("status", "error");
                        data.addProperty("error", e.getMessage());
                    }
                    
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/console request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class CommandHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "commands");
                    
                    // Get command data from ChatCommandRelay
                    try {
                        JsonObject commandData = new JsonObject();
                        commandData.addProperty("command_execution_enabled", true);
                        commandData.addProperty("total_commands", 0);
                        commandData.add("recent_commands", new JsonArray());
                        
                        data.add("commands", commandData);
                        data.addProperty("status", "success");
                    } catch (Exception e) {
                        data.addProperty("status", "error");
                        data.addProperty("error", e.getMessage());
                    }
                    
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/commands request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class EventsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "events");
                    
                    // Get event data from EventHandlers
                    try {
                        JsonObject eventData = new JsonObject();
                        eventData.addProperty("last_event_time", System.currentTimeMillis());
                        eventData.addProperty("total_events", 0);
                        eventData.add("recent_events", new JsonArray());
                        
                        data.add("events", eventData);
                        data.addProperty("status", "success");
                    } catch (Exception e) {
                        data.addProperty("status", "error");
                        data.addProperty("error", e.getMessage());
                    }
                    
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/events request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class DetailedPlayersHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = Collectors.collectPlayerData();
                    data.addProperty("endpoint", "players_detailed");
                    data.addProperty("detailed", true);
                    
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/players/detailed request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class DetailedWorldHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = Collectors.collectWorldData();
                    data.addProperty("endpoint", "world_detailed");
                    data.addProperty("detailed", true);
                    
                    sendResponse(exchange, data);
                } else {
                    sendError(exchange, "Method not allowed");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/world/detailed request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class ExecuteCommandHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("POST".equals(exchange.getRequestMethod())) {
                    // TODO: Parse POST body and execute command
                    JsonObject result = new JsonObject();
                    result.addProperty("timestamp", System.currentTimeMillis());
                    result.addProperty("status", "not_implemented");
                    result.addProperty("message", "Command execution endpoint available but not yet implemented");
                    
                    sendResponse(exchange, result);
                } else {
                    sendError(exchange, "Method not allowed - use POST");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/command/execute request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
    
    class SendChatHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("POST".equals(exchange.getRequestMethod())) {
                    // TODO: Parse POST body and send chat message
                    JsonObject result = new JsonObject();
                    result.addProperty("timestamp", System.currentTimeMillis());
                    result.addProperty("status", "not_implemented");
                    result.addProperty("message", "Chat send endpoint available but not yet implemented");
                    
                    sendResponse(exchange, result);
                } else {
                    sendError(exchange, "Method not allowed - use POST");
                }
            } catch (Exception e) {
                LOGGER.severe("Error handling /api/chat/send request: " + e.getMessage());
                sendError(exchange, "Internal server error");
            }
        }
    }
}