package com.akumas.mcpanel.network;

import com.google.gson.JsonObject;
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
        
        // Set up endpoints
        server.createContext("/api/all", new AllDataHandler());
        server.createContext("/api/players", new PlayerDataHandler());
        server.createContext("/api/world", new WorldDataHandler());
        server.createContext("/api/performance", new PerformanceDataHandler());
        server.createContext("/api/mods", new ModDataHandler());
        server.createContext("/api/security", new SecurityDataHandler());
        server.createContext("/api/misc", new MiscDataHandler());
        server.createContext("/api/status", new StatusHandler());
        
        server.setExecutor(null); // Default executor
        server.start();
        
        LOGGER.info("DataServer started on port " + port);
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
                    status.addProperty("implementation", "MC Panel Live Data Collector");
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
                        if (performanceData.has("misc")) {
                            JsonObject misc = performanceData.getAsJsonObject("misc");
                            if (misc.has("resources")) {
                                JsonObject resources = misc.getAsJsonObject("resources");
                                status.addProperty("uptime_ms", resources.get("uptime_ms").getAsLong());
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
}