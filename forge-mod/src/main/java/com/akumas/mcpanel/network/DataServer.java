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
        data.addProperty("status", "basic_implementation");
        data.addProperty("message", "This is a basic implementation. Full Minecraft integration requires Forge dependencies.");
        return data;
    }
    
    class AllDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            try {
                if ("GET".equals(exchange.getRequestMethod())) {
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "all");
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
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "players");
                    data.addProperty("count", 0);
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
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "world");
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
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "performance");
                    
                    // Basic JVM performance data
                    Runtime runtime = Runtime.getRuntime();
                    data.addProperty("freeMemory", runtime.freeMemory());
                    data.addProperty("totalMemory", runtime.totalMemory());
                    data.addProperty("maxMemory", runtime.maxMemory());
                    
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
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "mods");
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
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "security");
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
                    JsonObject data = createBasicResponse();
                    data.addProperty("endpoint", "misc");
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
                    status.addProperty("version", "1.0.0-basic");
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