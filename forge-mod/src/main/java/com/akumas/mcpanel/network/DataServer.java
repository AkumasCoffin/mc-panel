package com.akumas.mcpanel.network;

import com.akumas.mcpanel.data.DataCollector;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpExchange;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

public class DataServer {
    private static final Logger LOGGER = LogManager.getLogger();
    private final DataCollector dataCollector;
    private final int port;
    private HttpServer server;
    
    public DataServer(DataCollector dataCollector, int port) {
        this.dataCollector = dataCollector;
        this.port = port;
    }
    
    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress(port), 0);
        
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
        
        LOGGER.info("DataServer started on port {}", port);
    }
    
    public void stop() {
        if (server != null) {
            server.stop(0);
            LOGGER.info("DataServer stopped");
        }
    }
    
    private void sendJsonResponse(HttpExchange exchange, JsonObject data) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        exchange.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
        
        String response = data.toString();
        byte[] responseBytes = response.getBytes(StandardCharsets.UTF_8);
        
        exchange.sendResponseHeaders(200, responseBytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(responseBytes);
        }
    }
    
    private void sendErrorResponse(HttpExchange exchange, int code, String message) throws IOException {
        JsonObject error = new JsonObject();
        error.addProperty("error", true);
        error.addProperty("message", message);
        error.addProperty("code", code);
        
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        
        String response = error.toString();
        byte[] responseBytes = response.getBytes(StandardCharsets.UTF_8);
        
        exchange.sendResponseHeaders(code, responseBytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(responseBytes);
        }
    }
    
    private class AllDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("GET".equals(exchange.getRequestMethod())) {
                try {
                    JsonObject data = dataCollector.getAllData();
                    sendJsonResponse(exchange, data);
                } catch (Exception e) {
                    LOGGER.error("Error handling all data request", e);
                    sendErrorResponse(exchange, 500, "Internal server error");
                }
            } else {
                sendErrorResponse(exchange, 405, "Method not allowed");
            }
        }
    }
    
    private class PlayerDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("GET".equals(exchange.getRequestMethod())) {
                try {
                    JsonObject data = dataCollector.getPlayerData();
                    sendJsonResponse(exchange, data);
                } catch (Exception e) {
                    LOGGER.error("Error handling player data request", e);
                    sendErrorResponse(exchange, 500, "Internal server error");
                }
            } else {
                sendErrorResponse(exchange, 405, "Method not allowed");
            }
        }
    }
    
    private class WorldDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("GET".equals(exchange.getRequestMethod())) {
                try {
                    JsonObject data = dataCollector.getWorldData();
                    sendJsonResponse(exchange, data);
                } catch (Exception e) {
                    LOGGER.error("Error handling world data request", e);
                    sendErrorResponse(exchange, 500, "Internal server error");
                }
            } else {
                sendErrorResponse(exchange, 405, "Method not allowed");
            }
        }
    }
    
    private class PerformanceDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("GET".equals(exchange.getRequestMethod())) {
                try {
                    JsonObject data = dataCollector.getPerformanceData();
                    sendJsonResponse(exchange, data);
                } catch (Exception e) {
                    LOGGER.error("Error handling performance data request", e);
                    sendErrorResponse(exchange, 500, "Internal server error");
                }
            } else {
                sendErrorResponse(exchange, 405, "Method not allowed");
            }
        }
    }
    
    private class ModDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("GET".equals(exchange.getRequestMethod())) {
                try {
                    JsonObject data = dataCollector.getModData();
                    sendJsonResponse(exchange, data);
                } catch (Exception e) {
                    LOGGER.error("Error handling mod data request", e);
                    sendErrorResponse(exchange, 500, "Internal server error");
                }
            } else {
                sendErrorResponse(exchange, 405, "Method not allowed");
            }
        }
    }
    
    private class SecurityDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("GET".equals(exchange.getRequestMethod())) {
                try {
                    JsonObject data = dataCollector.getSecurityData();
                    sendJsonResponse(exchange, data);
                } catch (Exception e) {
                    LOGGER.error("Error handling security data request", e);
                    sendErrorResponse(exchange, 500, "Internal server error");
                }
            } else {
                sendErrorResponse(exchange, 405, "Method not allowed");
            }
        }
    }
    
    private class MiscDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("GET".equals(exchange.getRequestMethod())) {
                try {
                    JsonObject data = dataCollector.getMiscData();
                    sendJsonResponse(exchange, data);
                } catch (Exception e) {
                    LOGGER.error("Error handling misc data request", e);
                    sendErrorResponse(exchange, 500, "Internal server error");
                }
            } else {
                sendErrorResponse(exchange, 405, "Method not allowed");
            }
        }
    }
    
    private class StatusHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("GET".equals(exchange.getRequestMethod())) {
                try {
                    JsonObject status = new JsonObject();
                    status.addProperty("status", "ok");
                    status.addProperty("last_update", dataCollector.getLastUpdateTime());
                    status.addProperty("server_running", dataCollector.getServer().isRunning());
                    status.addProperty("mod_version", "1.0.0");
                    sendJsonResponse(exchange, status);
                } catch (Exception e) {
                    LOGGER.error("Error handling status request", e);
                    sendErrorResponse(exchange, 500, "Internal server error");
                }
            } else {
                sendErrorResponse(exchange, 405, "Method not allowed");
            }
        }
    }
}