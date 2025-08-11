package com.akumas.mcpanel;

import com.akumas.mcpanel.network.DataServer;

/**
 * Test application to verify the HTTP server functionality
 */
public class TestApp {
    public static void main(String[] args) {
        try {
            System.out.println("Starting MC Panel Data Server (Test Mode)...");
            
            DataServer server = new DataServer(25580);
            server.start();
            
            System.out.println("Server started on port 25580");
            System.out.println("Test endpoints:");
            System.out.println("  http://localhost:25580/api/status");
            System.out.println("  http://localhost:25580/api/all");
            System.out.println("  http://localhost:25580/api/performance");
            System.out.println("Press Ctrl+C to stop the server");
            
            // Keep the application running
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                System.out.println("\nShutting down server...");
                server.stop();
                System.out.println("Server stopped");
            }));
            
            // Keep main thread alive
            while (true) {
                Thread.sleep(1000);
            }
            
        } catch (Exception e) {
            System.err.println("Error starting server: " + e.getMessage());
            e.printStackTrace();
        }
    }
}